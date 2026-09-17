import { decodeText, looksLikeText, type DecodedText } from '../text/encoding.ts';
import { ID3V1_GENRES } from './genres.ts';
import { betterPicture, FRONT_COVER, noTags, weakestEncoding, type TagRead } from './types.ts';

/**
 * Read what an MP4 file says about itself.
 *
 * `.m4a` is a third of this collection and was, until this reader existed, the
 * one format that gave neither a name nor a length — every stage after this one
 * saw an empty file. It is MP4 underneath: a tree of length-prefixed boxes, and
 * the two things wanted sit in well-known ones.
 *
 * Both are cheap, and both are worth reading here rather than asking ffprobe,
 * which can do it:
 *
 *   - the length is `moov.mvhd`, a `timescale` and a `duration` — the same two
 *     numbers `STREAMINFO` gives for FLAC, and dividing one by the other is the
 *     whole of it;
 *   - the names are `moov.udta.meta.ilst`, and the reason to read them rather
 *     than ask is that ffprobe's tag output is a dictionary. Two `©ART` entries
 *     are a collaboration to this project — `file_tag` carries a position so
 *     they survive — and a dictionary has nowhere to put the second one.
 *
 * Asking would also mean a process per file for a format that is a third of the
 * collection, where ffprobe is spawned elsewhere only for the one file in 267
 * this reader cannot measure.
 *
 * Everything here is stepped over by the length the box declares, never by
 * guessing where the next one starts. That is what lets artwork — most of a
 * tag's bytes and none of its meaning — pass through without being decoded, and
 * what makes it not matter whether `moov` sits before or after the audio.
 */

/** Atom name -> the name it is stored under, matching the ID3v2 and Vorbis maps. */
const TEXT_ATOMS: Record<string, string> = {
  '©nam': 'title',
  '©ART': 'artist',
  aART: 'albumartist',
  '©alb': 'album',
  '©gen': 'genre',
  '©day': 'date',
};

/**
 * Atoms carrying numbers rather than text.
 *
 * `trkn` and `disk` are a number and its total as two 16-bit values; read as
 * text they are a NUL and a control character, the kind of value that looks
 * like an empty tag and quietly loses the track number.
 *
 * `gnre` is one 16-bit value — the ID3v1 genre list by **one-based** index, so
 * 53 is Electronic and 1 is Blues. It is how iTunes writes a genre it took from
 * that list, and it writes no `©gen` beside it: **480 of the 1424 m4a files in
 * the collection carry `gnre` and no words at all**, so before this a third of
 * them had no genre while ffprobe named one for each. The rule that the index
 * is one-based was read off those files — the name every one of the 480 numbers
 * yields at `value - 1` is the name ffprobe reports, 480 times out of 480 —
 * rather than taken on faith, because being wrong by one here is silent: every
 * genre would be the next one along the list, and each would still be a genre.
 */
const NUMBER_ATOMS: Record<string, string> = {
  trkn: 'tracknumber',
  disk: 'discnumber',
  gnre: 'genre',
};

/** The one of those that is a single value rather than a pair. */
const ID3_GENRE_ATOM = 'gnre';

/**
 * Atoms carrying one number, read as one.
 *
 * `rtng` is iTunes' content rating — one byte, and the value is the rating
 * itself rather than an index into anything, so it belongs in neither table
 * above: `NUMBER_ATOMS`' entries are all a number *and its total*, and read
 * through that branch a one-byte atom fails the length check and is dropped
 * without a word. Which is what happened to every `rtng` in this collection:
 * nothing read it, and `explicitStatus` had nothing to answer from.
 */
const INTEGER_ATOMS: Record<string, string> = {
  rtng: 'rtng',
};

interface Box {
  type: string;
  /** First byte of the payload, past the header. */
  bodyAt: number;
  /** One past the last byte of the payload. */
  bodyEnd: number;
}

function uint16be(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)) >>> 0;
}

