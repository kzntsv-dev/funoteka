import { readFlac } from './flac.ts';
import { readId3v1 } from './id3v1.ts';
import { readId3v2 } from './id3v2.ts';
import { mpegLength } from './mpeg.ts';
import { readMp4 } from './mp4.ts';
import { readOgg } from './ogg.ts';
import { noTags, type TagRead } from './types.ts';

export type { Tag, TagRead } from './types.ts';

/**
 * Which reading of a file this code takes.
 *
 * The reader set below is not a constant — readers get fixed and new formats get
 * added, and on 2026-09-12 a FLAC reader was found to have been misreading real
 * files since it was written. A stored verdict describes a file *as read by a
 * particular reading*, so when that reading changes, every verdict below it is
 * no longer a verdict about the file.
 *
 * This number is what says so. It is written on every file the stage reads and
 * is a reason to read a file again, exactly as `PROBE_METHOD` is for a probe row
 * (`db/migrations/015_probe_method.sql`, and the same idea in `apply.ts`).
 * Raising it re-reads the library once; without it a reader could be corrected
 * and never reach a file that had not moved, which is precisely what happened
 * when the Ogg reader landed and eighty `.ogg` files stayed empty
 * (`db/migrations/016_tags_method.sql`).
 *
 * 2 — a picture carried as a comment stopped being written down as a tag. It
 * arrives looking like any other name and value, so the eighty `.ogg` files put
 * nineteen and a half megabytes of base64 into `file_tag`, one of them in a
 * single value of 562 KB. Correcting that is a change of reading like any other,
 * and a file it does not reach keeps its base64 for good.
 *
 * 3 — ID3v1 is read. Its block sits at the *other* end of an mp3 from the v2
 * block and had been read by nobody, so a file whose names are only there was
 * read as a bare stream with no tags and no complaint. 273 files of this
 * collection are exactly that, and 489 more carry both blocks — the older one
 * filling names the newer left unstated.
 *
 * 4 — and the verdict stored for such a file is now about the text that
 * survives. 3 weighed the whole older block, so an mp3 whose v2 block is clean
 * UTF-8 and whose v1 block is Latin-1 was filed as a guess on the strength of
 * titles nothing keeps: 328 findings on this collection about a name the newer
 * block had already answered for. The reading did not change; what is recorded
 * about it did, which is the same kind of change and reaches a stored row the
 * same way.
 *
 * 5 — an ID3 tag yields every frame the standard calls text rather than the nine
 * the reader used to hold, a comment is read, and the date is composed from the
 * frames §4.2.1 splits it across (task:2737). Measured by running the reader
 * over the collection before and after: 447 of its 703 tagged mp3 gain at least
 * one name, and no name or value a file already had is lost. Without this number
 * none of that reaches a file that does not move — which was measured too: a
 * scan after the change but before this bump read *no* files at all.
 *
 * 6 — an MP4's `rtng` atom is read, which is the content rating the
 * specification calls `explicitStatus` (task:2866). 1425 of this collection's
 * files are `.m4a`, and the atom was previously dropped without a word: through
 * the pair branch (`trkn`/`disk`) a one-byte atom fails the length check, and
 * the pass-through branch does not exist for MP4 at all. Measured after the
 * reader landed: fifteen of fifty-two sampled `.m4a` files carry the atom, and
 * the field was empty for every one of them.
 *
 * **This entry exists because the bump was missed.** The reader was corrected in
 * `ca3af89` and this number was left at 5, so a rescan re-read nothing — 3350
 * files sat at `tags_method = 5` and stayed there, the one `rtng` row in the
 * whole meta layer belonging to a file that had moved for other reasons. The
 * defect was found by the cluster's acceptance review and not by a test, which
 * is what synthetic-only coverage of this field buys.
 *
 * 7 — the MPEG frame walk reports the sample rate and the channel count, which
 * it had always read and never carried out (task:2910). Nothing about the
 * reading changed; what is *recorded* about it did, which is exactly the case
 * entry 4 above is about and reaches a stored row the same way.
 *
 * Measured on the live base before the change: of the collection's mp3, **728**
 * had a codec and no channel count, because the reader answered the length and
 * nothing else — and `alreadyIs` cannot check a client's `maxAudioChannels`
 * against a number that is not there, so every one of those files was
 * transcoded whole rather than served: **2423.7 ms** cold against 10.3 ms for
 * the byte copy, on a request that needed no work at all. This bump is what
 * takes them back, and without it a rescan would re-read none of them.
 *
 * 8 — the MP4 reader names the codec its sound track's sample description
 * states (task:2910, the other half). Same shape of change as 5 and 7 and the
 * same reason: what is *recorded* about the file changed, and the 1425 `.m4a`
 * of this collection are the files it is about. Its own probe-method bump was
 * needed beside this one and for the reason recorded there.
 *
 * 9 — that same reader states the channel count and the sample rate beside the
 * codec, out of the same 28-byte header it was already standing on. Three
 * entries and three bumps in one afternoon is what working the same hole from
 * one end looks like; each is a real change to what a stored row says, and the
 * number is the only thing that can say so to a file that has not moved.
 *
 * 10 — the stage writes a second thing beside `file_tag`: `file_tag_first`, the
 * eight tags a listing shows, one row a file (task:2925). **This is the entry
 * that makes that row self-healing, and it was nearly not written.**
 *
 * The row is derived from `file_tag` and written by the stage, and the migration
 * that first filled it runs once. So a build that predates the row — a `git
 * revert`, which this runbook calls safe, or a scan still running the old code
 * while the daemon has been restarted onto the new — writes `file_tag` and no
 * row. Nothing brings that file back: this build sees `tags_method` already at
 * its own number and does not re-read it, and the migration will not run twice.
 * The file answers empty in all eight fields for good, which is the same defect
 * `task:2921` was: a client that normalises by ReplayGain, and a genre nobody is
 * shown.
 *
 * Measured rather than reasoned — a fixture read by the build at `0fa535a` and
 * then by this one: `tags 0 (0 files read)`, and the same bytes answering
 * `{"artist":"Slipknot","replayGain":{}}` under one build and
 * `{"genre":"Trance","artist":"VA","replayGain":{"trackGain":-6.62}}` under the
 * other.
 *
 * Raising this number is what closes it, and it closes it *for every future
 * mixed build* rather than for this one: a writer that does not know about the
 * row writes an older number, so the next scan of this build re-reads the file
 * and derives the row. The number is what the stage *writes*, not only what the
 * reader reads — entries 4, 7, 8 and 9 say the same thing, and this is the first
 * time the thing written was not a column of a row the stage already wrote.
 */
