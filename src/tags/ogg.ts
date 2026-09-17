import { betterPicture, noTags, type TagRead } from './types.ts';
import { pictureInComment, readCommentList, type CommentPicture } from './vorbis-comment.ts';

/**
 * Read an Ogg stream's tags, codec and length.
 *
 * Written against **RFC 3533** — the format's own encapsulation specification —
 * for the page layer, **Vorbis I** for the Vorbis half, and **RFC 7845** for the
 * Opus half. Every rule below is a citation rather than a recollection, which is
 * the standard this directory was swept to after a reader written from memory
 * turned out to have been misreading real files since the day it was written
 * (see `flac.ts`).
 *
 * Ogg is a container of containers, and that shapes the whole reader. A file is
 * a sequence of *pages*; each page carries pieces of *packets*; a packet belongs
 * to one of possibly several *logical bitstreams* multiplexed into the same
 * physical one. So the walk below is three nested loops that answer three
 * different questions — where the next page starts, whether a packet has
 * finished, and whether this page is even ours — and getting any one of them
 * wrong produces a reader that silently reads the wrong bytes.
 *
 * Two facts about the format make this cheap. The name and value pairs live in
 * the second packet, which is a few hundred bytes into the file, so the walk
 * stops collecting as soon as they are read. And the length is a number the last
 * page *states* — no decoding, no bitrate arithmetic.
 *
 * The walk is defensive by design, like every reader here: a truncated download,
 * a page claiming more bytes than the file holds, a comment list full of
 * nonsense — each ends the walk with whatever was already gathered, because the
 * caller is a scan over a whole collection and one damaged file must not be able
 * to stop it.
 */

/**
 * RFC 3533 §6, field 1: every page opens with these four bytes.
 *
 * They are what `read.ts` dispatches on, and they are also the only thing that
 * says where a page begins — so a file whose stream is damaged in the middle is
 * picked up again here rather than abandoned.
 */
const CAPTURE = 'OggS';

/**
 * RFC 3533 §6: the header is `number_page_segments + 27` bytes.
 *
 * The count is *inside* the fixed part and the segment table it describes is
 * not, which is the arithmetic every wrong implementation gets wrong by one.
 */
const PAGE_HEADER_BYTES = 27;

/**
 * The granule position of a page no packet finishes on.
 *
 * RFC 3533 §6, field 4: "a special value of -1 (in two's complement) indicates
 * that no packets finish on this page". It is not a position, and reading it as
 * one gives 18446744073709551615 samples — about thirteen million years.
 */
const NO_GRANULE = -1n;

/**
 * The rate an Opus granule counts in, whatever the encoder was fed.
 *
 * RFC 7845 §4: "The granule position of an audio data page is in units of PCM
 * audio samples at a fixed rate of 48 kHz (per channel)". §5.1 is emphatic that
 * the `Input Sample Rate` field in the identification header is *not* this — it
 * records what the encoder was handed before resampling, and no decoder plays at
 * it. Both facts are needed to get a length out of an Opus file, and taking the
 * input rate as the playback rate is the mistake this constant exists to stop.
 */
const OPUS_RATE = 48_000;

/**
 * The last Opus version this reader will look at.
 *
 * RFC 7845 §5.1, item 2: the version's upper four bits name the major version,
 * and "an implementation of this specification SHOULD accept any stream with a
 * version number of '15' or less, and SHOULD assume any stream with a version
 * number '16' or greater is incompatible". So a later major version is declined
 * rather than guessed at — the layout could be anything.
 */
const OPUS_MAX_VERSION = 15;

