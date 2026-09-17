import { statSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

import { vorbisComment, type TrackTags } from '../tags/encode.ts';
import { flacAudioStart, flacStreamInfo, type FlacStreamInfo } from '../tags/flac.ts';
import type { Reframe } from './rewrite.ts';
import type { ByteSegment } from './segment.ts';

/**
 * A slice of a FLAC image, as a FLAC file.
 *
 * Cutting audio out of a FLAC image is not a byte range, for three reasons that
 * have nothing to do with each other. A frame is not self-delimiting — how long
 * it is depends on what was coded inside it — so the byte where a moment starts
 * cannot be computed and has to be found. The stream states its total length
 * once, in a header at the top of the file, so bytes cut out of the middle still
 * announce the length of the whole record; a client would show a five-minute
 * track as a seventy-minute one and run past its end. And every frame header
 * says where its frame sits in the stream — so frames cut out of the middle go
 * on saying they are the record's, and a player that reads them counts the
 * track from where it sits in the disc rather than from its first second.
 *
 * All three are dealt with here, and the result is a stream a decoder reads as
 * the track it is.
 *
 * Written against **RFC 9639** — the format's standard — so that every section
 * number below is a citation and not a recollection. The reader it builds on
 * (`tags/flac.ts`) was written the same way, after one written from memory
 * turned out to have been misreading real files for as long as it existed; the
 * wiki page `3551` is the record of that.
 *
 * The walk searches rather than counts, and that is the decision worth stating.
 * Stepping from one frame to the next would mean decoding subframes to learn
 * where each ends — a bit-level parser for LPC and Rice-coded residuals, which
 * is a great deal of code to get wrong. Searching for the next frame header
 * costs one pass over the bytes and no decoding, and it is *safer*, not merely
 * cheaper: a candidate is accepted only when its header CRC agrees with its own
 * bytes **and** the number it states is exactly the one that must come next.
 *
 * This page said a coincidence in coded audio would have to satisfy both at
 * once, and then one did. `Игры - Крик в жизни (MASHCD-058-1).flac` carries a run
 * of bytes inside the body of its twenty-second frame that agrees with its own
 * footer, states the number the walk was waiting for, and is wrong only in the
 * blocking strategy it contradicts — which cost the walk 31806 samples of drift
 * and put fifteen tracks of that disc 743 ms early (task:2849). So the walk now
 * holds three things against a candidate: the CRC, the number, and the
 * *strategy* — a stream states that once and keeps it (§9.1.1). And when the
 * walk is done, what it counted is held against the length the stream states for
 * itself, because a walk that has gone wrong is a walk whose total disagrees,
 * and the caller is owed a refusal rather than boundaries where the music is
 * not.
 */

/** How much of the file is read at a time. */
const WINDOW = 1 << 23;

/**
 * Room kept for a frame header that straddles two windows.
 *
 * A header is four bytes, the coded number (at most seven), an uncommon block
 * size (at most two), an uncommon sample rate (at most two) and a CRC: sixteen
 * bytes at the very most, and this is four times that.
 */
const HEADER_ROOM = 64;

/** How many files' frame indexes are held. A twelve-track cue album is one file. */
const CACHE_LIMIT = 8;

interface Header {
  /** Where the header starts, as an offset into the buffer it was read from. */
  at: number;
  /** Samples this frame carries. */
  blockSize: number;
  /** A frame number in a fixed-block stream, else the first sample's number. */
  number: number;
  /** Bytes the header occupies, its CRC included. */
  length: number;
}

/** One frame of the stream, located in the file. */
interface Frame {
  offset: number;
  /** The number of this frame's first sample, counted from the start of the audio. */
  sample: number;
  blockSize: number;
  /**
   * The frame's header as the file states it.
   *
   * Held because a segment has to say the number inside it again: the walk reads
   * the header anyway, and everything about it that is *not* the number — the
   * blocking strategy, the block size and sample rate codes, whatever uncommon
   * sizes it carries — has to come back unchanged, so the header is the thing to
   * keep. Sixteen bytes at the very most, one per frame, for the few files whose
   * indexes are held at once.
   */
  header: Buffer;
}

interface Index {
  frames: Frame[];
  info: FlacStreamInfo;
  /** Bytes in the file, so a segment running to the end knows where that is. */
  size: number;
  /** The file's own, so a re-rip is noticed rather than answered from the old index. */
  mtimeMs: number;
  /**
   * Whether the coded numbers count samples rather than frames (section 9.1.5),
   * which is what a segment's own numbers are measured in.
   */
  variable: boolean;
}

/**
 * CRC-8 as section 9.1.8 defines it: initialised with zero, polynomial
 * `x^8 + x^2 + x^1 + x^0`, covering the whole header before the CRC itself.
 */
function crc8(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0;
  for (let at = from; at < to; at += 1) {
    crc ^= bytes[at] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/**
 * The coded number at `at`: section 9.1.5, a code like UTF-8's, extended to
 * seven bytes.
 *
 * The leading one-bits of the first byte say how many bytes it takes, exactly as
 * UTF-8's do — with the one difference that a lone leading byte (`10xxxxxx`,
 * which UTF-8 reserves for continuations) is refused rather than read as one
 * byte, since a number that begins with a continuation byte is not a number.
 */
function readCodedNumber(bytes: Uint8Array, at: number): { value: number; length: number } | null {
  const lead = bytes[at] ?? 0;

  let ones = 0;
  while (ones < 8 && ((lead >> (7 - ones)) & 1) === 1) ones += 1;

  const length = ones === 0 ? 1 : ones;
  if (ones === 1 || length > 7) return null;
  if (at + length > bytes.length) return null;

  // The first byte carries whatever is left of it below the marker bits; with
  // all seven taken by the marker there is nothing left, which is correct.
  let value = BigInt(ones === 0 ? lead : lead & ((1 << (7 - ones)) - 1));
  for (let i = 1; i < length; i += 1) {
    const next = bytes[at + i] ?? 0;
    if ((next & 0xc0) !== 0x80) return null;
    value = (value << 6n) | BigInt(next & 0x3f);
  }

  // 36 bits unencoded is the format's limit and far more than any file needs.
  // The walk indexes with these, so anything past a JavaScript integer is
  // refused rather than silently rounded.
  return value > 0xffffffffn ? null : { value: Number(value), length };
}

/** How many samples a frame carries, from section 9.1.1's Table 14. */
function blockSizeOf(code: number, bytes: Uint8Array, at: number): number {
  if (code === 1) return 192;
  // 0b0010-0b0101 is 144 * 2^v; 0b1000-0b1111 is 2^v.
  if (code >= 2 && code <= 5) return 144 * (1 << code);
  if (code >= 8) return 1 << code;

  // 0b0110 and 0b0111 carry the block size minus one, after the coded number.
  if (code === 6) return (bytes[at] ?? 0) + 1;
  return (((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)) + 1;
}

/**
 * The frame header at `at`, or null when the bytes there are not one.
 *
 * Section 9.1: the sync code, the blocking strategy, four bits of block size,
 * four of sample rate, the coded number, whichever of the uncommon block size
 * and uncommon sample rate are stored, and a CRC-8 over everything before it.
 * The channel assignment and the bit depth sit between the sample rate and the
 * coded number and are not read: nothing here decodes audio, and a header's
 * length does not depend on them.
 *
 * The CRC is what makes searching for a header possible at all. The two sync
 * bytes occur in coded audio constantly; a header whose CRC agrees with its own
 * bytes occurs by chance once in 256 of those.
 */
function readHeader(bytes: Uint8Array, at: number): Header | null {
  if (at + 5 > bytes.length) return null;

  // 0xFF, then 0b111110 and the blocking strategy bit — section 9.1 says the
  // first two bytes are 0xFFF8 for a fixed-block stream and 0xFFF9 for a
  // variable-block one.
  if (bytes[at] !== 0xff || ((bytes[at + 1] ?? 0) & 0xfe) !== 0xf8) return null;

  const blockCode = ((bytes[at + 2] ?? 0) >> 4) & 0x0f;
  const rateCode = (bytes[at + 2] ?? 0) & 0x0f;
  if (blockCode === 0 || rateCode === 0x0f) return null;

  const coded = readCodedNumber(bytes, at + 4);
  if (coded === null) return null;

  const uncommonBlock = blockCode === 6 ? 1 : blockCode === 7 ? 2 : 0;
  const uncommonRate = rateCode === 12 ? 1 : rateCode === 13 || rateCode === 14 ? 2 : 0;
  const length = 4 + coded.length + uncommonBlock + uncommonRate + 1;

  if (at + length > bytes.length) return null;
  if (crc8(bytes, at, at + length - 1) !== (bytes[at + length - 1] ?? 0)) return null;

  // The uncommon block size follows the coded number, so it is read from where
  // the cursor has arrived at rather than from the start of the header.
  const blockAt = at + 4 + coded.length;
  return { at, blockSize: blockSizeOf(blockCode, bytes, blockAt), number: coded.value, length };
}

/**
 * Walk the whole file and record where every frame is.
 *
 * The walk keeps the tail of each window and refills from the file behind it, so
 * a frame header lying across the seam between two windows is still readable.
 *
 * **Every read is awaited, and that is the point of the signature.** Of a
 * five-hundred-megabyte image this walks sixty-eight eight-megabyte windows, and
 * done synchronously it was one unbroken turn of the event loop — 385 ms in
 * which this single-threaded server answered nobody. Awaited, the loop gets a
 * turn between windows instead, and another client waits for a window rather
 * than for the file (measured, task:2897).
 */
async function buildIndex(
  file: FileHandle,
  size: number,
  mtimeMs: number,
  audioStart: number,
  head: Buffer,
): Promise<Index | null> {
  // Section 8.2: the stream information MUST be the first metadata block, so its
  // body sits past the four-byte signature and its own four-byte block header.
  const info = flacStreamInfo(head, 8);
  if (info.sampleRate <= 0) return null;

  const buffer = Buffer.allocUnsafe(WINDOW);
  let base = audioStart;
  const first = await file.read(buffer, 0, Math.min(WINDOW, size - audioStart), audioStart);
  let filled = first.bytesRead;
  let search = 0;

  const frames: Frame[] = [];
  let sample = 0;
  // What the next frame must state: a frame number rising by one in a
  // fixed-block stream, or a sample number rising by the block size of the
  // frame before it in a variable-block one. Nothing is expected of the first,
  // which is the frame the audio starts with.
  let expected: number | null = null;
  let variable: boolean | null = null;

  for (;;) {
    let found: Header | null = null;

    // The tail of the window is held back so that a header straddling the seam
    // between two windows is read whole once the next one is in behind it. At
    // the end of the file there is no seam and no next window — the bytes in
    // hand are every byte there will ever be — so holding them back means never
    // looking at them at all, and a frame that starts inside that room is a
    // frame the walk does not have.
    //
    // Which is not a corner: an encoder codes its last frame with as many
    // samples as are left, so the closing frames of an image are its shortest —
    // `Кино - Это не любовь (MKK851CD1).flac` ends with frames of sixteen,
    // sixteen and eighteen bytes, and all three of them sat inside the last
    // sixty-four bytes of a two-hundred-and-fifty-megabyte file (task:2783).
    // Six is the shortest a header can be — the sync word, the two bytes of its
    // fields, the coded number and the CRC-8 — so a candidate with fewer bytes
    // left than that is not scanned: there is nothing there to read.
    const ended = base + filled >= size;
    const last = ended ? filled - 6 : Math.max(0, filled - HEADER_ROOM);
    const window = buffer.subarray(0, filled);

    for (let at = search; at <= last; ) {
      const next = buffer.indexOf(0xff, at);
      if (next === -1 || next > last) break;

      const header = readHeader(window, next);
      at = next + 1;
      if (header === null) continue;

      // A stream states its blocking strategy once and keeps it (section 9.1.1),
      // so a candidate stating the other one is coded audio, not a header — and
      // this is the one thing the CRC cannot catch. The run of bytes that cost
      // `Игры - Крик в жизни (MASHCD-058-1).flac` 31806 samples of drift agrees
      // with its own footer, carries the number the walk was waiting for, and is
      // wrong only in the strategy it contradicts (task:2849).
      const strategy = ((buffer[next + 1] ?? 0) & 0x01) === 1;
      if (variable === null) variable = strategy;
      if (strategy !== variable) continue;

      if (expected === null || header.number === expected) {
        found = header;
        break;
      }
    }

    if (found !== null) {
      frames.push({
        offset: base + found.at,
        sample,
        blockSize: found.blockSize,
        // Copied, because the buffer this was read from is refilled as the walk
        // moves on and the header has to outlive the window it came in.
        header: Buffer.from(window.subarray(found.at, found.at + found.length)),
      });
      expected = variable === true ? sample + found.blockSize : found.number + 1;
      sample += found.blockSize;
      search = found.at + 1;
      continue;
    }

    if (base + filled >= size) break;

    // Keep the tail — where a header straddling the seam would start — and read
    // the next window in behind it.
    const keep = Math.min(HEADER_ROOM, filled);
    buffer.copy(buffer, 0, filled - keep, filled);
    base += filled - keep;
    search = Math.max(0, search - (filled - keep));

    const more = await file.read(
      buffer,
      keep,
      Math.min(WINDOW - keep, size - base - keep),
      base + keep,
    );
    if (more.bytesRead <= 0) break;
    filled = keep + more.bytesRead;
  }

  if (frames.length === 0) return null;

  // The stream says how long it is, and this walk now has an answer to hold
  // against it. A walk that took a run of coded audio for a frame is a walk
  // whose total disagrees — and a caller served from that index gets boundaries
  // where the music is not, which is worse than being refused. So a file the two
  // cannot agree on is one this does not answer for, which is what the caller is
  // promised above.
  //
  // The check earns its keep only because the walk cannot prove itself: the
  // coincidence that cost `Игры - Крик в жизни (MASHCD-058-1).flac` 31806 samples
  // satisfied every test the walk had. Zero is "not known" (section 8.2), and a
  // stream that does not state its length has nothing to compare.
  const total = frames.reduce((sum, frame) => sum + frame.blockSize, 0);
  if (info.totalSamples > 0 && total !== info.totalSamples) return null;

  return { frames, info, size, mtimeMs, variable: variable === true };
}

const indexes = new Map<string, Index>();

/** The walks in flight, so two tracks asked for at once walk the image once. */
const walking = new Map<string, Promise<Index | null>>();

/**
 * The frame index of one file, remembered while it stays useful.
 *
 * Without this a client playing a twelve-track cue album would walk the whole
 * image twelve times, once per track, to find where each begins. The guard is
 * the file's size and modification time, so a re-rip is noticed rather than
 * answered from the index of the file it replaced.
 *
 * A walk already under way is shared rather than started again. That could not
 * happen while the walk held the event loop; now that it yields, two tracks of
 * one disc can be inside it together, and without this they would walk a
 * five-hundred-megabyte image twice over.
 */
async function indexOf(path: string, size: number, mtimeMs: number): Promise<Index | null> {
  const known = indexes.get(path);
  if (known !== undefined && known.size === size && known.mtimeMs === mtimeMs) return known;

  const already = walking.get(path);
  if (already !== undefined) return already;

  const work = walk(path, size, mtimeMs).finally(() => walking.delete(path));
  walking.set(path, work);
  return work;
}

/** One walk of one file, from the head it is asked for to the last frame. */
async function walk(path: string, size: number, mtimeMs: number): Promise<Index | null> {
  const file = await open(path, 'r');
  try {
    // The metadata chain stands at the top of the file, and a megabyte is far
    // more than any chain of blocks needs — even one carrying embedded covers.
    const head = Buffer.alloc(Math.min(size, 1 << 20));
    const read = await file.read(head, 0, head.length, 0);
    if (read.bytesRead < head.length) return null;

    const audioStart = flacAudioStart(head);
    if (audioStart === null) return null;

    const index = await buildIndex(file, size, mtimeMs, audioStart, head);
    if (index === null) return null;

    indexes.set(path, index);
    if (indexes.size > CACHE_LIMIT) {
      const oldest = indexes.keys().next().value;
      if (oldest !== undefined && oldest !== path) indexes.delete(oldest);
    }
    return index;
  } finally {
    await file.close();
  }
}

/**
 * The index of the first frame whose first sample is at or after `sample`.
 *
 * Frames are contiguous and in order, so this is the frame a moment falls
 * inside — and `frames.length` when the moment is past the end of the stream.
 */
function frameFrom(index: Index, sample: number): number {
  let low = 0;
  let high = index.frames.length;

  while (low < high) {
    const middle = (low + high) >> 1;
    const frame = index.frames[middle] as Frame;
    if (frame.sample < sample) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The FLAC header a segment is served behind.
 *
 * Section 8.2 again, and it is rebuilt rather than copied because three of its
 * fields would describe a stream this is not. The total sample count becomes the
 * segment's, since that is the length a decoder reports and a client believes.
 * The minimum and maximum frame size become zero, which the same section defines
 * as "not known" — the truth about a slice, and better than the whole file's
 * figures presented as this one's. And the MD5 of the unencoded audio becomes
 * sixteen zero bytes, which the section also defines as "not known": the
 * checksum cannot be recomputed without decoding the audio, and one that does
 * not match is worse than one that says it was never taken.
 *
 * The block sizes *are* filled in, because the walk knows them exactly.
 *
 * **A comment block follows the stream information, and that is the second half
 * of task:2895.** The header used to be the stream information and nothing else,
 * so a cut segment carried no tags at all — measured on a real one, one
 * `STREAMINFO` and no other block. What the tags say and why they are the
 * song's rather than the image's is `tags/encode.ts`; what belongs here is only
 * that they are a block, that section 8.2 puts the stream information first, and
 * that section 8.1's last-block flag is a flag on the *last* one — so the stream
 * information no longer claims to be the end of the list, and the comment does.
 */
function headerFor(
  info: FlacStreamInfo,
  samples: number,
  blocks: number[],
  tags: TrackTags,
): Buffer {
  const comment = vorbisComment(tags);
  const prefix = Buffer.alloc(4 + 4 + 34 + 4 + comment.length);
  prefix.write('fLaC', 0, 'latin1');

  // Section 8.1: the last-block flag, the seven-bit type — 0 is STREAMINFO —
  // and the body's length in three big-endian bytes.
  prefix[4] = 0x00;
  prefix.writeUIntBE(34, 5, 3);

  const at = 8;
  const minBlock = blocks.length === 0 ? 16 : Math.min(...blocks);
  const maxBlock = blocks.length === 0 ? 16 : Math.max(...blocks);
  prefix.writeUInt16BE(minBlock, at);
  prefix.writeUInt16BE(maxBlock, at + 2);
  // Minimum and maximum frame size: zero, "not known" (section 8.2).
  prefix.writeUIntBE(0, at + 4, 3);
  prefix.writeUIntBE(0, at + 7, 3);

  // rate(20) | channels−1(3) | bits−1(5) | total samples(36), as one 64-bit word.
  const packed =
    (BigInt(info.sampleRate) << 44n) |
    (BigInt(info.channels - 1) << 41n) |
    (BigInt(info.bitsPerSample - 1) << 36n) |
    BigInt(samples);
  prefix.writeBigUInt64BE(packed, at + 10);

  // The MD5 field is at `at + 18`, and `alloc` has already zeroed it.

  // Section 8.1 again, for the comment: type 4 (Vorbis comment), the last-block
  // flag set, and the body's length in three big-endian bytes.
  const commentAt = at + 34;
  prefix[commentAt] = 0x80 | 0x04;
  prefix.writeUIntBE(comment.length, commentAt + 1, 3);
  comment.copy(prefix, commentAt + 4);

  return prefix;
}

/**
 * The bytes of one cue track, and the header that makes them a file.
 *
 * Null when the image cannot be walked — which is not a failure of this function
 * but an answer: a caller that gets null knows these bytes cannot be served as
 * the track they claim to be, and must not serve them as anything else.
 */
export async function flacSegment(
  path: string,
  startMs: number,
  endMs: number,
  tags: TrackTags,
): Promise<ByteSegment | null> {
  const stat = statSync(path);
  const index = await indexOf(path, stat.size, stat.mtimeMs);
  if (index === null) return null;

  const rate = index.info.sampleRate;

  // The frame a moment falls *inside*, not the one after it: a client asking
  // for 0:02 of a track wants the music that is playing at 0:02, and that music
  // is in the frame that started at or before it. `frameFrom` answers the other
  // question — the first frame starting at or after a sample — which is what
  // the end of the segment needs and the start must not have. Using it for both
  // cost every segment its opening frame, and that frame is where the first
  // second of the track lives.
  const first = frameFrom(index, Math.floor((startMs * rate) / 1000) + 1) - 1;
  if (first < 0 || first >= index.frames.length) return null;

  // Everything before the first frame of the next segment belongs to this one.
  // Past the last frame there is nothing to stop before and the answer is the
  // end of the file: the closing track of a disc runs to the end of the image
  // by definition.
  const after = frameFrom(index, Math.floor((endMs * rate) / 1000));
  const frames = index.frames.slice(first, after);
  const opening = frames[0] as Frame;
  const from = opening.offset;
  const to = after >= index.frames.length ? index.size : (index.frames[after] as Frame).offset;

  const blocks = frames.map((frame) => frame.blockSize);
  const samples = blocks.reduce((total, size) => total + size, 0);
  return {
    prefix: headerFor(index.info, samples, blocks, tags),
    from,
    to,
    frames: numbered(frames, opening, index.variable, to),
  };
}

/**
 * The frames of a segment, with the numbers they state made the segment's own.
 *
 * This is what makes a cut-out track a track. A frame header says where the
 * frame sits in the stream it belongs to — a frame number, or the number of its
 * first sample — and the frames of an image say where they sit in the *record*:
 * the first frame of "The Pot", thirty-two minutes into the disc, states 20677.
 * Served as they are, they contradict the header in front of them, which says
 * the stream is six minutes long and starts here — and a player that reads the
 * numbers counts the track from thirty-two minutes instead of from zero.
 *
 * So each frame is numbered again from the segment's start: the frames of a
 * fixed-block stream from zero upwards, and those of a variable-block one by
 * the samples before them. A frame already stating the right number is left out
 * entirely — footer included — which is the common case for the first track of
 * a disc and for an image served whole.
 *
 * Each one is named by the whole frame and not by its header, because the header
 * is not all of what changes: the frame's CRC-16 covers it (section 9.3), so a
 * frame restated here is a frame whose footer is computed again on the way out.
 */
function numbered(frames: Frame[], opening: Frame, variable: boolean, end: number): Reframe[] {
  const reframes: Reframe[] = [];

  frames.forEach((frame, ordinal) => {
    const number = variable ? frame.sample - opening.sample : ordinal;
    const restated = renumbered(frame.header, number);
    if (restated.equals(frame.header)) return;

    const to = ordinal + 1 < frames.length ? (frames[ordinal + 1] as Frame).offset : end;
    reframes.push({
      header: { at: frame.offset, length: frame.header.length, bytes: restated },
      from: frame.offset,
      to,
    });
  });

  return reframes;
}

/**
 * A frame header stating `number` instead of the one it was read with.
 *
 * Section 9.1.5 puts the coded number after the header's first four bytes, and
 * whatever uncommon block size and sample rate it carries after the number;
 * section 9.1.8's CRC-8 covers all of it but itself. So the number is replaced,
 * the bytes on either side of it are kept, and the CRC is computed again over
 * the result — a frame whose header CRC no longer agrees with its bytes is one a
 * decoder is right to reject.
 *
 * The replacement is as long as the number needs and no longer, which is how a
 * segment comes out shorter than the bytes it was cut from: frame numbers of a
 * whole record run into the thousands and take two bytes where a segment's
 * first frames take one.
 */
function renumbered(header: Buffer, number: number): Buffer {
  const coded = readCodedNumber(header, 4);
  // The walk parsed this header to find the frame, so there is a number here.
  if (coded === null) return header;

  const body = Buffer.concat([
    header.subarray(0, 4),
    codedNumber(number),
    header.subarray(4 + coded.length, header.length - 1),
  ]);
  return Buffer.concat([body, Buffer.from([crc8(body, 0, body.length)])]);
}

/**
 * A number written the way section 9.1.5 states it — the inverse of the reader
 * above, and the same scheme: the leading byte's one-bits say how many follow,
 * each of them carries six bits of the number, and the leading byte keeps
 * whatever is left below its marker bits.
 */
function codedNumber(value: number): Buffer {
  if (value < 0x80) return Buffer.from([value]);

  // One byte holds seven bits, and every byte added holds six more. The sizes
  // are checked against the same table the reader uses, so a number is never
  // written in a form the reader would take for a longer one.
  let length = 2;
  while (length < 7 && value >= 2 ** (5 * length + 1)) length += 1;

  const bytes = Buffer.alloc(length);
  let rest = value;
  for (let at = length - 1; at > 0; at -= 1) {
    bytes[at] = 0x80 | (rest % 64);
    rest = Math.floor(rest / 64);
  }
  bytes[0] = ((0xff << (8 - length)) & 0xff) | rest;
  return bytes;
}
