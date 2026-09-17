/**
 * A FLAC stream built frame by frame, from the specification.
 *
 * RFC 9639 section 9.1 says what a frame header is, so a file whose frames are
 * known exactly can be written without an encoder: the header fields here are
 * the ones the standard names, the block size is one of its table's, and the
 * CRC-8 is its polynomial. The *bodies* are filler — nothing in the stream layer
 * decodes audio, so what a body has to be is long enough to be skipped and, by
 * default, free of anything that could be taken for a header.
 *
 * That last part is what `decoy` is for. A frame body can contain the two sync
 * bytes and a header that parses; what it cannot do is also agree with its own
 * CRC *and* state the frame number that must come next. A fixture that only ever
 * held innocuous bytes would leave that defence untested, and it is the whole
 * reason a search rather than a decoder is enough here.
 */

/** Block size codes from section 9.1.1's Table 14, for the powers of two. */
const BLOCK_CODES: Record<number, number> = {
  256: 8,
  512: 9,
  1024: 10,
  2048: 11,
  4096: 12,
  8192: 13,
  16384: 14,
  32768: 15,
};

/** Sample rate codes from section 9.1.2, for the rates a fixture is likely to use. */
const RATE_CODES: Record<number, number> = {
  88200: 1,
  176400: 2,
  192000: 3,
  8000: 4,
  16000: 5,
  22050: 6,
  24000: 7,
  32000: 8,
  44100: 9,
  48000: 10,
  96000: 11,
};

/** CRC-8 as section 9.1.8 defines it: zero, polynomial `x^8 + x^2 + x + 1`. */
export function crc8(bytes: Buffer): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** The coded number of section 9.1.5: UTF-8's scheme, one to seven bytes. */
function codedNumber(value: number): Buffer {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x800) return Buffer.from([0xc0 | (value >> 6), 0x80 | (value & 0x3f)]);
  return Buffer.from([
    0xe0 | (value >> 12),
    0x80 | ((value >> 6) & 0x3f),
    0x80 | (value & 0x3f),
  ]);
}

export interface FlacOptions {
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
  frames: number;
  /** A power of two from Table 14. Each frame carries this many samples. */
  blockSize?: number;
  /** Bytes of filler each frame's body occupies. */
  bodyBytes?: number;
  /**
   * Put a plausible-looking frame header inside the body of the first frame,
   * carrying the number the walk will be looking for next.
   *
   * `'crc'` — the shape the CRC rejects: the sync word, the right number, and a
   * footer that does not agree with its own bytes.
   *
   * `'strategy'` — the shape the CRC **cannot** reject: the footer is computed
   * over the fake's bytes, so it agrees, and the only things wrong with it are
   * the blocking strategy it states (variable, in a fixed stream) and the block
   * size it claims. This is the shape that exists in the collection: `Игры -
   * Крик в жизни (MASHCD-058-1).flac` carries one at offset 219913, inside the
   * body of frame 21, and the walk took it — 31806 samples of drift, and 15
   * tracks of that disc served 743 ms early (task:2849).
   */
  decoy?: boolean | 'strategy';
}

/**
 * A whole FLAC file: the signature, its stream information, and the frames.
 *
 * The total sample count in the stream information is what the file *claims*,
 * and it is deliberately settable apart from what the frames add up to — that
 * gap is how a test can tell a rebuilt header from a copied one.
 */
export function flac(options: FlacOptions): Buffer {
  const sampleRate = options.sampleRate ?? 44100;
  const bits = options.bitsPerSample ?? 16;
  const channels = options.channels ?? 2;
  const blockSize = options.blockSize ?? 4096;
  const body = options.bodyBytes ?? 64;

  const blockCode = BLOCK_CODES[blockSize];
  const rateCode = RATE_CODES[sampleRate];
  if (blockCode === undefined) throw new Error(`no block size code for ${blockSize}`);
  if (rateCode === undefined) throw new Error(`no sample rate code for ${sampleRate}`);

  const bodies: Buffer[] = [];
  for (let index = 0; index < options.frames; index += 1) {
    const header = Buffer.concat([
      // Section 9.1: the sync code with the blocking strategy clear, then the
      // block size and sample rate nibbles.
      Buffer.from([0xff, 0xf8, (blockCode << 4) | rateCode]),
      // Channel assignment (independent, two channels), bit depth 16, and the
      // reserved bit section 9.1.4 requires to be zero.
      Buffer.from([(1 << 4) | (4 << 1)]),
      codedNumber(index),
    ]);
    const withCrc = Buffer.concat([header, Buffer.from([crc8(header)])]);

    const filler = Buffer.alloc(body, 0x11);
    if (options.decoy !== undefined && options.decoy !== false && index === 0) {
      const strong = options.decoy === 'strategy';
      // A header for the *next* frame number. The weak one is byte for byte
      // plausible except that its footer is a zero, so the CRC rejects it. The
      // strong one is computed over its own bytes, so the CRC agrees — and it
      // states a block size the stream never uses, which is what a walk that
      // trusts it pays for.
      const fake = Buffer.concat([
        // The blocking strategy bit is the low bit of the second byte: the
        // strong decoy disagrees with the fixed stream it is planted in.
        Buffer.from([0xff, strong ? 0xf9 : 0xf8, ((strong ? 7 : blockCode) << 4) | rateCode, (1 << 4) | (4 << 1)]),
        codedNumber(index + 1),
        // An uncommon block size follows the coded number, and 35902 is the one
        // the live coincidence carries.
        ...(strong ? [Buffer.from([0x8c, 0x3d])] : []),
      ]);
      const planted = Buffer.concat([fake, Buffer.from([strong ? crc8(fake) : 0x00])]);
      planted.copy(filler, 0);
    }

    // A frame ends with a CRC-16 of everything before it (section 9.3). Written
    // as the standard states it rather than as a placeholder, because it is the
    // thing a parser weighs a candidate header by — a fixture with a wrong
    // footer would be a fixture no client could play.
    const covered = Buffer.concat([withCrc, filler]);
    const end = Buffer.alloc(2);
    end.writeUInt16BE(crc16(covered));
    bodies.push(Buffer.concat([covered, end]));
  }

  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(blockSize, 0);
  streamInfo.writeUInt16BE(blockSize, 2);
  // Frame sizes and the MD5: zero, which section 8.2 defines as "not known".
  const samples = options.frames * blockSize;
  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bits - 1) << 36n) |
    BigInt(samples);
  streamInfo.writeBigUInt64BE(packed, 10);

  const blockHeader = Buffer.alloc(4);
  blockHeader[0] = 0x80; // last block, type 0
  blockHeader.writeUIntBE(34, 1, 3);

  return Buffer.concat([Buffer.from('fLaC', 'latin1'), blockHeader, streamInfo, ...bodies]);
}

