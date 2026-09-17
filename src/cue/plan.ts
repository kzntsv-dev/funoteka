import type { WalkedFile } from '../scan/walk.ts';
import { compareNatural, folderOf } from '../util/names.ts';
import { isSiteName } from '../text/site-name.ts';
import { audioNamedByCue } from './match.ts';
import type { CueDocument, CueTrack } from './parse.ts';
import { titleFromFileName } from './track-name.ts';

/**
 * How a folder becomes tracks. The three forms the contract names:
 *
 * - `image-cue`  one audio file that is the whole album, cut into segments by
 *                the cue's indexes
 * - `tracks-cue` the audio files *are* the tracks; the cue only supplies names
 * - `tracks-only` the audio files are the tracks and nothing describes them
 *
 * Two decisions the contract left open, settled here deliberately:
 *
 * **The whole-file projection is not a track row.** The contract asks for
 * "split (N tracks) + whole". The N segments are tracks; the whole is the
 * `file` row the segments all point at, and it is already there, so nothing is
 * lost by not duplicating it into the track list — which would instead show
 * every cue album twice over. A reader wanting the whole plays the file.
 *
 * **A pregap ends the track before it.** Where a cue declares `INDEX 00` and
 * then `INDEX 01`, the audio between them belongs to the *previous* track's
 * segment, because segments run from one `INDEX 01` to the next. This is how
 * cue splitters conventionally cut an image, and it is a decision rather than
 * an oversight: the alternative would put those seconds at the head of every
 * track instead.
 */
export type AlbumShape = 'image-cue' | 'tracks-cue' | 'tracks-only';

export interface PlanIssue {
  kind: string;
  detail: string;
  /**
   * `warn` unless the plan says otherwise.
   *
   * Most of what reaches here is a problem the reader may need to act on — a
   * cue that names a different number of tracks than the folder holds, a segment
   * with no end. Some of it is not: a normalisation that is worth *saying* and
   * worth nothing *doing*. Calling both a warning teaches a reader to skim
   * warnings, so the plan is allowed to distinguish them.
   */
  severity?: 'info' | 'warn';
}

export interface PlannedTrack {
  ordinal: number;
  title: string | null;
  /**
   * Which of the three sources stated `title` — or null where none did, which
   * includes the case of a source that spoke and was rejected as a ripper's
   * marker. A value has to say whether it is knowledge or a guess, and a title
   * read off a file name is the guess this records.
   */
  titleSource: 'cue' | 'tag' | 'name' | null;
  performer: string | null;
  /** The audio file this track plays from. */
  file: WalkedFile;
  /** Null for a whole-file track; the time window for a cue split. */
  segmentStartMs: number | null;
  segmentEndMs: number | null;
}

export interface AlbumPlan {
  shape: AlbumShape;
  tracks: PlannedTrack[];
  issues: PlanIssue[];
}

export interface PlanDeps {
  /**
   * Real duration of an audio file, or null if it could not be probed. Needed
   * only for the final segment of a split — a cue cannot bound its own last
   * track, because there is no following index to end it.
   */
  durationMs?: (file: WalkedFile) => number | null;
  /**
   * The title the file's own *tag* states, or null. One of the two ways a file
   * speaks for itself; the other is its name, which needs no dependency because
   * the file already carries it. Asked only where the cue has nothing to say —
   * see the note on priority in `planAlbum`.
   */
  titleOf?: (file: WalkedFile) => string | null;
  /**
   * The album's own folder name — the whole of the evidence a file name is read
   * against, and the reason this is a dependency rather than something the plan
   * could derive: an album that *is* its root has no folder name in the file
   * list at all, and only the caller knows the root it was walked from.
   */
  albumName?: string | null;
  /**
   * The cue's own root-relative path — the directory its `FILE` references are
   * written from, and so the only place they can be resolved against. A cue
   * sitting above the audio it describes (`FILE "../x.flac"`) is a real layout,
   * and resolving from anywhere else would look for the file in the one place
   * it is not.
   *
   * Absent means the cue is taken to sit beside the audio it is planned with,
   * which is all a caller that does not say can mean.
   */
  cuePath?: string | null;
}

// Digit-aware, so `2 - x.flac` precedes `10 - y.flac`. Lexicographic order put
// the tenth track second and handed its name to the wrong file.
function byName(a: WalkedFile, b: WalkedFile): number {
  return compareNatural(a.name, b.name);
}

