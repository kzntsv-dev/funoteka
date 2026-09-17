import { inflateSync } from 'node:zlib';

import { decodeId3Text, looksLikeText, type DecodedText } from '../text/encoding.ts';
import { resolveGenre } from './genres.ts';
import { betterPicture, noTags, weakestEncoding, type TagRead } from './types.ts';

/**
 * Read an ID3v2 tag.
 *
 * Written against the specification: `id3v2.3.0` and `id3v2-00` for the two
 * earlier versions, `id3v2.4.0-structure` and `id3v2.4.0-frames` for v2.4 —
 * which renumbered its sections and grouped its frames differently, so a
 * citation below names its version where the numbers could be confused. Every
 * rule here has a section beside it, because this reader was first written from
 * memory of the format, and the v2.2 ids record what that cost.
 *
 * What is kept is what the standard calls a text frame — §4.2: "All text frame
 * identifiers begin with 'T'. Only text frame identifiers begin with 'T', with
 * the exception of the TXXX frame" — together with the comment and the frames a
 * date is split across. Everything else (pictures, lyrics, replay gain) is
 * stepped over by its own size, which is why a tag full of artwork still yields
 * its titles. The set is the standard's rather than this collection's on
 * purpose: the table used to hold nine frames and a FLAC beside it kept every
 * field its comment block named, so the container decided which tags existed
 * (task:2737).
 *
 * Three things make this parser more than a loop. Frame sizes changed meaning
 * between v2.3 and v2.4 — plain big-endian in one, seven bits per byte in the
 * other (§3.3 against §4) — so a reader that assumes either one misreads the
 * other's long frames. The text decoders are handed the frame's declared
 * encoding byte as a hint, never as the answer, because the declaration is
 * routinely a lie. And v2.4 frames may be unsynchronised, which is not a detail
 * the text decoders can absorb: the escaping has to come off before anything
 * reads the bytes.
 */

/**
 * Frame id -> the name its text is stored under.
 *
 * Both spellings of an id are here, because v2.2 names a frame with **three**
 * letters — `TP1` for the artist, `TAL` for the album — where v2.3 and v2.4 use
 * four. Read as a four-letter id, `TP1` followed by the first byte of its size
 * is not a frame id at all, so the walk stopped at the first frame and a file
 * with a complete tag was read as having none. Two thirds of the operator's
 * Kroogi rips are written this way by iTunes 10, whose tags ffprobe reads
 * without complaint.
 *
 * The nine names this table used to hold were the whole of what the reader kept,
 * and the collection says what that cost: 116 files carry a copyright, 62 a
 * comment, 16 a language, and a FLAC in the same library keeps *every* field its
 * comment block holds — so the container decided which tags existed, and the
 * meta layer could not be read across the two (task:2737).
 *
 * What replaces the list is the standard's own rule, §4.2: "All text frame
 * identifiers begin with 'T'. Only text frame identifiers begin with 'T', with
 * the exception of the TXXX frame." The set is therefore the standard's rather
 * than this collection's, and a text frame the table has no word for is kept
 * under its own identifier, lowercased, rather than dropped — see `nameOf`.
 */
const TEXT_FRAME_NAMES: Record<string, string> = {
  // The names the meta layer already answers by and a client already reads.
  // They are product names rather than the standard's words — §4.2.1 calls TPE1
  // "Lead performer(s)/Soloist(s)" and TCON "Content type" — and they stay as
  // they are, because queries are written against them.
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TPE2: 'albumartist', TP2: 'albumartist',
  TALB: 'album', TAL: 'album',
  TRCK: 'tracknumber', TRK: 'tracknumber',
  TPOS: 'discnumber', TPA: 'discnumber',
  TCON: 'genre', TCO: 'genre',

  // Everything else §4.2.1 names, under its own word, with v2.2's spelling of
  // the same frame beside it. The three-letter ids are the set §4.2.1 of v2.2
  // defines and no wider: v2.2 has no frame for a file's owner or for an
  // internet radio station at all, so there is no v2.2 spelling for `TOWN`,
  // `TRSN` or `TRSO` below.
  TBPM: 'bpm', TBP: 'bpm',
  TCOM: 'composer', TCM: 'composer',
  TCOP: 'copyright', TCR: 'copyright',
  TDLY: 'playlistdelay', TDY: 'playlistdelay',
  TENC: 'encodedby', TEN: 'encodedby',
  TEXT: 'lyricist', TXT: 'lyricist',
  TFLT: 'filetype', TFT: 'filetype',
  TIT1: 'contentgroup', TT1: 'contentgroup',
  TIT3: 'subtitle', TT3: 'subtitle',
  TKEY: 'initialkey', TKE: 'initialkey',
  TLAN: 'language', TLA: 'language',
  TLEN: 'length', TLE: 'length',
  TMED: 'mediatype', TMT: 'mediatype',
  TOAL: 'originalalbum', TOT: 'originalalbum',
  TOFN: 'originalfilename', TOF: 'originalfilename',
  TOLY: 'originallyricist', TOL: 'originallyricist',
  TOPE: 'originalartist', TOA: 'originalartist',
  TORY: 'originalreleaseyear', TOR: 'originalreleaseyear',
  TOWN: 'fileowner',
  TPE3: 'conductor', TP3: 'conductor',
  TPE4: 'remixedby', TP4: 'remixedby',
  TPUB: 'publisher', TPB: 'publisher',
  TRDA: 'recordingdates', TRD: 'recordingdates',
  TRSN: 'radiostation',
  TRSO: 'radiostationowner',
  TSIZ: 'size', TSI: 'size',
  TSRC: 'isrc', TRC: 'isrc',
  TSSE: 'encodersettings', TSS: 'encodersettings',
  // `TDRC` is v2.4's replacement for `TYER`, and it carries a whole timestamp
  // rather than a year. The older date frames are deliberately not here: §4.2.1
  // splits the date across `TYER` and `TDAT` (v2.2's `TYE`, `TDA` and `TIM`),
  // and one name cannot hold both halves without making which is which a coin
  // toss. They are put together into one `date` after the walk — see `dated`.
  TDRC: 'date',
};

