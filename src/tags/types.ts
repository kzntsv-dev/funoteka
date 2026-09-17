import type { DecodedText } from '../text/encoding.ts';

/** One tag as the file states it. Names are folded to lower case; order is kept. */
export interface Tag {
  name: string;
  value: string;
}

/**
 * How a tag's text was arrived at — the decode verdict without its text.
 *
 * The text itself is not carried here: there is one verdict per *file* and
 * potentially a hundred values behind it, and the verdict is the part worth
 * keeping. `DecodedText` minus its `text` is the same shape the cue stage
 * stores, deliberately, so both read the same way in the meta layer.
 */
export type TagEncoding = Omit<DecodedText, 'text'>;

/**
 * What a file's own bytes say about it.
 *
 * Every field is nullable because "this format says nothing" and "this format
 * is not understood" are the same answer to a caller that must keep walking a
 * collection — and a scan cannot stop on one unreadable file.
 */
/**
 * A picture the file carries, as the *place* its bytes are rather than the bytes.
 *
 * A collection of any size cannot afford a copy of every cover: a scan over
 * fifty thousand files would write gigabytes into the meta layer to hold
 * something that is already on the disk in the file it came from, and that copy
 * would go stale the moment somebody edited the file's tags. So the reader
 * reports where the image starts and how long it is, the stage writes those two
 * numbers down, and serving a cover is a byte range of the file — the same
 * bargain the cue segments make with time.
 *
 * The offset is the reader's own index into the array it was handed, which is
 * the file from byte zero (`tags/read.ts` reads whole files), so it is also the
 * file's own offset. A reader that had to *rebuild* a frame to read it — an
 * unsynchronised or compressed ID3 frame — has no such offset to report and
 * reports nothing: a picture whose bytes are a copy is a picture that would be
 * served from the wrong place.
 */
export interface TagPicture {
  mime: string;
  /**
   * The picture's type in the file's own numbering (ID3v2 §4.15 and RFC 9639
   * §8.8 share it), where 3 is a front cover. MP4's `covr` states no type
   * because it has only one meaning, and is recorded as a front cover.
   */
  kind: number;
  /**
   * `[offset, offset + length)` is a region of the file that holds the picture
   * rather than being it, so it has to be read and parsed to get the image.
   *
   * The exception the rule needs, and it is the format's rather than a choice: a
   * picture carried as a `METADATA_BLOCK_PICTURE` comment — which is how an Ogg
   * file holds a cover at all — is base64 of a picture block, sitting in a
   * packet the lacing rule has scattered across pages. There is no contiguous
   * range of that file whose bytes are the image, so what is recorded is a range
   * worth reading. `src/cover/picture.ts` says what to do with it.
   */
  indirect?: true;
  offset: number;
  length: number;
}

/** The picture type that means "this is the cover", in every format here. */
export const FRONT_COVER = 3;

/**
 * The better of two pictures the same file holds.
 *
 * A file may carry several — front, back, artist, a photograph of the disc — and
 * the cover is the one to keep. A front cover wins over anything; between two of
 * the same standing the first one seen wins, so that the answer is a function of
 * the file's bytes rather than of the order a walk happened to visit boxes in.
 */
export function betterPicture(current: TagPicture | undefined, candidate: TagPicture): TagPicture {
  if (current === undefined) return candidate;
  if (current.kind === FRONT_COVER) return current;
  return candidate.kind === FRONT_COVER ? candidate : current;
}