function uint32be(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

/** Only for a 64-bit `largesize`; every file this meets is far under 2^53. */
function uint64be(bytes: Uint8Array, at: number): number {
  return uint32be(bytes, at) * 0x1_0000_0000 + uint32be(bytes, at + 4);
}

/** Four characters of atom name. Not validated: an unknown name is stepped over. */
function nameAt(bytes: Uint8Array, at: number): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) out += String.fromCharCode(bytes[at + i] ?? 0);
  return out;
}

/**
 * The box starting at `at`, or null when there is not a whole one there.
 *
 * Three of the size field's values are not sizes. One means the real length is
 * in the eight bytes after the name; zero means the box runs to the end of
 * whatever holds it. Reading either as a plain number walks off into nonsense.
 */
function boxAt(bytes: Uint8Array, at: number, limit: number): Box | null {
  if (at + 8 > limit) return null;

  let size = uint32be(bytes, at);
  let bodyAt = at + 8;

  if (size === 1) {
    if (at + 16 > limit) return null;
    size = uint64be(bytes, at + 8);
    bodyAt = at + 16;
  } else if (size === 0) {
    size = limit - at;
  }

  // A box shorter than its own header, or one that does not fit, is the end of
  // the road rather than a place to read from.
  if (size < bodyAt - at) return null;

  return { type: nameAt(bytes, at + 4), bodyAt, bodyEnd: Math.min(at + size, limit) };
}

/** The first box of this type among the children, stepping over the rest. */
function findBox(bytes: Uint8Array, from: number, to: number, wanted: string): Box | null {
  let at = from;
  while (at + 8 <= to) {
    const box = boxAt(bytes, at, to);
    if (box === null) return null;
    if (box.type === wanted) return box;
    if (box.bodyEnd <= at) return null;
    at = box.bodyEnd;
  }
  return null;
}

/**
 * Playback length in milliseconds from `mvhd`, or null when it states none.
 *
 * A fragmented file carries its timing in the fragments and writes zero here,
 * and zero is not a length. Nor is it an error: the caller is told the length
 * was refused and asks something that can measure it.
 */
function lengthFromMvhd(bytes: Uint8Array, mvhd: Box): number | null {
  const version = bytes[mvhd.bodyAt] ?? 0;
  // Version 1 widens the two timestamps before `timescale` to 64 bits, which
  // moves everything after them by eight bytes.
  const timescaleAt = version === 1 ? mvhd.bodyAt + 20 : mvhd.bodyAt + 12;
  const durationAt = timescaleAt + 4;
  if (durationAt + 4 > mvhd.bodyEnd) return null;

  const timescale = uint32be(bytes, timescaleAt);
  const duration = version === 1 ? uint64be(bytes, durationAt) : uint32be(bytes, durationAt);
  if (timescale === 0 || duration === 0) return null;

  return Math.round((duration * 1000) / timescale);
}

/**
 * The value of one `data` box, as the list of values it holds and the call made
 * reading its text.
 *
 * A list because one entry may carry several: iTunes writes a collaboration
 * into a single `©ART` separated by NULs, the same way an ID3v2 frame does, and
 * splitting it is what keeps two artists from becoming one string.
 *
 * The verdict travels out with the values because this reader is the third one
 * in the project and the only one that used to skip asking. It is kept even
 * when no value survives the read: a call made on bytes that turned out not to
 * be text is still a finding about the file.
 */
/**
 * The integer at `from`, big-endian, in however many bytes the payload holds.
 *
 * Four at most: no atom this reads states more, and a longer run of bytes read
 * as a number would be a number that means nothing.
 */
function readInteger(bytes: Uint8Array, from: number, end: number): number | null {
  const width = Math.min(end - from, 4);
  if (width <= 0) return null;

  let value = 0;
  for (let i = 0; i < width; i += 1) value = value * 256 + (bytes[from + i] ?? 0);
  return value;
}