/**
 * What this reader calls a frame, or undefined when the frame is not its to keep.
 *
 * `TXXX` is excluded because its own description names it — and so is `TXX`,
 * which is the same frame in v2.2's three-letter spelling (§4.2.2 of both
 * documents). Missing that one cost exactly what this table exists to prevent: a
 * v2.2 tag holding `ALBUMARTIST` read back as two rows named `txx`, one of them
 * the *description* standing where a value belongs, and the artist the frame
 * named never reaching the stage that looks for it (task:2851, both axes).
 *
 * The frames that carry no text at all — `PRIV`, `GEOB`, `POPM`, `UFID` — are
 * not here either. None of them was ever a name, and a value read out of an
 * opaque body would be an invention in a table of names, which is the failure
 * this reader exists to avoid. The picture frames are `pictureIn`'s business.
 */
function nameOf(id: string): string | undefined {
  if (id === 'TXXX' || id === 'TXX') return undefined;
  return TEXT_FRAME_NAMES[id] ?? (id.startsWith('T') ? id.toLowerCase() : undefined);
}

function readUInt24BE(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0)) >>> 0;
}

function readUInt32BE(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

/** Seven bits per byte, which is how every size inside an ID3v2 tag is written. */
function synchsafeAt(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) & 0x7f) << 21) |
    (((bytes[at + 1] ?? 0) & 0x7f) << 14) |
    (((bytes[at + 2] ?? 0) & 0x7f) << 7) |
    ((bytes[at + 3] ?? 0) & 0x7f)
  );
}

/** A frame id is upper-case letters or digits — three of them in v2.2, four
 * after it. Zeros mean padding, and anything else is not a frame. */
function asciiFrameId(bytes: Uint8Array, at: number, width: number): string {
  let out = '';
  for (let i = 0; i < width; i += 1) {
    const byte = bytes[at + i] ?? 0;
    if (!((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x30 && byte <= 0x39))) return '';
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * Undo the unsynchronisation a writer applied.
 *
 * A writer escapes any `FF` that a reader could take for the start of a frame
 * sync, so what is stored is never the original: `FF 00` was written `FF 00 00`
 * and `FF Ex` was written `FF 00 Ex`. Three bytes therefore settle every case —
 * `FF 00 00` is a real `FF 00`, `FF 00 x` is a real `FF x` — and that middle
 * rule is what keeps a UTF-16 letter like `ÿ` (whose bytes *are* `FF 00`) from
 * being eaten down to a lone `FF`.
 *
 * The same three bytes undo every version, but not in the same place, and that
 * is the whole of what a caller has to get right. v2.4 escapes frame by frame
 * and its frame sizes count what is on disk, so the decoding happens per frame,
 * in `frameData` — and decoding the whole tag instead is what
 * `id3v2.4.0-changes` §3 warns against: "Resynchronisation of the complete tag
 * when the unsynchronisation flag in the tag header is set might result in a
 * corrupt tag". v2.2 and v2.3 escape the tag as it stands (§5 applies the scheme
 * after compression; §3.2 of v2.3 has the CRC computed on the frames *before*
 * it), so their frame sizes count the clean bytes and the whole body is decoded
 * once, in `readId3v2`, before the walk begins.
 */
function deunsynchronise(bytes: Uint8Array): Uint8Array {
  // The common case is a frame with nothing to escape, and it is worth not
  // copying for: the frame is handed back as it is.
  let escaped = false;
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) {
      escaped = true;
      break;
    }
  }
  if (!escaped) return bytes;

  const out = new Uint8Array(bytes.length);
  let at = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    out[at] = byte;
    at += 1;
    if (byte !== 0xff || bytes[i + 1] !== 0x00) continue;
    if (bytes[i + 2] === 0x00) {
      out[at] = 0x00; // a real `FF 00`, which the writer had to double
      at += 1;
      i += 2;
    } else {
      i += 1; // a real `FF`, which the writer had to fence off
    }
  }
  return out.subarray(0, at);
}