export interface TagRead {
  tags: Tag[];
  /** The cover this file carries, when it carries one. */
  picture?: TagPicture;
  /**
   * Which container the bytes turned out to be: `flac`, `id3v2`, or null when
   * nothing here recognised them.
   *
   * The reader dispatches on the bytes, so this is what it found rather than
   * what the extension claimed — and a duration seeded into `audio_probe` has
   * to name what it came from, or the row is a number from nowhere.
   */
  container: string | null;
  /**
   * The audio format inside that container, when the reader could establish one.
   *
   * A different question from `container`, and the difference is the whole point
   * of the field existing: a `.m4a` is one container whether it holds AAC or
   * Apple's ALAC, so writing `mp4` into `audio_probe.codec` was this project
   * telling itself it had read a codec when it had read a box name.
   *
   * Recognising the container is still not the same as knowing the codec — but
   * for an MP4 the file does say it, in the sound track's sample description,
   * and a reader that walks as far as that box can name it (`mp4.ts`). Null
   * means *this reader cannot name it*, not that the file is silent: for a
   * `.m4a` holding Dolby it is the honest answer, and it is what sends the
   * question on to ffprobe instead of inventing a name for it.
   */
  codec: string | null;
  /**
   * The bytes hold a picture track, so this is a video whatever the kind list
   * made of its extension.
   *
   * Set only by a reader that walked far enough into the boxes to see one,
   * which is why it is absent rather than false elsewhere: a reader that
   * recognised nothing has no opinion about what the file is, and saying
   * "not a video" on its behalf would be a claim it never made.
   *
   * Carried out of the reader because only the reader has looked inside, and
   * reported by the stage because the finding belongs to the file the scan
   * called audio — see the note in `tags/mp4.ts` on why it is not
   * `tag-format-unknown`.
   */
  video?: true;
  /** Playback length, when the container states it outright. */
  durationMs: number | null;
  /**
   * The bytes were understood and their length still could not be established —
   * the frame walk lost the stream with most of the file still ahead of it.
   *
   * `durationMs` is null rather than short in that case, on purpose: a number
   * known to be wrong is worse than no number, and a caller that has something
   * else to ask (ffprobe, for mp3) can only tell it should when the gap is
   * named. Distinct from an ordinary null, which means there was nothing here
   * to measure and nothing to ask about either.
   */
  durationRefused: boolean;
  sampleRate: number | null;
  channels: number | null;
  bitsPerSample: number | null;
  /**
   * The shakiest call made while reading this file's text, or null when it had
   * no text to read at all.
   *
   * The *weakest* one, not the first or the last: a title that decoded cleanly
   * says nothing about the artist beside it that did not, and reporting the
   * clean one would bury the finding. Null and certain are different answers —
   * "nothing was decoded" against "decoded, with nothing to infer".
   */
  encoding: TagEncoding | null;
  /**
   * What a *second* tag block in the same file states, kept apart from `tags`
   * so that the stage can prefer the first and fall back to this one by name.
   *
   * ID3v1 and ID3v2 live at opposite ends of an mp3 and routinely coexist — the
   * older block is what a tagger wrote for players that knew nothing else. Two
   * blocks are not two statements of equal standing: the v2 block is the one the
   * writer maintained, and where both speak the v2 value is the answer.
   *
   * Kept apart rather than merged because merging happens to be *wrong* here,
   * and quietly so. This project stores tags as rows with a position, and two
   * values of one name are read downstream as two artists — so an mp3 whose v2
   * says `ARTIST=A` and whose v1 says `ARTIST=B` would be filed as the
   * collaboration "A + B", or, with no `albumartist` to settle it, as no artist
   * at all (`artist/apply.ts`). Neither is what the file says.
   */
  fallbackTags?: Tag[];
  /**
   * Fields a tag block stated and the reader would not use, one sentence each —
   * an ID3v1 year that is not four digits, a genre byte the list does not name.
   *
   * Reported rather than dropped, because a value that was read and discarded is
   * exactly the silence the contract forbids, and because the file is not
   * damaged: the tag states something that cannot be used, and only the reader
   * knows it.
   */
  refusals?: string[];
}

/**
 * A fresh empty answer, as a function and not a shared constant.
 *
 * A constant would hand every caller the same `tags` array, and the first
 * reader to push into it would be filling in the answer for every later file.
 */
export function noTags(container: string | null = null, codec: string | null = null): TagRead {
  return {
    tags: [],
    container,
    codec,
    durationMs: null,
    durationRefused: false,
    sampleRate: null,
    channels: null,
    bitsPerSample: null,
    encoding: null,
  };
}

/**
 * Keep the less certain of two decode verdicts.
 *
 * Ties keep the one already held, which makes the answer a function of the
 * file's bytes and their order rather than of anything ambient — the same
 * unchanged file must not report a different encoding on two machines.
 */
export function weakestEncoding(current: TagEncoding | null, candidate: DecodedText): TagEncoding {
  const verdict: TagEncoding = {
    encoding: candidate.encoding,
    confidence: candidate.confidence,
    basis: candidate.basis,
  };

  return current === null || verdict.confidence < current.confidence ? verdict : current;
}