function valueOf(
  bytes: Uint8Array,
  data: Box,
  atomType: string,
): { values: string[]; encoding: DecodedText | null } | null {
  if (data.bodyAt + 8 > data.bodyEnd) return null;

  // The type indicator says what the payload is; the four bytes after it are a
  // locale, which nothing here reads.
  const kind = uint32be(bytes, data.bodyAt);
  const from = data.bodyAt + 8;
  /** A value that was never text: nothing was decoded, so there is no call. */
  const plain = (values: string[]): { values: string[]; encoding: DecodedText | null } => ({
    values,
    encoding: null,
  });

  if (atomType === ID3_GENRE_ATOM) {
    // The genre list by number, one-based — see `NUMBER_ATOMS`.
    if (from + 2 > data.bodyEnd) return null;
    const name = ID3V1_GENRES[uint16be(bytes, from) - 1];
    return name === undefined ? null : plain([name]);
  }

  if (INTEGER_ATOMS[atomType] !== undefined) {
    // Asked of the name and not of `kind`: these atoms are numbers whatever the
    // payload declares, and the pair branch below would drop a one-byte one.
    const value = readInteger(bytes, from, data.bodyEnd);
    return value === null ? null : plain([String(value)]);
  }

  if (NUMBER_ATOMS[atomType] !== undefined) {
    // Two zero bytes, then the number, then the total.
    if (from + 6 > data.bodyEnd) return null;
    const first = uint16be(bytes, from + 2);
    const total = uint16be(bytes, from + 4);
    return plain([total > 0 ? `${first}/${total}` : String(first)]);
  }

  // 21 is a signed integer, which some taggers write a year as.
  if (kind === 21) {
    const value = readInteger(bytes, from, data.bodyEnd);
    return value === null ? null : plain([String(value)]);
  }

  // Everything else — 13 and 14 are JPEG and PNG — is not text and is not read.
  if (kind !== 1) return null;

  // The atom declares its payload UTF-8, and a declaration is a hint to verify
  // rather than an answer. It is the same claim, and the same lie, as an ID3v2
  // frame's encoding byte: the rippers who wrote CP1251 under a declaration of
  // UTF-8 wrote it here too. A bare `TextDecoder` turned those bytes into
  // mojibake and stored it as fact, with nothing recording that any call had
  // been made — this reader was the one of the three that never asked.
  const decoded = decodeText(bytes.subarray(from, data.bodyEnd));
  const text = decoded.text;
  const parts = text.split('\u0000').filter((part) => part !== '');
  return { values: parts, encoding: decoded };
}

/**
 * The handler type of every track in the movie — `soun`, `vide`, or something
 * else again.
 *
 * This is the only thing in an MP4 that distinguishes a song from a video. The
 * extension does not: an `.m4a` and a phone clip are the same container with
 * the same `ftyp`, and a live clip carries both tracks at once. Rejecting video
 * by extension is what this project's kind list does, and it is exactly the
 * kind of name-based judgement the byte dispatch exists to avoid — so the
 * judgement is made here instead, where the bytes are.
 */
function trackHandlers(bytes: Uint8Array, moov: Box): string[] {
  const handlers: string[] = [];
  let at = moov.bodyAt;

  while (at + 8 <= moov.bodyEnd) {
    const box = boxAt(bytes, at, moov.bodyEnd);
    if (box === null) break;

    if (box.type === 'trak') {
      const mdia = findBox(bytes, box.bodyAt, box.bodyEnd, 'mdia');
      const hdlr = mdia === null ? null : findBox(bytes, mdia.bodyAt, mdia.bodyEnd, 'hdlr');
      // Past the version and flags, and the four-byte predefined field.
      if (hdlr !== null) handlers.push(nameAt(bytes, hdlr.bodyAt + 8));
    }

    if (box.bodyEnd <= at) break;
    at = box.bodyEnd;
  }

  return handlers;
}

/**
 * Past a descriptor's tag and length, to the first byte of its payload.
 *
 * An MPEG-4 descriptor length is one to four bytes, and every byte but the last
 * has its high bit set — the same continuation form the box sizes do not use.
 */
function pastDescriptor(bytes: Uint8Array, at: number, limit: number): number {
  let cursor = at + 1;
  while (cursor < limit && ((bytes[cursor] ?? 0) & 0x80) !== 0) cursor += 1;
  return cursor + 1;
}

