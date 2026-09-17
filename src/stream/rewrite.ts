import { Transform } from 'node:stream';

/**
 * Bytes of a file, restated as they pass.
 *
 * A segment of a cue image is the image's own bytes with its frames' headers
 * said differently: each frame states the number it had in the record, and a
 * segment has to state its own. Restating a header is not a local edit, though.
 * A frame ends with a CRC-16 that covers the whole frame **including its
 * header** (RFC 9639 section 9.3), so a frame whose header was rewritten and
 * whose footer was left alone is a frame no parser will take: every parser that
 * walks a stream by searching for headers weighs each candidate by the footer of
 * the frame in front of it, and one that fails is dropped — with the audio it
 * held. That is why the footer is computed again here, over the frame as it goes
 * out, and why the two edits are one pass.
 *
 * The CRC is carried over the bytes as they are written, never over a frame held
 * in hand, so a segment of a three-hundred-megabyte image streams with no more
 * memory than a chunk. `base` is the file offset the stream begins at, since the
 * frames are the walk's own offsets and the bytes arriving are a slice of the
 * file that starts somewhere else.
 */
export interface Rewrite {
  /** Where the span starts, as an offset into the file. */
  at: number;
  /** Bytes of the file it replaces. */
  length: number;
  /** What takes their place, in as many bytes as it needs. */
  bytes: Buffer;
}

/** A frame whose header is restated, and whose footer therefore has to be too. */
export interface Reframe {
  /** The frame's header, and what it becomes. */
  header: Rewrite;
  /** The frame's first byte in the file, and the first byte after it. */
  from: number;
  to: number;
}

/** CRC-16 as section 9.3 defines it: `x^16 + x^15 + x^2 + 1`, no reflection. */
const CRC_TABLE = ((): Uint16Array => {
  const table = new Uint16Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
    table[index] = crc;
  }
  return table;
})();

/** The CRC-16 of `bytes[from, to)`, carried on from `crc`. */
function crc16(crc: number, bytes: Buffer, from = 0, to = bytes.length): number {
  let running = crc;
  for (let at = from; at < to; at += 1) {
    running = (((running << 8) & 0xffff) ^ (CRC_TABLE[((running >> 8) ^ (bytes[at] as number)) & 0xff] as number)) & 0xffff;
  }
  return running;
}

/** Two bytes of CRC-16, most significant first, as a frame ends with them. */
function footer(crc: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(crc);
  return bytes;
}

/** What a set of reframed frames adds to, or takes from, the range they sit in. */
export function restatedSize(frames: Reframe[]): number {
  return frames.reduce((total, frame) => total + frame.header.bytes.length - frame.header.length, 0);
}

/**
 * Which part of the segment goes out.
 *
 * A client that seeks asks for a byte range of the *answer*, and the answer is
 * built rather than copied, so the range cannot be answered by seeking the file.
 * It is answered by building the same stream and passing over the bytes before
 * the offset — the writing stops after the last one. `skip` counts the bytes to
 * pass over once the prefix is behind us, and `limit` how many to write.
 *
 * **What this costs is the read, not the CRC, and it is more than it looks.**
 * The bytes in front are produced only to be dropped — the frames are in memory
 * but the file still has to be walked to find them — so a seek costs a share of
 * the track's own length: measured on a 46.36 MB cue track of a 523 MB image,
 * asking for a 1.16 MB range at offset 45.2 MB took **143–279 ms**, because the
 * forty-five megabytes ahead of it are read either way. The comment here used to
 * say "about a tenth of a second for a whole track", which is the cost of a
 * whole track and not of a seek into one (task:2864).
 *
 * Nothing of that is the client's: it gets the bytes it asked for instead of the
 * track from its beginning again.
 */
export interface Window {
  skip: number;
  limit: number;
}

/**
 * A stream that writes what it is given, restating the frames it names.
 *
 * Each named frame comes out as its new header, its body unchanged, and a footer
 * computed over the two. Bytes outside those frames are passed through as the
 * file holds them — the frames of a track that needed no restating keep the
 * footers they came with.
 *
 * The frames must be in order and each must be ahead of the stream when it
 * arrives. One that has already been passed is refused rather than skipped: it
 * would mean the walk and the stream disagree about where the audio is, and the
 * bytes that followed would be served as a track numbered from the wrong place.
 */