/** Where a description ends and its value begins, per the encoding's terminator width. */
function splitTerminated(
  body: Uint8Array,
  encoding: number,
): [Uint8Array, Uint8Array] {
  const width = encoding === 1 || encoding === 2 ? 2 : 1;
  for (let i = 0; i + width <= body.length; i += width) {
    if (body[i] !== 0) continue;
    if (width === 1 || body[i + 1] === 0) {
      return [body.subarray(0, i), body.subarray(i + width)];
    }
  }
  return [body, body.subarray(body.length)];
}

/**
 * Push a decoded value, split on any embedded NUL.
 *
 * §4.2 of v2.4: "All text information frames supports multiple strings, stored
 * as a null separated list, where null is represented by the termination code
 * for the character encoding" — which after decoding is a plain NUL at every
 * width. So a reader that kept the frame whole would hand back a single string
 * holding control characters, and two artists as one name.
 *
 * Worth knowing before trusting this: the split never runs on a value that is
 * mostly control characters, because `looksLikeText` refuses those first, and a
 * short multi-value frame — v2.4's own example is "21" $00 "Eurodisco" — is
 * mostly separator by that measure. Not one of the 700 mp3 files in the
 * collection carries such a frame once its unsynchronisation is removed, so the
 * two rules have yet to meet outside a fixture.
 *
 * `resolve` is applied to each value after the split, because the values of a
 * frame are separate statements: a genre frame holding a reference and a
 * refinement holds two of them, and resolving the pair together would answer
 * for one with the other.
 */
function pushValues(
  into: TagRead,
  name: string,
  decoded: DecodedText,
  resolve: (value: string) => string = (value) => value,
): void {
  // The verdict is kept even when the value is not kept. A malformed frame is
  // a finding, and a reader that swallowed it whole would leave "why is this
  // album unnamed?" with no answer anywhere in the meta layer.
  into.encoding = weakestEncoding(into.encoding, decoded);

  // ...but a value that is not text is not stored. Splitting such a body on its
  // NULs yields one "tag" per character, and those fragments then outrank a
  // folder name that was readable all along.
  // The judgement is made of the parts, and not of the body they were split
  // from — which is the same judgement, because the harm named above *is* the
  // fragments. Section 4.2 says a text frame's NULs are separators, so a body
  // judged whole counts a legitimate separator against itself: `21` and
  // `Eurodisco` with a NUL between them is one control in thirteen bytes, and
  // the guard threw the value away before ever splitting it (task:2738). What
  // it is really looking for is what a misread UTF-16 body produces — every
  // part one character long — and that is asked of the parts directly.
  const parts = decoded.text
    .split('\u0000')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  const readable = parts.filter((part) => looksLikeText(part));
  if (readable.length === 0) return;

  // Every part a single character is not a list of values: it is a body read in
  // the wrong width. `A`, `B`, `C` with NULs between them is `ABC` in UTF-16LE,
  // and one tag per letter would outrank the folder name as the note above says.
  // A majority rather than every one, because a misread body does not end cleanly:
  // its last fragment is whatever is left over. The guard above is a ratio for the
  // same reason.
  const oneChar = readable.filter((part) => [...part].length === 1).length;
  if (readable.length > 1 && oneChar * 2 > readable.length) return;

  for (const part of readable) into.tags.push({ name, value: resolve(part) });
}

/**
 * What a frame's value means, beyond the bytes it is written in.
 *
 * Only the genre has one: section 4.2.1 lets it be a reference to the ID3v1
 * list rather than a word, which is a second encoding of the same value beside
 * the text encoding every frame already carries. Nothing else here reads as
 * anything but itself, and inventing an interpretation for the rest would be
 * deciding what a title is in a stage that only reads.
 */
const RESOLVERS: Record<string, (value: string) => string> = {
  genre: resolveGenre,
};