/**
 * The object type an `esds` declares, which for `mp4a` is what says AAC.
 *
 * Only the two descriptors on the path to it are walked — `ES_Descriptor`
 * (tag 3) holding a `DecoderConfigDescriptor` (tag 4), whose first payload byte
 * is the type. The tags are what identify them rather than the offsets,
 * because an `ES_Descriptor` may carry a URL, an OCR code or a stream
 * dependence between the two, and each of those shifts everything after it.
 */
function objectTypeOf(bytes: Uint8Array, esds: Box): number | null {
  const limit = esds.bodyEnd;
  // A full box: four bytes of version and flags before the first descriptor.
  let at = esds.bodyAt + 4;
  if (at >= limit || bytes[at] !== 0x03) return null;

  at = pastDescriptor(bytes, at, limit);
  at += 2; // the ES_ID, which is not an identifier this project has any use for
  const flags = bytes[at] ?? 0;
  at += 1;
  if ((flags & 0x80) !== 0) at += 2; // stream dependence
  if ((flags & 0x40) !== 0) at += 1; // URL
  if ((flags & 0x20) !== 0) at += 2; // OCR

  if (at >= limit || bytes[at] !== 0x04) return null;
  at = pastDescriptor(bytes, at, limit);
  return at < limit ? (bytes[at] ?? null) : null;
}

/**
 * What a sound track's sample description states, said the way ffprobe says it.
 *
 * This is the one place in an MP4 that answers the question a `.m4a` raises.
 * The container is the same whether it holds AAC or Apple's ALAC, so the box
 * name answers nothing — and beside the codec sit the channel count and the
 * sample rate, which the decision path needs for the same reason. Not reading
 * any of the three was not a gap in the meta layer but work on the path that
 * answers a client: `codecOf` spawned ffprobe for every `.m4a` of a collection
 * that has 1425 of them, and a client naming `maxAudioChannels` could not be
 * answered from a row with no channel count at all, so those files were
 * transcoded whole (task:2910).
 *
 * **Measured against ffprobe over that whole collection, not reasoned about.**
 * All three fields, over all 1425 `.m4a`, no disagreement:
 *
 *   - 1088 carry `mp4a` with an object type of 0x40, and ffprobe names every one
 *     of them `aac`; 337 carry `alac`, and ffprobe names every one of them
 *     `alac`. That is why the codec map below is written as narrowly as it is.
 *   - the channel count and the sample rate agree with ffprobe on 1425 of 1425,
 *     which is what makes them worth storing rather than asking about.
 *
 * A code this does not recognise is `null` rather than a guess, and null is not
 * a failure: it is what sends the question on to a process that can answer it.
 * Dolby on an `.m4a` is an ordinary thing to meet, and calling it AAC would be
 * a number from nowhere.
 */