/**
 * Make ordinals unique within an album without discarding the cue's numbering.
 *
 * Cues repeat track numbers — a spanning cue restarts at TRACK 01 per FILE, and
 * broken rips simply duplicate one. The album's track list is unique by
 * ordinal, so a repeat would abort the insert and take the scan with it. The
 * first claim on a number keeps it; later ones fall to the next free slot.
 */
function uniqueOrdinals(ordinals: readonly number[]): number[] {
  const used = new Set<number>();

  return ordinals.map((ordinal, index) => {
    if (!used.has(ordinal)) {
      used.add(ordinal);
      return ordinal;
    }
    let candidate = index + 1;
    while (used.has(candidate)) candidate += 1;
    used.add(candidate);
    return candidate;
  });
}

/**
 * A ripper's marker standing where a track's name should be.
 *
 * EAC writes `TITLE "(empty)"` for a division of the disc that carries no name —
 * Undertow's tracks 10..68, the silence before its hidden track. The division is
 * real, and stays: it has an INDEX 01, so it is part of the disc's structure.
 * The *string* is not a name, and a client showing `(empty)` is showing what the
 * ripper wrote in place of one.
 *
 * Deliberately short, and matched whole. A missing marker leaves a word visible
 * in the dump, which costs nothing; an invented one erases a real title —
 * `Empty Spaces` is a song, and any containment rule kills it. `(data track)`
 * cannot arrive from a cue (`planAlbum` reads AUDIO tracks only) but a tagged
 * file can carry it, and the list is the vocabulary rather than one source.
 *
 * The marker becomes null rather than a friendlier stand-in like `[silence]`.
 * Inventing one would have the layer assert a meaning the ripper never stated —
 * `(empty)` does not say *why* the division has no name — and null already means
 * "no name here", which is the thing that is true.
 *
 * Nothing is lost by dropping it. `cue_track` keeps the parsed value verbatim
 * and a tag's own text stays in `file_tag`, so this is the projection deciding
 * what may be *shown* as a name — the planner's business, not the parser's,
 * whose rule is that what was written is what came out.
 *
 * Named for the ripper rather than for `placeholder`, which this codebase
 * already uses for a different question entirely: whether an album's title
 * source is weak enough to be overwritten (`applyAlbumTitle` in `cue/engine.ts`).
 */
const RIPPER_MARKER = /^\((?:empty|silence|untitled|data track)\)$/i;

function dropRipperMarker(raw: string | null): string | null {
  if (raw === null) return null;
  return RIPPER_MARKER.test(raw.trim()) ? null : raw;
}