/**
 * The picture in an `APIC` frame, or in the `PIC` frame v2.2 wrote instead.
 *
 * §4.15 of v2.3 and §4.14 of v2.4 lay it out the same way: the text encoding,
 * the MIME type as a null-terminated Latin-1 string, the picture type, a
 * description in the frame's encoding and terminated the way that encoding
 * terminates, and then the image. v2.2 named the frame `PIC`, used three
 * characters — `JPG`, `PNG` — instead of a MIME type, and is otherwise the same.
 *
 * Returns where the image starts, or null when the frame is not laid out that
 * way — and a frame that cannot be walked yields no picture rather than a guess
 * at one, which is the same rule the rest of this reader follows.
 */
function pictureIn(
  body: Uint8Array,
  major: number,
): { mime: string; kind: number; start: number } | null {
  if (body.length < 4) return null;

  let at = 1; // past the encoding byte, which the description below needs
  const encoding = body[0] ?? 0;
  let mime: string;

  if (major === 2) {
    // Three characters, which are not a MIME type and are not treated as one:
    // the two that were ever defined are read, and anything else is a format
    // this cannot name, which is a reason to say nothing.
    const format = Buffer.from(body.subarray(at, at + 3)).toString('latin1').toUpperCase();
    at += 3;
    if (format === 'JPG') mime = 'image/jpeg';
    else if (format === 'PNG') mime = 'image/png';
    else return null;
  } else {
    // The MIME type runs to a null. A frame that never ends it has no picture
    // behind it to find, so the end of the body is the end of the search.
    let end = at;
    while (end < body.length && body[end] !== 0) end += 1;
    if (end >= body.length) return null;
    mime = Buffer.from(body.subarray(at, end)).toString('latin1');
    at = end + 1;
  }

  if (at >= body.length) return null;
  const kind = body[at] ?? 0;
  at += 1;

  // The description, then the image. Its terminator is one byte or two
  // depending on the encoding, which is the same rule a TXXX frame's
  // description follows.
  const [, rest] = splitTerminated(body.subarray(at), encoding);
  const start = body.length - rest.length;

  return start >= body.length ? null : { mime, kind, start };
}

/**
 * The date, in the pieces §4.2.1 keeps it in.
 *
 * A v2.3 or v2.4 tag states the year, the day and month, and the time in three
 * frames of their own — `TYER`, `TDAT` as `DDMM`, `TIME` as `HHMM` — and v2.2
 * does the same with `TYE`, `TDA` and `TIM`. None of them is a tag in its own
 * right: `TDAT`'s `1209` is the ninth of December, and a name that held it
 * beside the year would be read as the year twelve-oh-nine by anything asking
 * for one. They are collected here and written once, under `date`.
 */
interface DateParts {
  year: string | null;
  dayMonth: string | null;
  hourMinute: string | null;
  /** Whether a `TDRC` frame was seen, which is v2.4's whole timestamp. */
  full: boolean;
}

