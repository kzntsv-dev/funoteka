import type { WalkedFile } from '../scan/walk.ts';
import { classifyFile } from '../scan/kinds.ts';
import { compareNatural, stemOf } from '../util/names.ts';
import type { FolderNode } from './tree.ts';

export interface DiscPair {
  cue: WalkedFile;
  audio: WalkedFile;
}

/**
 * What a cue and the image it describes have in common, so that they pair.
 *
 * One convention, written two ways, both of them in the collection: ASOT ships
 * `… - Pulse.cue` beside `… - Pulse.mp3`, and the Maschina Kino rips ship
 * `… CD1.flac.cue` beside `… CD1.flac`. The first names its disc by stem. The
 * second leaves the audio's own extension on, and `stemOf` — which strips
 * exactly one extension, deliberately — reads that as a disc called
 * `… CD1.flac`, which shares a name with nothing. On MASHCD290 that cost every
 * disc past the first: the folder read as one album of two images, and 30
 * declared tracks became 2 (task:2708).
 *
 * So the extension comes off twice, and the second time only when what is left
 * is audio. `X.log.cue` is a cue about a log, not a disc called `X.log`, and
 * `Opiate FLAC.cue` — the rip that kept two cues and one image — is a name of
 * its own rather than a partner for `Opiate.flac`.
 *
 * Exported because there are two places that pair a cue with its image, and
 * they were reading the evidence differently: this module's flat-disc detector
 * read names from the walk, and `cue/engine.ts` read them from the database.
 * One of them understanding `X.flac.cue` and the other not is how MASHCD290
 * became a release of two discs of which only the first had tracks (task:2708).
 */
export function pairKey(file: { name: string; kind: string }): string {
  const named = stemOf(file.name);
  const audioRemoved = classifyFile(named) === 'audio' ? stemOf(named) : named;
  return audioRemoved.toLowerCase();
}

/**
 * A multi-disc release laid out flat: one image and one cue per disc, side by
 * side in a single folder, no subfolders at all.
 *
 * They pair by name — an image and a cue that name the same disc are one disc
 * (`pairKey` above has the two writings this has to read). Requiring exactly
 * one cue and one audio per name keeps a normal album out of this: `FLAC.cue` +
 * `WAV.cue` + `Opiate.flac` keys as `flac`, `wav`, `opiate`, none of them with
 * both, so it stays an ordinary album.
 *
 * Ordered the way a person would read the disc numbers, not lexicographically.
 */
export function flatDiscPairs(files: readonly WalkedFile[]): DiscPair[] {
  const byStem = new Map<string, { cues: WalkedFile[]; audio: WalkedFile[] }>();

  for (const file of files) {
    if (file.kind !== 'cue' && file.kind !== 'audio') continue;
    const stem = pairKey(file);
    const bucket = byStem.get(stem) ?? { cues: [], audio: [] };
    (file.kind === 'cue' ? bucket.cues : bucket.audio).push(file);
    byStem.set(stem, bucket);
  }

  const pairs: DiscPair[] = [];
  for (const bucket of byStem.values()) {
    const cue = bucket.cues[0];
    const audio = bucket.audio[0];
    if (bucket.cues.length === 1 && bucket.audio.length === 1 && cue !== undefined && audio !== undefined) {
      pairs.push({ cue, audio });
    }
  }

  return pairs.sort((a, b) => compareNatural(a.audio.name, b.audio.name));
}

/**
 * What a folder is in the library's own terms, independent of how the ripper
 * laid it out on disk.
 *
 * - `album`    holds playable files
 * - `disc`     one CD inside a box set
 * - `box`      a release spanning several discs
 * - `category` holds no audio of its own, only albums (genre, artist, …)
 * - `empty`    nothing playable anywhere beneath it
 */
export type FolderRole = 'album' | 'disc' | 'box' | 'category' | 'empty';

/** `CD1`, `CD 1`, `Disc 03`, `d2` — a folder whose whole name is a disc number. */
const DISC_NAME = /^(?:cd|disc|disk|d)\s*[._-]?\s*(\d{1,2})$/i;

/**
 * Does this folder name say it is a disc?
 *
 * Two shapes say yes, and both are real. A folder may be nothing *but* the
 * number — `CD1`, `d2` — which is `DISC_NAME`, anchored, because loose it would
 * read the `d1` of `1971 - d1` as a disc. Or it may lead with the number and
 * then name the record: `CD1 ● Группа крови`, how Maschina Records lays out a
 * Kino box. Not a whole name any more, but a disc just as plainly — and the
 * anchored read called nine of the ten Kino boxes plain category folders.
 *
 * `discMarker` below already read that shape in file names and cue titles; only
 * the folder question was still anchored. A box folder must keep answering no:
 * `…, MKK821CD, 3CD)` is a release, and both `\b` guards hold there — in
 * `MKK821CD` the `cd` follows a letter, and `3CD)` has no digits after it.
 */