function formatOfSampleEntry(bytes: Uint8Array, moov: Box): {
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
} {
  const nothing = { codec: null, sampleRate: null, channels: null };
  let at = moov.bodyAt;

  while (at + 8 <= moov.bodyEnd) {
    const trak = boxAt(bytes, at, moov.bodyEnd);
    if (trak === null) break;

    if (trak.type === 'trak') {
      const mdia = findBox(bytes, trak.bodyAt, trak.bodyEnd, 'mdia');
      const hdlr = mdia === null ? null : findBox(bytes, mdia.bodyAt, mdia.bodyEnd, 'hdlr');
      // Only a sound track describes audio; a picture track's samples are not
      // what any of this is about, and a live clip carries both at once.
      if (mdia !== null && hdlr !== null && nameAt(bytes, hdlr.bodyAt + 8) === 'soun') {
        const minf = findBox(bytes, mdia.bodyAt, mdia.bodyEnd, 'minf');
        const stbl = minf === null ? null : findBox(bytes, minf.bodyAt, minf.bodyEnd, 'stbl');
        const stsd = stbl === null ? null : findBox(bytes, stbl.bodyAt, stbl.bodyEnd, 'stsd');
        // Full box: version and flags, then the entry count, then the entries.
        const entry = stsd === null ? null : boxAt(bytes, stsd.bodyAt + 8, stsd.bodyEnd);
        if (entry === null) return nothing;

        // An *audio* sample entry states both, at fixed offsets: six reserved
        // bytes and a data reference index, then version, revision and vendor,
        // then the channel count, the sample size, two predefined fields, and
        // the sample rate as a 16.16 fixed number — whose integer half is the
        // rate. A zero in either is the format's way of saying it is not there,
        // and null is this project's.
        const channels = uint16be(bytes, entry.bodyAt + 16);
        const rate = uint16be(bytes, entry.bodyAt + 24);
        const measured = {
          sampleRate: rate === 0 ? null : rate,
          channels: channels === 0 ? null : channels,
        };

        if (entry.type === 'alac') return { codec: 'alac', ...measured };
        if (entry.type !== 'mp4a') return { ...nothing, ...measured };

        // `mp4a` keeps its children 28 bytes in, past the fields above.
        const esds = findBox(bytes, entry.bodyAt + 28, entry.bodyEnd, 'esds');
        const objectType = esds === null ? null : objectTypeOf(bytes, esds);

        // 0x40 is MPEG-4 audio, and 0x66/0x67/0x68 are the AAC profiles that
        // are still AAC. 0x69 and 0x6b are MPEG-1 and MPEG-2 audio wrapped in
        // an MP4, which is a real thing an old encoder produced.
        const named =
          objectType === 0x40 || objectType === 0x66 || objectType === 0x67 || objectType === 0x68
            ? 'aac'
            : objectType === 0x69 || objectType === 0x6b
              ? 'mp3'
              : null;
        return { codec: named, ...measured };
      }
    }

    if (trak.bodyEnd <= at) break;
    at = trak.bodyEnd;
  }

  return nothing;
}

/** Every value the `ilst` holds, in the order the file states them. */
function readIlst(bytes: Uint8Array, ilst: Box, into: TagRead): void {
  let at = ilst.bodyAt;

  while (at + 8 <= ilst.bodyEnd) {
    const entry = boxAt(bytes, at, ilst.bodyEnd);
    if (entry === null) return;

    // The cover, as an entry of its own. Its `data` box states what the image
    // is — 13 is JPEG and 14 is PNG, the two the format defines — and the bytes
    // follow the type indicator and a locale. `covr` has no picture *type*
    // because it has only one meaning, and it is recorded as a front cover,
    // which is the type that wins when a file also carries something else.
    if (entry.type === 'covr') {
      let payloadAt = entry.bodyAt;
      while (payloadAt + 8 <= entry.bodyEnd) {
        const data = boxAt(bytes, payloadAt, entry.bodyEnd);
        if (data === null) break;
        if (data.type === 'data' && data.bodyAt + 8 <= data.bodyEnd) {
          const kind = uint32be(bytes, data.bodyAt);
          const mime = kind === 13 ? 'image/jpeg' : kind === 14 ? 'image/png' : null;
          const from = data.bodyAt + 8;
          if (mime !== null && data.bodyEnd > from) {
            into.picture = betterPicture(into.picture, {
              mime,
              kind: FRONT_COVER,
              offset: from,
              length: data.bodyEnd - from,
            });
          }
        }
        if (data.bodyEnd <= payloadAt) break;
        payloadAt = data.bodyEnd;
      }
    }

    const name =
      TEXT_ATOMS[entry.type] ?? NUMBER_ATOMS[entry.type] ?? INTEGER_ATOMS[entry.type];
    if (name !== undefined) {
      // An entry is a box of `data` boxes, and may hold more than one.
      let payloadAt = entry.bodyAt;
      while (payloadAt + 8 <= entry.bodyEnd) {
        const data = boxAt(bytes, payloadAt, entry.bodyEnd);
        if (data === null) break;
        if (data.type === 'data') {
          const read = valueOf(bytes, data, entry.type);
          if (read !== null) {
            // The weakest call across the file, the way FLAC and ID3 report it:
            // a title that decoded cleanly says nothing about the artist beside
            // it that did not.
            if (read.encoding !== null) {
              into.encoding = weakestEncoding(into.encoding, read.encoding);
            }
            // ...and a value that is not text is not stored. Same judgement the
            // other two readers make, and for the same reason: splitting such a
            // payload on its NULs makes a dozen one-character tags that then
            // outrank a folder name that was readable all along.
            for (const value of read.values) {
              if (looksLikeText(value)) into.tags.push({ name, value });
            }
          }
        }
        if (data.bodyEnd <= payloadAt) break;
        payloadAt = data.bodyEnd;
      }
    }

    if (entry.bodyEnd <= at) return;
    at = entry.bodyEnd;
  }
}