export function restating(frames: Reframe[], base: number, window?: Window): Transform {
  /** The next frame to restate, and where in the file the input has arrived. */
  let next = 0;
  let at = base;
  /** Bytes of the file still to drop: the header that was, or the footer that was. */
  let dropping = 0;
  /** Bytes of the frame being written still to come, its footer included. */
  let left = 0;
  /** The CRC-16 of that frame over everything written of it so far. */
  let crc = 0;

  // What the window still asks for: bytes to pass over before writing, and how
  // many are left to write. The CRC is carried over the bytes passed over too —
  // a frame's footer covers the whole frame, so the part of it a seek landed in
  // the middle of still has to be counted.
  let skip = window?.skip ?? 0;
  let limit = window?.limit ?? Number.POSITIVE_INFINITY;
  let finished = false;

  return new Transform({
    transform(chunk: Buffer, _encoding, done): void {
      if (finished) {
        done();
        return;
      }

      const out: Buffer[] = [];
      let cursor = 0;

      /** Write `bytes`, less whatever the window still wants passed over. */
      const write = (bytes: Buffer): void => {
        if (finished || bytes.length === 0) return;

        let piece = bytes;
        if (skip > 0) {
          const passed = Math.min(skip, piece.length);
          skip -= passed;
          piece = piece.subarray(passed);
          if (piece.length === 0) return;
        }

        if (piece.length >= limit) {
          out.push(piece.subarray(0, limit));
          limit = 0;
          finished = true;
          return;
        }
        out.push(piece);
        limit -= piece.length;
      };

      while (cursor < chunk.length) {
        if (dropping > 0) {
          const dropped = Math.min(dropping, chunk.length - cursor);
          cursor += dropped;
          dropping -= dropped;
          at += dropped;
          continue;
        }

        // Inside a frame: its body, and then the two bytes that end it.
        if (left > 0) {
          if (left > 2) {
            const until = Math.min(chunk.length, cursor + left - 2);
            // The CRC is only worth taking for a frame that goes out. One that
            // ends before the window opens is passed over whole, and a footer
            // nobody will read is a byte-at-a-time cost on a seek: this is what
            // keeps a range near the end of a long track from walking the whole
            // of it through the polynomial.
            if (skip < left) crc = crc16(crc, chunk, cursor, until);
            write(chunk.subarray(cursor, until));
            left -= until - cursor;
            at += until - cursor;
            cursor = until;
            if (finished) break;
            continue;
          }
          write(footer(crc));
          dropping = 2;
          left = 0;
          crc = 0;
          if (finished) break;
          continue;
        }

        const frame = next < frames.length ? (frames[next] as Reframe) : undefined;

        if (frame === undefined) {
          write(chunk.subarray(cursor));
          at += chunk.length - cursor;
          cursor = chunk.length;
          continue;
        }

        if (frame.header.at < at) {
          done(new Error(`a frame at ${frame.header.at} was passed at position ${at}`));
          return;
        }

        // Not there yet: bytes outside a restated frame go out as they are.
        if (frame.header.at > at) {
          const until = Math.min(chunk.length, cursor + frame.header.at - at);
          write(chunk.subarray(cursor, until));
          at += until - cursor;
          cursor = until;
          if (finished) break;
          continue;
        }

        write(frame.header.bytes);
        crc = crc16(0, frame.header.bytes);
        dropping = frame.header.length;
        left = frame.to - frame.from - frame.header.length;
        next += 1;
        if (finished) break;
      }

      done(null, out.length === 0 ? undefined : out.length === 1 ? (out[0] as Buffer) : Buffer.concat(out));

      // Nothing more will be written, so the answer ends here rather than at the
      // end of the file: a seek near the end of a three-hundred-megabyte image
      // would otherwise read all of it to throw away.
      if (finished) this.push(null);
    },
  });
}