export function isDiscName(name: string): boolean {
  const text = name.trim();
  return DISC_NAME.test(text) || discMarker(text) !== null;
}

/**
 * A folder named like a box set.
 *
 * Structural detection is preferred and runs first — `CD1`, `CD2`, or several
 * image+cue pairs, are far stronger evidence than a word. This only catches
 * what structure misses: a box whose discs are named after their albums
 * (`The Wall`, `Animals`) rather than numbered. Their disc numbers then come
 * from order, since the names carry none.
 *
 * There is deliberately no `Albums -> category` predicate. A folder holding
 * only albums is already a category structurally, so the name would add a
 * second rule that can never disagree with the first.
 */
const BOX_NAME = /^(?:box|box[ _-]?set|set)$/i;

export function isBoxName(name: string): boolean {
  return BOX_NAME.test(name.trim());
}

/**
 * How many discs a folder name says it holds, or null when it says nothing.
 *
 * `The Cure - Assemblage - 1991 (12CD FLAC)` states twelve and `(2CD)` two, and
 * that is the only evidence some boxes give: their discs are named after the
 * albums on them (`01 - Three Imaginary Boys (1979)`), not after their numbers,
 * so nothing structural marks them as discs at all.
 *
 * The digits have to stand on their own, the way a disc number does and for the
 * same reason. `MKK821CD` is a catalogue number, and reading `21CD` out of its
 * middle would make a box of a folder that never claimed one — so neither a
 * letter nor a digit may sit in front of the run.
 */
const STATED_DISCS = /(?<![\p{L}\p{N}])(\d+)\s*cd\b/iu;

export function statedDiscCount(name: string): number | null {
  const digits = STATED_DISCS.exec(name.trim())?.[1];
  return digits === undefined ? null : Number.parseInt(digits, 10);
}

/**
 * The number a disc folder states, or null when it states none.
 *
 * Anchored form first, then the marker — so `CD1 ● Альбом` numbers itself
 * instead of waiting on where it sits. A stated number outranks an ordinal, the
 * same way it does for a flat pair in `classify.ts`; a disc named after its
 * album states nothing and still falls to its position.
 */
export function discNumber(name: string): number | null {
  const text = name.trim();
  const anchored = DISC_NAME.exec(text)?.[1];
  if (anchored !== undefined) return Number.parseInt(anchored, 10);
  return discMarker(text);
}

/**
 * `Disc 1`, `[Disc 2]`, `(Disc 03)` — a marker written *anywhere* in a name.
 *
 * `DISC_NAME` above reads a folder called `CD1` and nothing else, which is the
 * right question for a folder. Everything else names a disc differently: the
 * marker sits in the middle, inside brackets, after the record's own name —
 * `Pink Floyd - The Wall [Disc 1].ape`, or a cue's `TITLE "The Wall [Disc 1]"`.
 * Requiring it at the start found nothing, and both discs of the Wall took their
 * number from sort order instead, which happened to put the second disc first.
 *
 * No bare `d`, unlike `DISC_NAME`: anchored to a whole folder name `d2` is
 * unambiguous, but loose in a name it would match any word ending in `d` that
 * runs into a digit.
 *
 * The number has to stand on its own, and the lookahead is what makes it. A
 * disc number is one number; a catalogue number is a run of them, and the head
 * of a run is not a marker. `MEL CD 60 00842` is Melodiya's — the 842nd release
 * of the 60 series — and reading `CD 60` out of it turned the twenty
 * independent CDs of one series folder into twenty discs of a single box
 * ([[task:2713]]) while giving every one of them `disc_number = 60`
 * ([[task:2715]]). A name that follows the number costs nothing: `CD 2 - Disk
 * Union Bonus` and `The Wall [1994 Remaster](Disc 2)` are still discs.
 */
const DISC_MARKER = /\b(?:disc|disk|cd)\s*[._-]?\s*(\d{1,2})\b(?!\s*\d)/i;

export function discMarker(name: string): number | null {
  const digits = DISC_MARKER.exec(name.trim())?.[1];
  return digits === undefined ? null : Number.parseInt(digits, 10);
}

/**
 * Where the marker sits in a name, or `-1` when the name states none.
 *
 * The index rather than the number, because what a caller wants it for is
 * everything *in front* of the marker: two folders that agree up to there name
 * one set, whatever their catalogue numbers say after it.
 */
export function discMarkerIndex(name: string): number {
  return DISC_MARKER.exec(name.trim())?.index ?? -1;
}

function hasAudio(node: FolderNode): boolean {
  return node.files.some((file) => file.kind === 'audio');
}