/**
 * Read an MP4's length and names.
 *
 * Never throws: a truncated file, a box that claims a size it does not have and
 * a file with no index at all each end the walk where it stands, because the
 * caller is a scan over a whole collection.
 */
export function readMp4(bytes: Uint8Array): TagRead {
  // No codec yet: the sample description is read further down, and only after
  // the track types have said this is a song — see `formatOfSampleEntry`.
  const into = noTags('mp4');

  const moov = findBox(bytes, 0, bytes.length, 'moov');
  if (moov === null) {
    // No index: a download that stopped early, or a fragmented file whose
    // `moov` is still being written. Not a length — but a question worth
    // asking, which is what the refusal says.
    //
    // A video truncated the same way is indistinguishable here, and would be
    // asked about too. That is left alone deliberately: it takes a video that
    // is also classified as audio, which the kind list prevents, and the
    // alternative — declining anything whose index is missing — would throw
    // away the length of every half-downloaded song instead.
    return { ...into, durationRefused: true };
  }

  // A picture anywhere in the movie makes it a video, sound track or not: a
  // live clip has both, and the collection keeps those as clips. A sound track
  // is required, a picture track is disqualifying.
  //
  // `noTags('mp4')` rather than `noTags()`: the file has been understood, and
  // saying otherwise made the stage report `tag-format-unknown` — "a format the
  // reader does not recognise, no tags, no duration" — about an mp4 whose boxes
  // it had just walked. The dump was being told the wrong thing.
  //
  // A video misclassified as audio is a finding, and it is not that one, so it
  // travels out as itself: `video` says the picture track was seen, and the
  // stage reports it under its own name. Reading it here is the whole of what
  // this reader can do about it — the kind came from the extension, and the
  // reader is the only thing that has looked inside the boxes.
  const handlers = trackHandlers(bytes, moov);
  if (handlers.includes('vide') || !handlers.includes('soun')) {
    return handlers.includes('vide') ? { ...noTags('mp4'), video: true } : noTags('mp4');
  }

  // What is inside the container, which the container's own name does not say.
  // Read here rather than beside the boxes above so that a video never gets
  // any of it: the picture track's sample description describes pictures.
  const format = formatOfSampleEntry(bytes, moov);
  into.codec = format.codec;
  into.sampleRate = format.sampleRate;
  into.channels = format.channels;

  const mvhd = findBox(bytes, moov.bodyAt, moov.bodyEnd, 'mvhd');
  if (mvhd !== null) into.durationMs = lengthFromMvhd(bytes, mvhd);
  if (into.durationMs === null) into.durationRefused = true;

  const udta = findBox(bytes, moov.bodyAt, moov.bodyEnd, 'udta');
  const meta = udta === null ? null : findBox(bytes, udta.bodyAt, udta.bodyEnd, 'meta');
  // `meta` is a full box: four bytes of version and flags sit before its
  // children, and a walk that starts at the payload reads those bytes as a
  // box header and finds nothing after them.
  const ilst = meta === null ? null : findBox(bytes, meta.bodyAt + 4, meta.bodyEnd, 'ilst');
  if (ilst !== null) readIlst(bytes, ilst, into);

  return into;
}