function readFrame(
  into: TagRead,
  id: string,
  body: Uint8Array,
  /** Collects the frames that are half of a date rather than a value. */
  dates: DateParts,
  /** Where `body` starts in the file, when it is the file's own bytes. */
  at: number | null,
): void {
  if (body.length === 0) return;
  const encoding = body[0] ?? 0;

  if (id === 'APIC' || id === 'PIC') {
    const picture = pictureIn(body, id === 'PIC' ? 2 : 3);
    // A frame the reader had to rebuild — de-unsynchronised, decompressed — is
    // a copy, and a copy has no offset in the file to be served from. The
    // picture is then simply not recorded: an absent cover is a smaller lie
    // than one served from the middle of something else.
    if (picture !== null && at !== null) {
      into.picture = betterPicture(into.picture, {
        mime: picture.mime,
        kind: picture.kind,
        offset: at + picture.start,
        length: body.length - picture.start,
      });
    }
    return;
  }

  // `TXX` is the same frame in v2.2's spelling (§4.2.2 of `id3v2-00`).
  if (id === 'TXXX' || id === 'TXX') {
    // A user-defined pair: its description names it (§4.2.2 of v2.3, §4.2.6 of
    // v2.4, which moved it). This is where a ripper puts ALBUMARTIST when it
    // does not use TPE2, and where the collection keeps ENSEMBLE and the
    // ripping tool's own notes.
    //
    // No resolver, and that is the rule rather than an omission: the genre
    // resolver answers for the frame the standard defines as the content type,
    // and it is asked for by *frame*, not by name. A file free to name its own
    // field `genre` is free to mean anything by it, and reading `17` in it as
    // Rock is deciding what the file meant — measured on a built tag, the whole
    // of that difference (task:2851).
    const [description, value] = splitTerminated(body.subarray(1), encoding);
    // The description is text and is read as text, so how well it decoded counts
    // towards the file's verdict exactly as the value's does. The Vorbis reader
    // folds its field *name* the same way — one figure, and it was being made
    // two ways until this matched it (task:2756).
    const described = decodeId3Text(encoding, description);
    into.encoding = weakestEncoding(into.encoding, described);
    const name = described.text.trim().toLowerCase();
    if (name === '') return;
    pushValues(into, name, decodeId3Text(encoding, value));
    return;
  }

  // A comment is a text frame under an id that does not begin with `T`: §4.11 of
  // v2.3 and §4.10 of v2.4 give it the encoding, then a three-byte language,
  // then the short description that `TXXX` also carries, then the text.
  //
  // The description does *not* name it, though `TXXX`'s does. A TXXX description
  // is the field's name — that is what "user defined" means — while a comment's
  // is a content descriptor, and §4.11 says so: it exists to tell several
  // comments apart, not to introduce a name. Taking it as one let a file name a
  // comment `title` and have it read as a second title ahead of the real one,
  // and the genre resolver then answered for the name it invented (task:2851).
  if (id === 'COMM' || id === 'COM') {
    // Three bytes of language, exactly, whatever they are: they are ISO-639-2
    // codes and not text in the frame's encoding, so the terminator rule does
    // not apply to them.
    const [, text] = splitTerminated(body.subarray(4), encoding);
    pushValues(into, 'comment', decodeId3Text(encoding, text), RESOLVERS.comment);
    return;
  }

  // The frames a date is split across, collected rather than stored — see
  // `DateParts`. The encoding verdict is still folded in: a frame whose value is
  // put to another use has still been read, and how well is a fact about the
  // file.
  if (id === 'TYER' || id === 'TYE' || id === 'TDAT' || id === 'TDA' || id === 'TIME' || id === 'TIM') {
    const decoded = decodeId3Text(encoding, body.subarray(1));
    into.encoding = weakestEncoding(into.encoding, decoded);
    const value = decoded.text.trim();
    if (id === 'TDAT' || id === 'TDA') dates.dayMonth = value;
    else if (id === 'TIME' || id === 'TIM') dates.hourMinute = value;
    else dates.year = value;
    return;
  }

  const known = nameOf(id);
  if (known === undefined) return;
  pushValues(into, known, decodeId3Text(encoding, body.subarray(1)), RESOLVERS[known]);
}