/** Where the audio starts in a file `flac()` built. */
export const FLAC_AUDIO_START = 4 + 4 + 34;

/** How many bytes one frame of a `flac()` file occupies. */
export function flacFrameSize(options: { bodyBytes?: number; codedBytes?: number } = {}): number {
  // sync(2) + nibbles(1) + channels/depth(1) + coded number + CRC(1) + body + CRC16(2)
  return 4 + (options.codedBytes ?? 1) + 1 + (options.bodyBytes ?? 64) + 2;
}

/** CRC-16 as section 9.3 defines it: polynomial `x^16 + x^15 + x^2 + 1`, no reflection. */
export function crc16(bytes: Buffer): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** One frame, read back out of a stream the way a decoder reads it. */
export interface ReadFrame {
  /** The number the header states: a frame number, or a first sample's. */
  number: number;
  /** Bytes the header occupies, its CRC included. */
  headerBytes: number;
  /** Whether the header's CRC-8 agrees with the bytes it covers. */
  crcOk: boolean;
  /**
   * Whether the frame's CRC-16 agrees with the frame it ends.
   *
   * The footer covers everything before it *including the header*, so a frame
   * whose header was restated and whose footer was not is a frame no parser
   * will take — which is worth a test of its own.
   */
  footerOk: boolean;
}

/**
 * The frames of a `flac()` stream, read back one after another.
 *
 * A walk needs each frame's length to find the next, and `flac()` writes frames
 * of one shape: the header, a body of `bodyBytes`, then the two bytes of CRC-16.
 * What a header's own length is comes out of the header, which is what makes
 * this able to read a *served* segment back — there the numbers have been said
 * again, and a number that needs fewer bytes than the image's makes the frames
 * shorter than the bytes they were cut from.
 */
export function flacFrames(
  bytes: Buffer,
  options: { bodyBytes?: number; audioStart?: number } = {},
): ReadFrame[] {
  const body = options.bodyBytes ?? 64;
  const frames: ReadFrame[] = [];

  for (let at = options.audioStart ?? FLAC_AUDIO_START; at + 4 < bytes.length; ) {
    const length = headerLength(bytes, at);
    const end = at + length + body + 2;
    frames.push({
      number: codedNumberAt(bytes, at + 4).value,
      headerBytes: length,
      crcOk: crc8(bytes.subarray(at, at + length - 1)) === bytes[at + length - 1],
      footerOk: crc16(bytes.subarray(at, end - 2)) === bytes.readUInt16BE(end - 2),
    });
    at = end;
  }
  return frames;
}

/** Bytes the header at `at` occupies: section 9.1's fields, added up. */
function headerLength(bytes: Buffer, at: number): number {
  const blockCode = ((bytes[at + 2] ?? 0) >> 4) & 0x0f;
  const rateCode = (bytes[at + 2] ?? 0) & 0x0f;
  const uncommonBlock = blockCode === 6 ? 1 : blockCode === 7 ? 2 : 0;
  const uncommonRate = rateCode === 12 ? 1 : rateCode === 13 || rateCode === 14 ? 2 : 0;
  return 4 + codedNumberAt(bytes, at + 4).length + uncommonBlock + uncommonRate + 1;
}

/** The coded number at `at` (section 9.1.5), and how many bytes it took. */
function codedNumberAt(bytes: Buffer, at: number): { value: number; length: number } {
  const lead = bytes[at] ?? 0;

  let ones = 0;
  while (ones < 8 && ((lead >> (7 - ones)) & 1) === 1) ones += 1;
  const length = ones === 0 ? 1 : ones;

  let value = ones === 0 ? lead : lead & ((1 << (7 - ones)) - 1);
  for (let i = 1; i < length; i += 1) value = (value << 6) | ((bytes[at + i] ?? 0) & 0x3f);
  return { value, length };
}
