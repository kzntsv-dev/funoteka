import { pictureBlockAt } from './picture.ts';
import { betterPicture, noTags, type TagRead } from './types.ts';
import { readCommentList } from './vorbis-comment.ts';

/**
 * Read a FLAC stream's metadata blocks.
 *
 * Written against **RFC 9639** — the format's standard (IETF Standards Track,
 * December 2024) — so that every section number below is a citation and not a
 * recollection. The other readers in this directory were written the second way,
 * and on 2026-09-12 one of them turned out to have been misreading real files
 * since it was written; this is the sweep that followed.
 *
 * The comments inside a FLAC block are described by section 8.6 and by Xiph.Org's
 * `v-comment` page, which is the Vorbis original — where the two differ, section
 * 8.6 is what a FLAC file does.
 *
 * Everything a file has to say about itself lives in this chain: the block walk
 * that finds the Vorbis comments walks past the duration on the way, which is
 * why both come out of one pass and why neither costs a process.
 *
 * The walk is defensive by design. A truncated download, a block claiming more
 * bytes than the file holds, a comment block full of nonsense — each ends the
 * walk with whatever was already gathered, because the caller is a scan over a
 * whole collection and one damaged file must not be able to stop it.
 */

/**
 * RFC 9639 (FLAC), section 8.1: a metadata block opens with a four-byte header —
 * a last-block flag, a seven-bit type, and the block's size in bytes as a
 * three-byte big-endian number *excluding* the header.
 *
 * The same section forbids type 127. It is not special-cased here: the walk
 * steps over any unrecognised block by its declared size, which is the only
 * thing a reader can do with a block it does not know, and stopping on it would
 * cost the file its tags.
 *
 * The block types this reader needs (Table 2): 0 is the stream information,
 * 4 the Vorbis comments. A file also carries padding, a seek table, pictures and
 * an application block, none of which say anything about who made the record.
 */
const BLOCK_STREAMINFO = 0;
const BLOCK_VORBIS_COMMENT = 4;
const BLOCK_PICTURE = 6;

function readUInt24BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0);
}



/**
 * STREAMINFO: the one block every FLAC file must carry, and the reason a FLAC
 * duration needs no decoder.
 *
 * RFC 9639 section 8.2, Table 3, in order: two 16-bit block sizes, two 24-bit
 * frame sizes, then 64 bits packing the sample rate (20), the channel count
 * minus one (3), the bit depth minus one (5) and the total sample count (36),
 * then a 128-bit MD5. The two blocks sizes and the two frame sizes are the first
 * ten bytes, which is why the packed tail is read at `+ 10`; the MD5 follows and
 * nothing here needs it.
 *
 * `channels` and `bitsPerSample` are stored **minus one**. A reader that took
 * the stored values at face value would report mono 15-bit audio for every
 * stereo CD rip in the collection, and nothing downstream would complain. The
 * total sample count of 0 means the stream did not say, which is a different
 * answer from a stream of no length; the sample rate of 0 is reserved for
 * non-audio data (section 8.2), so neither can produce a duration.
 */
/** Everything the stream information block states, in the block's own terms. */
export interface FlacStreamInfo {
  minBlockSize: number;
  maxBlockSize: number;
  minFrameSize: number;
  maxFrameSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
}

/**
 * Read the block at `at` — the body, past its four-byte header.
 *
 * A zero in any of the four size fields means the encoder did not state it
 * (section 8.2), which is why they are carried out rather than folded into a
 * duration here: a caller rebuilding a stream needs to know what was stated and
 * what was not, and only this function knows the difference.
 */
export function flacStreamInfo(bytes: Uint8Array, at: number): FlacStreamInfo {
  const uint = (index: number, width: number): number => {
    let value = 0;
    for (let i = 0; i < width; i += 1) value = (value << 8) | (bytes[at + index + i] ?? 0);
    return value;
  };

  // 16 + 16 + 24 + 24 bits before the packed tail: rate(20) | channels-1(3) |
  // bits-1(5) | total samples(36).
  let packed = 0n;
  for (let i = 0; i < 8; i += 1) packed = (packed << 8n) | BigInt(bytes[at + 10 + i] ?? 0);

  return {
    minBlockSize: uint(0, 2),
    maxBlockSize: uint(2, 2),
    minFrameSize: uint(4, 3),
    maxFrameSize: uint(7, 3),
    sampleRate: Number(packed >> 44n),
    channels: Number((packed >> 41n) & 7n) + 1,
    bitsPerSample: Number((packed >> 36n) & 31n) + 1,
    totalSamples: Number(packed & ((1n << 36n) - 1n)),
  };
}