/**
 * The largest packet this reader will assemble, in bytes.
 *
 * A header packet is a few hundred bytes, and a comment packet carrying a cover
 * is a few megabytes at the very outside. The bound is here because a file can
 * be built whose second packet never finishes — page after page of 255-value
 * lacing, to the end of the file — and the walk below would then hold a view of
 * every segment and hand the lot to `concat`, which copies the whole file a
 * second time. Measured on a 60 MB file of exactly that shape: 246,725 pieces
 * held, a second 60 MB allocated, for a file with no tags in it at all.
 *
 * Past the bound the walk stops collecting and drops what it held. It does not
 * stop walking, because the pages still have to be read for the granule — so a
 * file this happens to still gets its length.
 */
const MAX_HEADER_PACKET_BYTES = 16 * 1024 * 1024;

function readUInt32LE(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * RFC 3533 §6, field 4: eight bytes, and — like every multi-byte field in this
 * format — least significant byte first.
 *
 * Read as a *signed* number because the format uses -1 as a sentinel, and built
 * as a BigInt because the field is 64 bits wide: a long recording's sample count
 * passes 2^32 within a day of audio, and a reader that kept it in a double would
 * start losing the low bits of a number that is exact everywhere upstream.
 */
function readGranule(bytes: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[at + i] ?? 0);
  // Two's complement: §6 says -1 is the sentinel, which only means anything if
  // the value is signed.
  return value >= 0x8000_0000_0000_0000n ? value - 0x1_0000_0000_0000_0000n : value;
}