export function readId3v2(bytes: Uint8Array): TagRead {
  // The tag block says nothing about the audio behind it: the codec is the
  // frame walk's to name, in `read.ts`, and the bytes here are ID3 and nothing more.
  const result = noTags('id3v2');
  if (bytes.length < 10) return result;

  // What this reading declined to use, one sentence each, carried out through
  // `TagRead.refusals` so the stage can write it down — see that field on why a
  // value read and discarded is the silence the contract forbids.
  const refusals: string[] = [];

  const major = bytes[3] ?? 0;
  const flags = bytes[5] ?? 0;
  const stored = Math.min(10 + synchsafeAt(bytes, 6), bytes.length);
  let at = 10;
  let end = stored;

  // v2.2's bit 6 is *compression*, not an extended header, and the spec is
  // explicit about what to do with it: "the ID3 decoder (for now) should just
  // ignore the entire tag if the compression bit is set" (id3v2-00 §3.1). No
  // scheme was ever defined, so there is nothing to decompress — parsing on
  // would read compressed bytes as frames and invent names out of them.
  //
  // Ignoring the tag is what the spec asks for; ignoring it *silently* is not,
  // and was: the file then reads exactly like a rip that never had tags, which is
  // a different thing from one whose tags this reader could not use. The sentence
  // goes up through `refusals` and the stage writes it down (task:2754).
  if (major === 2 && (flags & 0x40) !== 0) {
    result.refusals = [
      'the tag is marked compressed, which v2.2 defines no scheme for — nothing in it was read',
    ];
    return result;
  }

  // v2.2 and v2.3 escape the tag as a whole and leave no per-frame place to say
  // so — §3.3.1 of v2.3's frame flags are compression, encryption and grouping —
  // so the escaping comes off here, once, and everything below reads clean bytes.
  // The extended header is included: §3.2 of v2.3 calls it "subject to
  // unsynchronisation" as well, so decoding from the first frame on would leave
  // it escaped and its size field would then be read out of escaped bytes.
  //
  // What the frame sizes describe follows from where the escaping sat, and v2.3
  // says where: §3.2 has the extended header's CRC "calculated before
  // unsynchronisation on the data between the extended header and the padding,
  // i.e. the frames and only the frames", and §5 applies the scheme after
  // compression — to the tag as it stands. So the escaping was applied to
  // assembled frames, whose size fields were written before it, and those sizes
  // therefore count the clean bytes. v2.2 §3.1 and §5 say the same in the same
  // words. Walking such a tag without decoding it first reads the second frame
  // from the wrong offset and the first frame's escaped bytes as text
  // (task:2753); v2.4 is the other arrangement and is `frameData`'s business.
  if (major < 4 && (flags & 0x80) !== 0) {
    const body = deunsynchronise(bytes.subarray(10, stored));
    // The header is copied rather than decoded — §3.1's size is synchsafe, the
    // version bytes are never $FF, and the flags byte names this very flag — so
    // the bytes below keep meaning what the ones above did.
    const joined = new Uint8Array(10 + body.length);
    joined.set(bytes.subarray(0, 10), 0);
    joined.set(body, 10);
    bytes = joined;
    end = joined.length;
  }

  // v2.2 writes a three-letter id and a plain three-byte size, and has no
  // per-frame flags: its frame header is six bytes where every later version
  // uses ten. Everything below is written against that difference.
  const idWidth = major === 2 ? 3 : 4;
  const frameHeader = major === 2 ? 6 : 10;
  const dates: DateParts = { year: null, dayMonth: null, hourMinute: null, full: false };

  // An extended header sits between the tag header and the first frame, and its
  // size field means different things in v2.3 and v2.4. §3.2 of v2.3: "the
  // 'Extended header size', currently 6 or 10 bytes, excludes itself", so the
  // header is four bytes longer than the number. §3.2 of v2.4: "the 'Extended
  // header size' is the size of the whole extended header, stored as a 32 bit
  // synchsafe integer", so it is the number itself. Getting this backwards
  // shifts every frame by a few bytes without any error anywhere. v2.2 has no
  // extended header at all: bit 6 of its flag byte means the tag is compressed.
  if (major >= 3 && (flags & 0x40) !== 0 && at + 4 <= end) {
    if (major >= 4) at += synchsafeAt(bytes, at);
    else at += 4 + readUInt32BE(bytes, at);
  }

  // A header flag saying every frame was escaped. §6.1 of v2.4: "If all frames
  // in the tag are unsynchronised the unsynchronisation flag in the tag header
  // SHOULD be set", with the per-frame flag (§4.1.2, bit n) saying which of
  // them were. The header flag is therefore a summary — but a writer that sets
  // it has escaped every `FF 00` in the tag, so taking it as a blanket
  // instruction costs nothing and missing it would leave escaped bytes in
  // place. v2.2 and v2.3 carry the same flag in their own §3.1 and have no
  // per-frame place to say it instead. A tag of either older version has been
  // decoded above already, so what is left for this flag to mean below is v2.4's
  // summary — and the two places that read it are `frameData` and `sits`.
  const tagEscaped = (flags & 0x80) !== 0;

  // §3.3 of v2.3 and §4 of v2.4 give the frame as an identifier, a size, and two
  // flag bytes; §4.2.1 of v2.2 — three letters where the rest use four, a plain
  // three-byte size, and no flags at all, which is the six-byte header `idWidth`
  // and `frameHeader` below are built around.
  while (at + frameHeader <= end) {
    const id = asciiFrameId(bytes, at, idWidth);
    if (id === '') break; // padding, or something that is not a frame

    const size =
      major >= 4
        ? synchsafeAt(bytes, at + 4)
        : major === 2
          ? readUInt24BE(bytes, at + 3)
          : readUInt32BE(bytes, at + 4);
    const body = at + frameHeader;
    if (size <= 0 || body + size > end) break;

    // A v2.4 frame's size counts what is on disk — escaping and indicator
    // included — so the walk stays on the raw bytes and only what is handed to
    // the frame reader is adjusted. Doing it the other way round there —
    // de-escaping the frames and then walking them — reads every boundary from
    // the wrong offset. v2.2 and v2.3 are the opposite arrangement and are
    // already decoded above, sizes and all, which is why only a v2.4 frame ever
    // reaches here escaped.
    const format = major >= 3 ? (bytes[at + 9] ?? 0) : 0;
    const raw = bytes.subarray(body, body + size);
    // A frame this reader would have read had it been readable. One it ignores
    // anyway — a `PRIV`, a `GEOB` — is not a loss, and a line about it would be
    // noise on every file that carries one.
    const wanted =
      nameOf(id) !== undefined ||
      id === 'TXXX' ||
      id === 'TXX' ||
      id === 'COMM' ||
      id === 'COM' ||
      id === 'APIC' ||
      id === 'PIC';
    const data = frameData(raw, format, major, tagEscaped, (why) => {
      if (wanted) refusals.push(`the frame ${id} ${why}`);
    });

    // Where this frame's data sits in the file, or null when it is not certainly
    // the file's own bytes.
    //
    // Two ways that can fail, and the second is the one worth spelling out.
    // `frameData` rebuilds a frame whose format flags say so — de-escaped,
    // decompressed — and a rebuilt frame is a copy with no place in the file;
    // the buffer identity catches that. A tag of v2.2 or v2.3 that carries the
    // tag flag is the same answer for the other reason: its frames describe
    // bytes that are not the file's — escaped, in v2.2's case, and a decoded
    // copy in v2.3's — so an offset into them would serve the escaping, or the
    // wrong bytes entirely, as part of the picture. The guard is deliberately
    // wider than the rebuild: it needs no measurement of which of the two
    // happened, because neither answer is a file offset.
    const escaped = major < 4 && tagEscaped;
    const sits =
      !escaped && data.buffer === bytes.buffer ? data.byteOffset - bytes.byteOffset : null;

    if (id === 'TDRC') dates.full = true;
    readFrame(result, id, data, dates, sits);
    at = body + size;
  }

  dated(result, dates);
  if (refusals.length > 0) result.refusals = refusals;
  return result;
}