export const TAGS_METHOD = 10;

/** Does the file say this, at this offset? */
function magicAt(bytes: Uint8Array, at: number, magic: string): boolean {
  if (at + magic.length > bytes.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[at + i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Read whatever a file's own bytes say about it.
 *
 * Dispatched on the bytes rather than the extension: a `.flac` holding
 * something else is a normal thing for a collection to contain, and believing
 * the name over the file is how a reader ends up parsing nonsense.
 *
 * Never throws, by design. A format nothing here understands, a file with no
 * metadata blocks, and a half-copied download all answer the same way — with
 * nothing — because the caller is a scan over fifty thousand files and one
 * damaged one must not be able to stop it.
 */
export function readTags(bytes: Uint8Array): TagRead {
  if (magicAt(bytes, 0, 'fLaC')) return readFlac(bytes);

  // Ogg is dispatched on the same four bytes a reader synchronises on, and both
  // of its codecs — Vorbis and Opus — keep their tags in the same comment
  // packet, so one reader covers the two.
  if (magicAt(bytes, 0, 'OggS')) return readOgg(bytes);

  // At four, not zero: an MP4 opens with the length of the box that names it,
  // and `ftyp` is that box's type. Checking offset zero finds `ftyp` on nothing
  // and misses every m4a there is.
  if (magicAt(bytes, 4, 'ftyp')) return readMp4(bytes);

  if (magicAt(bytes, 0, 'ID3')) {
    const tag = readId3v2(bytes);
    // The tag states the names and the audio behind it states the length, and
    // both come out of the one read. An ID3 block is followed by MPEG frames in
    // every file this project meets, but nothing is assumed: if no frame can be
    // found the duration is simply unknown, exactly as before.
    const length = mpegLength(bytes, id3End(bytes));
    const withOlder = olderTag(tag, bytes);

    if (length === null) return withOlder;
    // Refused and unknown are different answers and the difference is carried
    // up: this one has something behind it to measure, and a reader that failed
    // to is worth telling someone who might not. What the frames turned out to
    // be is carried up with it, because the tag block above never knew — and
    // that is the whole of the audio format, not just its name: the rate and
    // the channel count are in the same header the walk read (task:2910).
    const format = {
      codec: length.codec,
      sampleRate: length.sampleRate,
      channels: length.channels,
    };
    return length.refused
      ? { ...withOlder, ...format, durationRefused: true }
      : { ...withOlder, ...format, durationMs: length.durationMs };
  }

  // The ID3v1 block, which is the *other* end of the file and has nothing to do
  // with whether a v2 block is at this one — a file may carry both, one, or
  // neither.
  const older = readId3v1(bytes);

  // A bare MPEG stream — no v2 tag block at all, which for a collection rip is
  // entirely ordinary and is not "a format nothing understands". An ID3v1 block
  // is what a rip of that age usually has instead.
  const bare = mpegLength(bytes, 0);
  if (bare === null) {
    // No frames found. With a v1 block the file is still understood — the
    // container is the tag block, and its names are read even though nothing
    // here can measure the audio. Without one there is nothing to say.
    return older === null
      ? noTags()
      : { ...noTags('id3v1'), tags: older.tags, refusals: recover(older.refusals), encoding: older.encoding };
  }

  // The same header the length came from, so all three fields arrive together
  // or not at all — see the note on the tag-block path above.
  const format = { sampleRate: bare.sampleRate, channels: bare.channels };
  const measured = bare.refused
    ? { ...noTags('mpeg', bare.codec), ...format, durationRefused: true }
    : { ...noTags('mpeg', bare.codec), ...format, durationMs: bare.durationMs };

  return older === null
    ? measured
    : {
        ...measured,
        // No v2 block here, so the v1 names are the only statement of them —
        // this is the container's own tag, not a fallback behind another.
        container: 'id3v1',
        tags: older.tags,
        refusals: recover(older.refusals),
        encoding: older.encoding,
      };
}

/** A field list or nothing at all, so an empty array never reaches a caller. */
function recover(refusals: string[]): string[] | undefined {
  return refusals.length === 0 ? undefined : refusals;
}

/**
 * The v2 reading, with the v1 block beside the same file attached as a fallback.
 *
 * `fallbackTags` rather than appended to `tags`, and the stage is what acts on
 * the difference — see `TagRead.fallbackTags` on why two blocks merged is a
 * collaboration this project would then invent. What the older block *refused*
 * is reported either way, because a field read and discarded is worth saying
 * whatever became of the tag around it.
 */
function olderTag(tag: TagRead, bytes: Uint8Array): TagRead {
  const older = readId3v1(bytes);
  if (older === null) return tag;

  // Only the names the newer block does not speak are weighted, because only
  // those are kept — the same rule the stage applies, and it has to be the same
  // one: the reader says how sure it is of the text that survives, and text
  // nobody uses is not the file's certainty. Weighting the whole older block
  // instead put 328 encoding findings on this collection, every one of them
  // about a title the v2 block had already answered for.
  const newerNames = new Set(tag.tags.map((one) => one.name));
  let encoding = tag.encoding;
  for (const item of older.tags) {
    if (newerNames.has(item.name)) continue;
    const verdict = older.verdicts.get(item.name);
    if (verdict !== undefined && (encoding === null || verdict.confidence < encoding.confidence)) {
      encoding = verdict;
    }
  }

  // Two blocks can each have refused something, and both are worth saying: the
  // v2 reader now reports frames it declined, so replacing rather than joining
  // would drop them the moment the file also carries a v1 block — which is most
  // of the files this applies to.
  return {
    ...tag,
    fallbackTags: older.tags,
    refusals: recover([...(tag.refusals ?? []), ...older.refusals]),
    encoding,
  };
}

/** Where the ID3v2 tag ends and the audio begins. */
function id3End(bytes: Uint8Array): number {
  const size =
    (((bytes[6] ?? 0) & 0x7f) << 21) |
    (((bytes[7] ?? 0) & 0x7f) << 14) |
    (((bytes[8] ?? 0) & 0x7f) << 7) |
    ((bytes[9] ?? 0) & 0x7f);
  // A footer, when present, is another ten bytes after the tag — and it sits
  // *before* the audio, so not counting it starts the search ten bytes early.
  const footer = (((bytes[5] ?? 0) & 0x10) !== 0 ? 10 : 0);
  return Math.min(10 + size + footer, bytes.length);
}