function magicAt(bytes: Uint8Array, at: number, magic: string): boolean {
  if (at + magic.length > bytes.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[at + i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

/** One page, located rather than copied: the walk is over offsets into the file. */
interface Page {
  headerType: number;
  granule: bigint;
  serial: number;
  segmentCount: number;
  segmentsAt: number;
  bodyAt: number;
  /** The offset just past this page's last body byte — where the next page starts. */
  end: number;
}

/**
 * The page at `at`, or null when there is not one there.
 *
 * Null is the answer to every way a page can fail to be a page, and they are
 * deliberately not distinguished: the caller has nothing different to do about a
 * page that is missing, one that is cut off by the end of the file, one whose
 * segment table promises more body than the file holds, and one written by a
 * version of this format that is not the one specified here. Each of them ends
 * the walk, and each of them ends it with what was already read.
 *
 * The checksum is not verified, and that is a decision rather than an omission.
 * RFC 3533 §6 defines one and a decoder "verifies page sync and integrity by
 * computing and comparing" it — but the only thing this reader could do about a
 * page that failed is discard it, and discarding a page of a file that is
 * otherwise readable costs that file its tags over one flipped bit. The pages
 * this reader *needs* are the first two, and a file whose first two pages are
 * corrupt has nothing to lose by being read anyway.
 */
function pageAt(bytes: Uint8Array, at: number): Page | null {
  if (at + PAGE_HEADER_BYTES > bytes.length) return null;
  if (!magicAt(bytes, at, CAPTURE)) return null;

  // §6, field 2: "this document specifies version 0". A different value is a
  // different layout under the same four magic bytes, and guessing at it is
  // worse than declining.
  if (bytes[at + 4] !== 0) return null;

  const segmentCount = bytes[at + 26] ?? 0;
  const segmentsAt = at + PAGE_HEADER_BYTES;
  const bodyAt = segmentsAt + segmentCount;
  if (bodyAt > bytes.length) return null;

  // §6: the page's own size is the sum of its lacing values. A table that adds
  // up past the end of the file is a truncated download, and the last page of
  // one is exactly what reading this is supposed to survive.
  let body = 0;
  for (let i = 0; i < segmentCount; i += 1) body += bytes[segmentsAt + i] ?? 0;
  const end = bodyAt + body;
  if (end > bytes.length) return null;

  return {
    headerType: bytes[at + 5] ?? 0,
    granule: readGranule(bytes, at + 6),
    serial: readUInt32LE(bytes, at + 14),
    segmentCount,
    segmentsAt,
    bodyAt,
    end,
  };
}

/** What a header packet turned out to be, and what it said. */
type Header =
  | { role: 'identification'; codec: 'vorbis'; channels: number; sampleRate: number }
  | { role: 'identification'; codec: 'opus'; channels: number; preSkip: number }
  | { role: 'comments'; codec: 'vorbis'; at: number }
  | { role: 'comments'; codec: 'opus'; at: number };

/**
 * Which header packet this is, or null when it is neither.
 *
 * Both codecs identify their headers in the packet's first bytes, and both put
 * the identification header first and the comments second (Vorbis I §4.2.1,
 * RFC 7845 §3). The identification header is checked for three of the conditions
 * its specification makes decodability depend on — Vorbis I §4.2.2 requires
 * `vorbis_version` to read 0, and requires a non-zero channel count and sample
 * rate; RFC 7845 §5.1 requires a non-zero channel count too — because a file
 * that fails them is one whose other fields mean something this reader has no
 * way to know. It is declined here rather than reported as a stream with a
 * length.
 *
 * §4.2.2 asks for two more — a valid block size pair and a non-zero framing bit
 * — and neither is enforced. Both are the same kind of rule as the comment
 * name's character range in `vorbis-comment.ts`: keeping it would mean dropping
 * a file that a decoder might well play, and a stream whose channel count and
 * rate are readable is one worth reading the comments of.
 *
 * The Vorbis *setup* header is not recognised and does not need to be: nothing
 * in this reader goes past the comments, and a packet it cannot name ends the
 * header sequence where it stands.
 */
function headerOf(packet: Uint8Array): Header | null {
  // Vorbis I §4.2.1: header packets open with a type octet — 1 identification,
  // 3 comment, 5 setup — followed by the **six** octets `vorbis` (§4.2.1 counts
  // them, and a comment that says five is the kind of small wrongness this file
  // exists to not have).
  if (magicAt(packet, 1, 'vorbis')) {
    const type = packet[0];
    if (type === 0x01 && packet.length >= 30) {
      const version = readUInt32LE(packet, 7);
      const channels = packet[11] ?? 0;
      const sampleRate = readUInt32LE(packet, 12);
      if (version !== 0 || channels === 0 || sampleRate === 0) return null;
      return { role: 'identification', codec: 'vorbis', channels, sampleRate };
    }
    if (type === 0x03) return { role: 'comments', codec: 'vorbis', at: 7 };
    return null;
  }

  // RFC 7845 §5: the two Opus headers carry an eight-byte signature instead.
  if (magicAt(packet, 0, 'OpusHead') && packet.length >= 19) {
    const version = packet[8] ?? 0;
    const channels = packet[9] ?? 0;
    if (version > OPUS_MAX_VERSION || channels === 0) return null;
    // §5.1, item 4: pre-skip is 16 bits, little endian.
    const preSkip = (packet[10] ?? 0) | ((packet[11] ?? 0) << 8);
    return { role: 'identification', codec: 'opus', channels, preSkip };
  }
  if (magicAt(packet, 0, 'OpusTags')) return { role: 'comments', codec: 'opus', at: 8 };

  return null;
}

/**
 * Walk the pages of one logical stream, reporting what it finishes.
 *
 * The format's three nested loops in one place: pages in file order, their
 * segments in table order, and the packets those segments add up to. Two callers
 * want different things out of the same walk — the reader wants the two header
 * packets and the last page's granule, `oggPicture` wants the picture the
 * comment packet holds — and a second copy of the lacing rule is a second place
 * for it to be wrong.
 *
 * `onPacket` sees each packet the stream *finishes*, in order, and returning
 * false stops it seeing any more. `onPage` sees every page of the stream whether
 * a packet finished on it or not, which is where the granule comes from.
 */
function walkStream(
  bytes: Uint8Array,
  serial: number,
  onPacket: (packet: Uint8Array, index: number, page: Page) => boolean,
  onPage?: (page: Page) => void,
): void {
  let pending: Uint8Array[] = [];
  let held = 0;
  let index = 0;
  let collecting = true;

  let at = 0;
  while (at < bytes.length) {
    const page = pageAt(bytes, at);
    if (page === null) break;
    at = page.end;

    if (page.serial !== serial) continue;

    onPage?.(page);

    // Once there is nothing left to collect the pages are still walked, and that
    // is not waste: the granule of the last one is the length of the file, and
    // it is stated nowhere else.
    if (!collecting) continue;

    let cursor = page.bodyAt;
    for (let i = 0; i < page.segmentCount; i += 1) {
      const lace = bytes[page.segmentsAt + i] ?? 0;
      pending.push(bytes.subarray(cursor, cursor + lace));
      cursor += lace;
      held += lace;

      // A packet that has not finished and has grown past any size a header can
      // be is not a header becoming readable — it is a file built to make this
      // hold everything it is given. Dropping what was collected costs such a
      // file its tags, which it does not have.
      if (held > MAX_HEADER_PACKET_BYTES) {
        collecting = false;
        pending = [];
        break;
      }

      // RFC 3533 §5: a lacing value of 255 means "this packet is not finished",
      // and any value below it ends the packet. That single rule is the whole of
      // the framing — and it is why a packet may be spread across a page
      // boundary, and why the pieces have to be collected rather than read where
      // they lie.
      if (lace === 255) continue;

      const packet = concat(pending);
      pending = [];
      held = 0;
      index += 1;
      if (!onPacket(packet, index, page)) {
        collecting = false;
        break;
      }
    }
  }
}

/**
 * Read an Ogg file's tags, codec, length and cover.
 *
 * Never throws: a file that opens with `OggS` and then turns into something else
 * ends the walk where it stands, exactly as a damaged FLAC ends its block walk.
 */
export function readOgg(bytes: Uint8Array): TagRead {
  const opening = pageAt(bytes, 0);
  // `OggS` and then no page: the magic without the format. Answered as "nothing
  // recognised" rather than as an Ogg with no tags, so that the scan still
  // reports it as a format this project cannot read.
  if (opening === null) return noTags();

  const into = noTags('ogg');

  // RFC 3533 §6, field 5: the serial number is "the unique serial number by
  // which the logical bitstream is identified". A physical stream may carry
  // several — a video track beside the audio — interleaved page by page, and a
  // reader that followed all of them would read another stream's packets as
  // this one's. The first page is the one that says which stream this file is
  // about, and every later page of a different serial is stepped over.
  const serial = opening.serial;

  let codec: 'vorbis' | 'opus' | null = null;
  let sampleRate: number | null = null;
  let preSkip = 0;
  let lastGranule: bigint | null = null;

  walkStream(
    bytes,
    serial,
    (packet, index, page) => {
      const header = headerOf(packet);
      // Something that is neither codec's header, or one of theirs this reader
      // does not read. Either way the file's headers are over, and collecting
      // any more would be collecting audio.
      if (header === null) return false;

      if (header.role === 'identification' && index === 1) {
        codec = header.codec;
        if (header.codec === 'vorbis') {
          sampleRate = header.sampleRate;
          into.channels = header.channels;
        } else {
          // §4: an Opus granule counts at 48 kHz whatever §5.1's input sample
          // rate says, so that is the rate this stream is measured in.
          sampleRate = OPUS_RATE;
          preSkip = header.preSkip;
          into.channels = header.channels;
        }
        return true;
      }

      // The comment header is the second packet of either codec, and the only
      // one whose contents this reader keeps.
      if (header.role === 'comments' && index === 2 && header.codec === codec) {
        const picture = readCommentList(packet, header.at, packet.length, into);
        if (picture !== null) {
          // Where to find it again. Not the picture's bytes, because there is no
          // range of this file that holds them — the block is base64 inside a
          // packet the lacing rule has scattered across pages. So what is
          // recorded is the head of the file through the page the comment ends
          // on, which is a range worth reading and holds everything needed to
          // derive them again. See `src/cover/picture.ts`.
          into.picture = betterPicture(into.picture, {
            mime: picture.mime,
            kind: picture.kind,
            indirect: true,
            offset: 0,
            length: page.end,
          });
        }
      }

      return false;
    },
    (page) => {
      // §6, field 4: the granule is the running total up to the last packet the
      // page *finishes*. Kept from every page of ours, so what stands at the end
      // is the last one the stream states — and the -1 sentinel is skipped
      // rather than kept, because a page that finished nothing has stated
      // nothing.
      if (page.granule !== NO_GRANULE) lastGranule = page.granule;
    },
  );

  into.codec = codec;
  into.sampleRate = sampleRate;

  // The length, stated by the stream rather than arrived at. Vorbis I §A.2
  // counts a Vorbis granule in PCM samples; RFC 7845 §4.3 gives the Opus one as
  // the granule *less the pre-skip*, because the samples the pre-skip names are
  // decoder padding that no player ever emits. A granule that is zero or
  // negative states no audio, which is no length rather than a zero-length one.
  if (lastGranule !== null && lastGranule > 0n) {
    if (codec === 'vorbis' && sampleRate !== null) {
      into.durationMs = Math.round((Number(lastGranule) / sampleRate) * 1000);
    } else if (codec === 'opus') {
      const samples = lastGranule - BigInt(preSkip);
      if (samples > 0n) into.durationMs = Math.round((Number(samples) / OPUS_RATE) * 1000);
    }
  }

  // The bytes were understood and their length was not established: a stream cut
  // off before any page states one. That is a question worth handing on, and a
  // different answer from a file whose format nothing here recognised — see
  // `TagRead.durationRefused`.
  //
  // `codec === null` reaches here as well, and it belongs here. An Ogg holding a
  // codec this project does not read — Theora, Speex, FLAC-in-Ogg — has a length
  // in it that this reader cannot interpret, so the container was understood and
  // the length was not. Left out, such a file is the one thing the contract
  // forbids: read, found unreadable, and reported to nobody — not as an unknown
  // format, since the container *is* known, and not to ffprobe either.
  if (into.durationMs === null) into.durationRefused = true;

  return into;
}

/**
 * The collected pieces of a packet as one array.
 *
 * `Buffer.concat` where it is available, because this runs once per packet and
 * a scan opens fifty thousand files; the fallback keeps the reader usable
 * anywhere the bytes are a plain `Uint8Array`, which is what its signature
 * promises.
 */
function concat(pieces: Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0] as Uint8Array;
  let total = 0;
  for (const piece of pieces) total += piece.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

/**
 * The picture an Ogg file carries, derived again from its bytes.
 *
 * The serving side of this reader, and the reason `TagPicture.indirect` exists.
 * A cover is asked for long after the scan that noticed it, from a file nothing
 * is holding in memory — and because the picture is base64 inside a packet
 * scattered across pages, there is no range of the file that could have been
 * written down instead. So the bytes are derived on demand, from the region the
 * scan recorded, by the same walk and the same parser that found them the first
 * time.
 *
 * `bytes` is that region: the head of the file through the page the comment
 * ends on, which for a real file is a couple of hundred kilobytes — the whole
 * point of recording an end rather than reading the file.
 */
export function oggPicture(bytes: Uint8Array): CommentPicture | null {
  const opening = pageAt(bytes, 0);
  if (opening === null) return null;

  let found: CommentPicture | null = null;
  walkStream(bytes, opening.serial, (packet) => {
    const header = headerOf(packet);
    // The headers are over, so this packet is audio and there is nothing further
    // to look at. The identification header is stepped past; the comment is the
    // one that is read.
    if (header === null) return false;
    if (header.role !== 'comments') return true;

    found = pictureInComment(packet, header.at, packet.length);
    return false;
  });

  return found;
}