function readStreamInfo(bytes: Uint8Array, at: number, into: TagRead): void {
  const info = flacStreamInfo(bytes, at);
  into.sampleRate = info.sampleRate;
  into.channels = info.channels;
  into.bitsPerSample = info.bitsPerSample;

  if (info.sampleRate > 0 && info.totalSamples > 0) {
    into.durationMs = Math.round((info.totalSamples / info.sampleRate) * 1000);
  }
}

/**
 * Where the metadata ends and the audio begins.
 *
 * Section 8: the blocks follow the `fLaC` signature directly and come before any
 * audio frame, and the last of them says so with a flag in its header — so the
 * first frame starts where that block ends. Null when the signature is absent or
 * a block claims more bytes than are here, which is a file whose audio offset is
 * not knowable rather than one that starts at some other place.
 *
 * This walks the same chain `readFlac` walks, which is deliberate and not an
 * oversight: that one is gathering tags and must keep whatever it found when a
 * file turns out to be damaged, and this one wants a single number and would
 * rather have none than a wrong one.
 */
export function flacAudioStart(bytes: Uint8Array): number | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) return null;

  let at = 4;
  while (at + 4 <= bytes.length) {
    const header = bytes[at] ?? 0;
    const body = at + 4 + readUInt24BE(bytes, at + 1);
    if (body > bytes.length) return null;

    at = body;
    if ((header & 0x80) !== 0) return at;
  }
  return null;
}

/**
 * The picture a PICTURE block carries.
 *
 * The block's layout is RFC 9639 section 8.8 and lives in `picture.ts`, because
 * the same block turns up base64-encoded in a Vorbis comment — one parser for
 * it is one place for the layout to be wrong. What is here is the part that is
 * this container's own: the block is a contiguous run of the file, so the image
 * inside it is named by a *file* offset, which is what `TagPicture` means
 * everywhere except in the one case the type marks.
 */
function readPicture(bytes: Uint8Array, at: number, length: number, into: TagRead): void {
  const found = pictureBlockAt(bytes, at, at + length);
  if (found === null) return;

  into.picture = betterPicture(into.picture, {
    mime: found.mime,
    kind: found.kind,
    offset: found.dataAt,
    length: found.dataLength,
  });
}

/**
 * Walk the chain of metadata blocks.
 *
 * Section 8: the blocks follow the `fLaC` signature directly and come before any
 * audio frame, and the first of them must be the stream information. Nothing
 * here insists on that order — a file that puts its stream information later is
 * broken, section 8.2 leaves a decoder's behaviour on broken stream information
 * unspecified, and the reading that costs the collection least is to take what
 * the blocks say and keep walking. A second stream information block, which the
 * same section forbids, would be read the same way: last one wins.
 */
export function readFlac(bytes: Uint8Array): TagRead {
  const result = noTags('flac', 'flac');
  let at = 4; // past the `fLaC` marker the caller has already checked

  while (at + 4 <= bytes.length) {
    const header = bytes[at] ?? 0;
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = readUInt24BE(bytes, at + 1);
    const body = at + 4;

    // A block promising more bytes than the file holds means the file is
    // damaged; what was read before it stands.
    if (body + length > bytes.length) break;

    if (type === BLOCK_STREAMINFO && length >= 34) readStreamInfo(bytes, body, result);
    else if (type === BLOCK_VORBIS_COMMENT) readCommentBlock(bytes, body, length, result);
    else if (type === BLOCK_PICTURE) readPicture(bytes, body, length, result);

    at = body + length;
    if (last) break;
  }

  return result;
}

/**
 * The Vorbis comment block (section 8.6), read by the same code an Ogg file's
 * comments are read by — the block and the packet hold the same list, and
 * `vorbis-comment.ts` is where that is stated once.
 *
 * A picture carried here rather than in a PICTURE block is a `METADATA_BLOCK_PICTURE`
 * comment: base64 inside the block, so the image is *not* a contiguous range of
 * the file even though the block is, and the answer says so. No file in this
 * collection uses that form — a FLAC that carries art carries it as a block —
 * but the rule is the shared reader's and applies the moment one does.
 */
function readCommentBlock(bytes: Uint8Array, at: number, length: number, into: TagRead): void {
  const picture = readCommentList(bytes, at, at + length, into);
  if (picture === null) return;

  into.picture = betterPicture(into.picture, {
    mime: picture.mime,
    kind: picture.kind,
    indirect: true,
    offset: at,
    length,
  });
}