/**
 * Write the date the tag states, out of the frames it states it in.
 *
 * The composite is not the specification's — §4.2.1 defines the three frames and
 * says nothing about putting them together — so it is a choice. It follows
 * ffmpeg, which is the second reader this project measures itself against, on
 * the well-formed case: `2005-09-12` where a year alone loses the day, and it
 * agrees with ffmpeg there on every file of the collection that states a `TDAT`
 * (task:2737).
 *
 * Where they part is the malformed case, and the parting is deliberate: ffmpeg
 * composes `2005-00-00` from a `TDAT` of `0000`, and this reader will not — a
 * date with a date's shape and no date in it is the invention the rest of this
 * file exists to avoid. ffmpeg also drops a `TYER` that holds a whole
 * `2025-03-28`, where this reader keeps what the file wrote; that is the seven
 * files of the collection that carry one (task:2851, measured). Neither
 * difference is a disagreement about the format, which is silent on both.
 *
 * `TDRC`, which v2.4 writes instead, is already a whole timestamp and is left
 * exactly as the file wrote it.
 *
 * A part that is not a date is not one: `TDAT` of `0000` is what a writer puts
 * there when it has no date, and composing `2005-00-00` from it would be an
 * invention with a date's shape. Such a tag keeps the year it does state. A tag
 * that states no year at all yields no `date` rather than a bare `DDMM` — four
 * digits under a name that other code reads a year out of is worse than silence.
 */
function dated(into: TagRead, dates: DateParts): void {
  if (dates.year === null) return;
  // `TDRC` had the last word, and it is asked for by name *and* by having been
  // seen. The weaker test — is any tag called `date` already here — let a
  // user-defined `TXXX` named `date` suppress the year, the day and the month
  // the tag states in the frames that exist for them (task:2851).
  if (dates.full) return;

  // A year is judged by the same rule the stage that reads one out uses — four
  // digits beginning `1` or `2` — and not by being exactly four characters:
  // writers do put a whole `1997-05-06` in `TYER`, and a file that already states
  // a date is not improved by this function recomposing one. `not a year` is
  // what that rule is for, and it stays unanswered.
  const year = /^[12][0-9]{3}$/.test(dates.year.slice(0, 4)) ? dates.year.slice(0, 4) : null;
  if (year === null) return;
  if (dates.year.length > 4) {
    into.tags.push({ name: 'date', value: dates.year });
    return;
  }

  const dayMonth = /^[0-9]{4}$/.test(dates.dayMonth ?? '') ? (dates.dayMonth as string) : null;
  const month = dayMonth === null ? 0 : Number(dayMonth.slice(2, 4));
  const day = dayMonth === null ? 0 : Number(dayMonth.slice(0, 2));
  const usable = month >= 1 && month <= 12 && day >= 1 && day <= 31;

  if (!usable) {
    into.tags.push({ name: 'date', value: year });
    return;
  }

  const hourMinute = /^[0-9]{4}$/.test(dates.hourMinute ?? '') ? (dates.hourMinute as string) : null;
  const hour = hourMinute === null ? 0 : Number(hourMinute.slice(0, 2));
  const minute = hourMinute === null ? 0 : Number(hourMinute.slice(2, 4));
  const clock =
    hourMinute !== null && hour <= 23 && minute <= 59
      ? `T${hourMinute.slice(0, 2)}:${hourMinute.slice(2, 4)}`
      : '';

  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  into.tags.push({ name: 'date', value: `${year}-${mm}-${dd}${clock}` });
}

/** Drop up to `count` bytes from the front, or all of them if there are fewer. */
function skip(bytes: Uint8Array, count: number): Uint8Array {
  return bytes.subarray(Math.min(count, bytes.length));
}

