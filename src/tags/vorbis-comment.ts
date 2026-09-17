import { decodeVorbisText, looksLikeText } from '../text/encoding.ts';
import { pictureBlockAt } from './picture.ts';
import { FRONT_COVER, betterPicture, noTags, weakestEncoding, type TagRead } from './types.ts';

/**
 * The Vorbis comment list, which both of this project's Vorbis-comment readers
 * read.
 *
 * The layout is stated once by Vorbis I §5.2.1 — a 32-bit little-endian vendor
 * length and string, a 32-bit count, then each field as its own length and bytes
 * — and RFC 7845 §5.2 says Ogg Opus reuses it byte for byte. Two formats reach
 * it by different roads: FLAC puts it in metadata block type 4 (RFC 9639 §8.6),
 * and Ogg puts it in a packet of its own, after a type octet and the six octets
 * for Vorbis or an eight-byte signature for Opus. Only the road differs.
 *
 * It lived twice, in `flac.ts` and in `ogg.ts`, and the copies had already begun
 * to drift; this is the one copy. The rule that made it urgent is the one below
 * about pictures: a fact about the format that one copy learns and the other
 * does not is a file that reads correctly in one container and wrongly in the
 * other, with nothing to say so.
 */

/**
 * A picture a comment list carried, decoded.
 *
 * The bytes are here rather than a place, which is the opposite of every other
 * picture in this project (`TagPicture`, and `db/migrations/013_cover_art.sql`),
 * and it is a property of the format rather than a choice: a
 * `METADATA_BLOCK_PICTURE` comment is base64 of a picture block, living in a
 * packet that is scattered across pages by the lacing rule, so there is no
 * contiguous range of the file that holds it. The scan keeps only the MIME type
 * and the picture type out of this; the bytes are dropped and re-derived when a
 * client asks — see `src/api/cover.ts`.
 */
export interface CommentPicture {
  mime: string;
  kind: number;
  data: Uint8Array;
}

/**
 * The comment name that carries a picture, and the reason Ogg files have covers
 * at all: the container has no metadata block to put one in, so the Vorbis
 * convention is to base64 a FLAC picture block (RFC 9639 §8.8) into a comment.
 *
 * Read as a comment and it looks like any other tag, which is the trap: taken at
 * face value it becomes a tag row of a hundred and eighty kilobytes of base64,
 * out of a meta layer that exists to describe a collection rather than to carry
 * one. Measured before this was written: eighty files put nineteen and a half
 * megabytes into `file_tag`, one of them in a single value of 562 KB.
 *
 * The older `COVERART`/`COVERARTMIME` pair does the same job, in two comments
 * with the image base64'd raw and no block around it. No file in this collection
 * uses it, and it is not read here — but it is the reason the name below is
 * spelled out in full rather than matched loosely.
 */
const PICTURE_COMMENT = 'metadata_block_picture';

/**
 * The better of two pictures a comment list carries, by the rule `betterPicture`
 * applies to the ones a file carries as ranges.
 *
 * A front cover wins over anything; between two of the same standing the first
 * one seen wins, so that the answer is a function of the file's bytes rather
 * than of the order a walk happened to visit them in.
 */
function betterCommentPicture(
  current: CommentPicture | null,
  candidate: CommentPicture,
): CommentPicture {
  if (current === null) return candidate;
  if (current.kind === FRONT_COVER) return current;
  return candidate.kind === FRONT_COVER ? candidate : current;
}

/**
 * The picture one `METADATA_BLOCK_PICTURE` value holds, or null.
 *
 * Base64 is decoded leniently by Node — it skips characters it does not know
 * rather than refusing — so a value that is not base64 at all decodes to
 * something rather than throwing, and the block parser above is what decides
 * whether the result is a picture. A value that does not parse is dropped
 * silently, which is right for this one name and wrong for every other: an
 * unreadable *picture* is a file with no cover, while an unreadable tag is a
 * finding about the file that the caller counts and reports.
 */
function pictureFromComment(value: Uint8Array): CommentPicture | null {
  const decoded = Buffer.from(Buffer.from(value).toString('latin1'), 'base64');
  const block = pictureBlockAt(decoded, 0, decoded.length);
  if (block === null) return null;

  return {
    mime: block.mime,
    kind: block.kind,
    data: decoded.subarray(block.dataAt, block.dataAt + block.dataLength),
  };
}