export function planAlbum(
  audioFiles: readonly WalkedFile[],
  cue: CueDocument | null,
  deps: PlanDeps = {},
): AlbumPlan {
  const issues: PlanIssue[] = [];
  /**
   * Track titles a cue stated that were a rip's source rather than a name.
   *
   * Counted by `titleFor` and reported once, because a rip names every track of
   * the disc after the same host and one finding per track would be the same
   * sentence four times (task:2756).
   */
  let declinedTrackTitles = 0;

  /** One finding for the disc, not one per track — see `declinedTrackTitles`. */
  const reportDeclinedTitles = (): void => {
    if (declinedTrackTitles === 0) return;
    issues.push({
      kind: 'track-title-cue-declined',
      detail: `${declinedTrackTitles} track title(s) named the rip's source rather than the track — the file's own tag, and then the name it carries, was used instead`,
    });
  };
  const audio = [...audioFiles].sort(byName);
  const cueTracks = (cue?.tracks ?? []).filter((t) => t.type === 'AUDIO');
  const albumPerformer = cue?.performer ?? null;

  // The cue as the matcher sees it, so its references resolve the way the
  // matcher resolved them. Only the directory of `relPath` is ever read —
  // `resolveRef` splits the folder off and ignores the name — so the file name
  // here carries nothing and is named for what it is.
  const cueFolder =
    deps.cuePath != null ? folderOf(deps.cuePath) : (audio[0]?.folderRelPath ?? '');
  const cueCandidate = cue === null ? null : { relPath: `${cueFolder}/cue.cue`, doc: cue };

  /**
   * The name the file's own bytes state — its tag, then its name.
   *
   * Sources two and three of the priority chain: a cue is a document about
   * *this* album and speaks with authority, while the file only speaks for
   * itself, so both are asked only where the cue has already declined to name a
   * track — never as a tie-break, and never for an image, where one file covers
   * every track and its TITLE describes the file rather than track 7.
   *
   * Between the two, the tag wins: it is a statement somebody made about the
   * track, where the name is a hint the filesystem happens to carry. But a name
   * beats an empty cell, which is the whole of the untagged, folder-organized
   * part of a collection (`track-name.ts` holds that rule and its evidence).
   */
  const titleOf = (file: WalkedFile): string | null => deps.titleOf?.(file) ?? null;
  const nameOf = (file: WalkedFile): string => titleFromFileName(file.name, deps.albumName ?? null);

  // How many names the ripper had marked rather than written. Counted here and
  // reported below, because the projection is the only place that knows: the
  // value it drops is not wrong, it is absent, and a dump showing `(untitled)`
  // where the cue said `(empty)` has no way to say why without this.
  let markers = 0;
  const named = (raw: string | null): string | null => {
    const title = dropRipperMarker(raw);
    if (title === null && raw !== null && raw.trim() !== '') markers += 1;
    return title;
  };

  /** Says how many names were markers, once the album's tracks are known. */
  const reportMarkers = (): void => {
    if (markers === 0) return;
    issues.push({
      kind: 'ripper-marker-titles',
      detail: `${markers} track(s) were marked rather than named by the ripper and are left unnamed`,
      severity: 'info',
    });
  };

  /**
   * What one source says, and whether it can be shown as a name.
   *
   * A source that *spoke* has answered the question even when its answer is a
   * ripper's marker: `(empty)` says this division of the disc has no name, and
   * the title is then null — which is what "no name here" means. Null here is
   * therefore two different things, and the caller below reads it as both.
   */
  const claim = (
    raw: string | null | undefined,
    source: PlannedTrack['titleSource'],
  ): Pick<PlannedTrack, 'title' | 'titleSource'> | null => {
    if (raw === null || raw === undefined) return null;
    const title = named(raw);
    return { title, titleSource: title === null ? null : source };
  };

  /** A track no source names at all — the shape `claim` does not produce. */
  const UNNAMED: Pick<PlannedTrack, 'title' | 'titleSource'> = { title: null, titleSource: null };

  /**
   * The track's name, and which source stated it — the first source to speak.
   *
   * A marker ends the chain rather than falling through it: asking the tag, or
   * the file name, after the ripper has said there is no name would dress the
   * hole up rather than fill it.
   */
  const titleFor = (
    file: WalkedFile,
    fromCue: string | null | undefined,
  ): Pick<PlannedTrack, 'title' | 'titleSource'> => {
    // A cue that names where the rip came from has not named the track. That is
    // the rule the record's own name already follows — `text/site-name.ts`, and
    // the album path refuses it on both the cue and the tag — applied one level
    // down, where it was missing: `TITLE "lossless-galaxy.ru"` named every track
    // of the rip (task:2756, and task:2725 for the record).
    //
    // Skipped rather than refused outright, so the chain falls through to the
    // tag and then to the file's own name, which is exactly what "no cue named
    // this track" already means here. The refusal is counted, and reported once
    // per plan below: four tracks of one rip carry the same host, and four
    // findings would say the same thing four times.
    if (fromCue !== null && fromCue !== undefined && isSiteName(fromCue)) {
      declinedTrackTitles += 1;
      fromCue = null;
    }

    // Asked one at a time, not collected first: a source below the one that
    // answered is never consulted, and the tag reader is a database lookup that
    // a cue-named track must not pay for.
    const sources: [() => string | null | undefined, PlannedTrack['titleSource']][] = [
      [() => fromCue, 'cue'],
      [() => titleOf(file), 'tag'],
      [() => nameOf(file), 'name'],
    ];

    for (const [ask, source] of sources) {
      const claimed = claim(ask(), source);
      if (claimed !== null) return claimed;
    }

    return UNNAMED;
  };

  const untimed = cueTracks.filter((t) => t.index01Ms === null);
  if (untimed.length > 0) {
    issues.push({
      kind: 'track-without-index',
      detail: `${untimed.length} track(s) declare no INDEX 01 and were left out`,
    });
  }

  const timed = cueTracks
    .filter((t): t is CueTrack & { index01Ms: number } => t.index01Ms !== null)
    .sort((a, b) => a.index01Ms - b.index01Ms);

  const image = audio[0];

  // One file, several tracks: the cue describes an image, so the album lives
  // inside it as time windows rather than as files.
  if (image !== undefined && audio.length === 1 && timed.length > 1) {
    const duration = deps.durationMs?.(image) ?? null;

    const ordinals = uniqueOrdinals(timed.map((cueTrack) => cueTrack.ordinal));

    const tracks: PlannedTrack[] = timed.map((cueTrack, index) => ({
      ordinal: ordinals[index] ?? index + 1,
      // The cue, and nothing else. Every segment plays from this one file, so
      // the only title that describes a *track* here is the one the cue wrote
      // next to it — see the note on priority above.
      ...(claim(cueTrack.title, 'cue') ?? UNNAMED),
      performer: cueTrack.performer ?? albumPerformer,
      file: image,
      segmentStartMs: cueTrack.index01Ms,
      segmentEndMs: timed[index + 1]?.index01Ms ?? duration,
    }));

    reportMarkers();

    if (duration === null) {
      issues.push({
        kind: 'unbounded-last-segment',
        detail: `${image.name}: duration unknown, the closing track has no end`,
      });
    }

    return { shape: 'image-cue', tracks, issues };
  }

  if (cueCandidate !== null && cueTracks.length > 0) {
    // A cue earns the right to name these files only if it plausibly describes
    // them. A folder can hold several discs ripped flat, each with its own cue;
    // the folder is one album by identity, but no single cue covers it. Taking
    // disc 1's titles anyway would put confidently wrong words on discs 2 and
    // 3, which is worse than leaving them unnamed.
    //
    // "Describes them" is a reading of the cue's own `FILE` references, and a
    // count is not a reading of anything. A cue naming one file under two TRACK
    // tags has the same count as a folder holding two files, so counting handed
    // the second file a title the cue never wrote for it, threw away the name
    // the file carried, and recorded the guess under `title_source = 'cue'` —
    // the value the schema reserves for a cue that *does* describe these files
    // (task:2723). The same false knowledge as task:2712, by the other door.
    const named = audioNamedByCue(cueCandidate, audio);
    const countsAgree = cueTracks.length === audio.length;
    const describesTheseFiles = countsAgree && named.length === audio.length;

    if (!countsAgree) {
      issues.push({
        kind: 'track-count-mismatch',
        detail: `cue declares ${cueTracks.length} tracks, folder holds ${audio.length} audio files — cue names were not applied`,
      });
    } else if (!describesTheseFiles) {
      issues.push({
        kind: 'cue-describes-other-files',
        detail: `cue's FILE tags name ${named.length} of the folder's ${audio.length} audio files — cue names were not applied`,
      });
    }

    const cueOrdinals = describesTheseFiles
      ? uniqueOrdinals(cueTracks.map((track) => track.ordinal))
      : [];

    const tracks: PlannedTrack[] = audio.map((file, index) => {
      const cueTrack = describesTheseFiles ? cueTracks[index] : undefined;
      return {
        ordinal: cueOrdinals[index] ?? index + 1,
        // The cue names the track where it names it, and a TRACK with no
        // TITLE is not a refusal to speak — it is silence, and the file's own
        // tag, then its own name, is a better answer than an empty cell. When
        // the cue does not describe these files at all, none of it is applied
        // and the file is the only thing left.
        ...titleFor(file, cueTrack?.title),
        performer: cueTrack?.performer ?? (describesTheseFiles ? albumPerformer : null),
        file,
        segmentStartMs: null,
        segmentEndMs: null,
      };
    });

    reportDeclinedTitles();
    reportMarkers();

    return { shape: 'tracks-cue', tracks, issues };
  }

  const tracks: PlannedTrack[] = audio.map((file, index) => ({
    ordinal: index + 1,
    // Nothing describes this folder, so the file is the only thing that can
    // name itself — its tag first, then the name it carries.
    ...titleFor(file, null),
    performer: albumPerformer,
    file,
    segmentStartMs: null,
    segmentEndMs: null,
  }));

  reportMarkers();

  return { shape: 'tracks-only', tracks, issues };
}