/**
 * Undo whatever the frame's format flags say was done to its data.
 *
 * Both versions put extra fields ahead of the data and say the order is the
 * order of the flags, which is the whole of the difficulty: the layout differs
 * by version even where the flags look alike.
 *
 *   v2.3, §3.3.1, flags %ijk00000 — i compression, j encryption, k grouping —
 *   puts four bytes of decompressed size first, then the encryption method
 *   byte, then the group byte.
 *
 *   v2.4, §4.1.2, flags %0h00kmnp — h grouping, k compression, m encryption,
 *   n unsynchronisation, p data length indicator — puts the group byte first,
 *   then the method byte, then the four-byte indicator.
 *
 * The data length indicator is the length the frame would have had with its
 * format flags zeroed — that is, the length *before* compression. It is not
 * needed to read the frame, whose size is right there, so it is stepped over
 * rather than trusted.
 *
 * What §4.1.2 asks for differs by flag, and the two sentences are worth keeping
 * apart, because they say opposite things: for a **compressed** frame the
 * indicator is required — "If set, this requires the 'Data Length Indicator' bit
 * to be set as well", and "A 'Data Length Indicator' byte MUST be included in
 * the frame" — while for an **unsynchronised** one it is only wanted, "Although
 * desirable, the presence of a 'Data Length Indicator' is not made mandatory by
 * unsynchronisation". This reader takes the indicator when the flag says it is
 * there and does not require it in either case, which is not laxity: the frame's
 * own size settles where it ends, so a writer that omitted a required indicator
 * costs nothing here.
 *
 * An encrypted frame yields nothing. The method byte names a scheme this reader
 * does not implement, and there is no plaintext behind it to read — decoding
 * ciphertext as text is how a title gets invented.
 */
function frameData(
  bytes: Uint8Array,
  format: number,
  major: number,
  tagEscaped: boolean,
  refuse: (why: string) => void,
): Uint8Array {
  // v2.2 has no frame flags at all: its header is six bytes and that is the
  // whole of it. Compression there is a tag-level flag, handled by the caller.
  if (major === 2) return bytes;

  const grouped = (format & (major >= 4 ? 0x40 : 0x20)) !== 0;
  const encrypted = (format & (major >= 4 ? 0x04 : 0x40)) !== 0;
  const indicator = major >= 4 && (format & 0x01) !== 0;
  const compressed = (format & (major >= 4 ? 0x08 : 0x80)) !== 0;

  if (major === 3 && compressed) bytes = skip(bytes, 4);
  // Encryption is answered before the group byte is stepped over, and that is
  // the order the header states: the decompressed size, the method byte, then
  // the group byte. Nothing here reads the method byte — the frame is refused —
  // so the only thing the order decides is which of the two a reader would be
  // wrong about, and this way the comment above and the code agree.
  if (encrypted) {
    refuse('is encrypted, and no scheme here reads it');
    return new Uint8Array(0);
  }
  if (grouped) bytes = skip(bytes, 1);
  if (indicator) bytes = skip(bytes, 4);

  // De-escaping comes before decompressing, and it has to: a writer compresses
  // first and unsynchronises the result, so the reader takes the escaping off
  // the compressed bytes. v2.2 and v2.3 say the same of their tag-level flag,
  // and their case never reaches here: `readId3v2` decoded the whole body before
  // it began to walk, so a compressed v2.3 frame is handed over already clean.
  if (major >= 4 && (tagEscaped || (format & 0x02) !== 0)) bytes = deunsynchronise(bytes);

  if (!compressed) return bytes;

  const inflated = inflateFrame(bytes);
  // Empty is the answer for a body that came back with nothing, and it is the
  // same answer a frame that failed to inflate gets — which is why the failure
  // has to be said here or nowhere: downstream sees an empty body either way.
  if (inflated.length === 0) refuse('says it is compressed and did not decompress');
  return inflated;
}

/**
 * A zlib frame body, or nothing at all.
 *
 * §3.3.1 compresses with zlib and §4.1.2 says "zlib deflate method", so Node's
 * own inflate is the same scheme. ffmpeg reads these frames — that was checked
 * by building one to the specification and asking it — while v2.3's variant it
 * does not implement, so that half of this path has the specification behind it
 * and no second instrument.
 *
 * A frame that says it is compressed and does not decompress is left with no
 * value rather than with its compressed bytes as text: the second would put a
 * plausible-looking title made of zlib header bytes into a column that a title
 * belongs in.
 */
function inflateFrame(bytes: Uint8Array): Uint8Array {
  try {
    return inflateSync(bytes);
  } catch {
    return new Uint8Array(0);
  }
}