/**
 * Read a comment list occupying `[at, end)`, and report the picture it carried.
 *
 * Two things about this are worth knowing before the code below reads as
 * arbitrary. The lengths are 32-bit little-endian, not the big-endian a reader
 * arriving from FLAC's *blocks* would expect — §5.2.1 says the fields are packed
 * "lsb first" and, being octet-aligned, "can simply be read as unaligned 32 bit
 * little endian unsigned integers". And the field *contents* are UTF-8 while the
 * field *names* are ASCII, so a name in any other script is something a file can
 * carry and the specification forbids at once.
 *
 * The walk stops at the first entry it cannot believe — a length that runs past
 * the end, a count that promises more than is there — and keeps what it already
 * read, because the caller is a scan over a whole collection and one damaged
 * file must not be able to stop it.
 */
export function readCommentList(
  bytes: Uint8Array,
  at: number,
  end: number,
  into: TagRead,
): CommentPicture | null {
  let cursor = at;
  let picture: CommentPicture | null = null;

  const takeLength = (): number | null => {
    if (cursor + 4 > end) return null;
    const value =
      ((bytes[cursor] ?? 0) |
        ((bytes[cursor + 1] ?? 0) << 8) |
        ((bytes[cursor + 2] ?? 0) << 16) |
        ((bytes[cursor + 3] ?? 0) << 24)) >>>
      0;
    cursor += 4;
    return value;
  };

  const vendorLength = takeLength();
  if (vendorLength === null) return null;
  // The vendor string names the encoder. Nothing here reads it, but its length
  // is exactly what stands between this cursor and the first comment.
  cursor += vendorLength;
  if (cursor > end) return null;

  const count = takeLength();
  if (count === null) return null;

  for (let i = 0; i < count; i += 1) {
    const size = takeLength();
    if (size === null || cursor + size > end) return picture;

    const entry = bytes.subarray(cursor, cursor + size);
    cursor += size;

    const equals = entry.indexOf(0x3d); // '='
    // §5.2.2 defines a field as a name, an `=`, and the contents. An entry with
    // no separator, or with one in first place, is not a field with a missing
    // half — it never named anything, so there is no value being lost. This is
    // the only shape dropped outright, and the only shape that can be.
    if (equals <= 0) continue;

    // §5.2.2: names are case-insensitive, so they are folded on the way in and
    // every later stage compares one way. Enforcing the section's other rule —
    // a name holds only U+0020..U+007D, which RFC 9639 §8.6 widens to
    // U+0020..U+007E without `=` for the FLAC comments this reader also serves —
    // would mean dropping a field or renaming it, both of which lose what the file
    // said. A name nothing downstream matches is inert; a value thrown away is not.
    const named = decodeVorbisText(entry.subarray(0, equals));
    into.encoding = weakestEncoding(into.encoding, named);
    const name = named.text.toLowerCase();

    // The picture is taken out here, before anything is done to the value: it is
    // not a tag, and the decoding below would turn it into one — a hundred and
    // eighty kilobytes of base64 in a table of names.
    if (name === PICTURE_COMMENT) {
      const found = pictureFromComment(entry.subarray(equals + 1));
      if (found !== null) picture = betterCommentPicture(picture, found);
      continue;
    }

    const decoded = decodeVorbisText(entry.subarray(equals + 1));

    // A value that is not valid UTF-8 still comes out as something readable —
    // it just may be readable and wrong. Recording how it was decided is what
    // lets a later stage say so instead of printing mojibake with confidence.
    // The verdict is kept whether or not the value itself survives; a comment
    // that turned out not to be text is still a finding about the file.
    into.encoding = weakestEncoding(into.encoding, decoded);

    if (!looksLikeText(decoded.text)) continue;

    into.tags.push({ name, value: decoded.text });
  }

  return picture;
}

/**
 * The picture a comment *packet* carries, and nothing else.
 *
 * The serving side of `readCommentList`, and deliberately the same code: a cover
 * is fetched long after the scan that noticed it, from a file nothing is holding
 * in memory, so the bytes have to be derived again — and the derivation has to
 * be the one the scan used, or the two can disagree about which comment is the
 * picture. The names are read into a throwaway answer rather than a second
 * parser.
 */
export function pictureInComment(bytes: Uint8Array, at: number, end: number): CommentPicture | null {
  return readCommentList(bytes, at, end, noTags());
}