function hasAudioDeep(node: FolderNode): boolean {
  return hasAudio(node) || node.children.some(hasAudioDeep);
}

/**
 * Assign a role to every node, children first.
 *
 * Two rules are worth stating outright, because both were chosen to avoid
 * inventing structure that is not there:
 *
 *   - A folder needs *at least two* audio-bearing CD folders beneath it to be a
 *     box. One `CD1` is a folder name, not a release, and treating it as one
 *     would split albums that are perfectly whole.
 *   - Only disc folders that actually contain audio count. An empty `CD2`
 *     left over from a bad rip must not turn its parent into a box.
 *   - **Every** audio-bearing child has to be a disc — two is necessary and not
 *     sufficient. A shelf of albums that happens to hold one two-disc set is not
 *     a box: treating it as one made the artist's folder a release and every
 *     album in it a disc, and sixteen records collapsed into two. The check
 *     below is where that is decided, and the cost of getting it wrong is
 *     invisible until a client is shown records rather than album rows.
 *
 * Audio in a folder wins over anything below it: the files are the truth.
 */
export function assignRoles(node: FolderNode): FolderRole {
  for (const child of node.children) assignRoles(child);

  // A multi-disc release with no subfolders: several image+cue pairs sitting
  // together. Without this the folder reads as one album holding a few
  // unrelated files, and every disc past the first loses its tracks entirely.
  if (flatDiscPairs(node.files).length >= 2) {
    node.role = 'box';
    return node.role;
  }

  // Direct audio only. A `CD1` that merely *contains* an album folder is a
  // wrapper, not a disc: promoting it would give a disc album with no tracks of
  // its own, and leave the real album as one more row underneath it.
  //
  // **Every audio-bearing child has to be a disc**, not merely two of them. A
  // shelf of albums that happens to hold one two-disc set is the case that
  // decides it: `Slipknot AAC 320` holds eight records, two of which are named
  // `2014 - .5 The Gray Chapter - CD 1 [JP - WPCR-16130]` and `… CD 2 …`. With
  // the count alone the artist's folder became a box, all eight became *discs*
  // of it, and — once the API started answering with records rather than album
  // rows — sixteen records collapsed into two albums called `Slipknot AAC 320`
  // and `Slipknot ALAC`. Measured on the live collection; the operator saw the
  // lost releases before the cause.
  //
  // A real box is unharmed: its audio-bearing children are exactly its discs,
  // and an `Artwork` or `Scans` folder beside them bears none.
  const discChildren = node.children.filter((child) => isDiscName(child.name) && hasAudio(child));
  const albumsAlongside = node.children.filter((child) => hasAudio(child) && !isDiscName(child.name));
  if (discChildren.length >= 2 && albumsAlongside.length === 0) {
    for (const child of discChildren) child.role = 'disc';
    node.role = 'box';
    return node.role;
  }

  // Structural detection saw only "a folder of albums". If the folder is named
  // like a box and holds several, it is one — the discs just are not numbered.
  // Direct audio again: promoting a wrapper folder to a disc would leave the
  // disc empty and the real album stranded a level below it.
  const playableChildren = node.children.filter(hasAudio);
  if (isBoxName(node.name) && playableChildren.length >= 2) {
    for (const child of playableChildren) child.role = 'disc';
    node.role = 'box';
    return node.role;
  }

  // A box that states how many discs it holds but does not number them.
  //
  // `The Cure - Assemblage - 1991 (12CD FLAC)` lays its twelve out as
  // `01 - Three Imaginary Boys (1979)`, `02 - Boys Don't Cry (1980)`, … — no
  // marker on any of them, so the structural rule above reads twelve albums in
  // a folder and answers `category`. The box then does not exist as a record,
  // and every disc is shown as one of its own with the box's name appended to
  // it: nine records named `X (Assemblage - 1991 (12CD FLAC))`.
  //
  // The count is the collector's own statement, and it is *checked* rather than
  // trusted — a folder holding a different number of records than it claims is
  // not a box. That check is the whole safety of the rule: without it, this
  // says "the name mentions CDs", and a shelf of rips under a folder that
  // happens to say `2CD` becomes a release whose every record is a disc of it.
  const stated = statedDiscCount(node.name);
  if (stated !== null && stated >= 2) {
    const records = node.children.filter(hasAudio);
    if (records.length === stated && records.every((child) => !isDiscName(child.name))) {
      for (const child of records) child.role = 'disc';
      node.role = 'box';
      return node.role;
    }
  }

  if (hasAudio(node)) {
    node.role = 'album';
    return node.role;
  }

  if (node.children.some(hasAudioDeep)) {
    node.role = 'category';
    return node.role;
  }

  node.role = 'empty';
  return node.role;
}
