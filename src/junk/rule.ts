/**
 * What in the collection is not a record.
 *
 * The contract asks for a junk filter — a label, a hiding, a switch, and an
 * allow/block edit — and never a deletion (requirements:47 §11). This module is
 * the label: the one place that decides whether a folder is a record, so the
 * scan that writes the label and the command that re-derives it after a hand
 * edit cannot come to two answers.
 *
 * **The rule is about the folder, not about the music.** Nothing here reads a
 * title, a tag, a bitrate or an artist, and that is deliberate: a rule that
 * judged the music would be this server deciding taste, and the collection is
 * the operator's. What it judges is whether the folder is a folder of music at
 * all — which is a question about the disk, and has an answer.
 */

/** A file, as much of one as the rule needs: what the scanner called it. */
export interface Counted {
  kind: string;
}

/**
 * How many files a record may hold that are neither the music nor the paperwork.
 *
 * A record folder holds audio, the artwork that came with it, and the notes —
 * a cue, an `.nfo`, a `.log`. Everything else is `kind = 'other'`. Measured on
 * the live collection, the albums that *are* records hold at most **four** of
 * those: an enhanced CD's data track (`AUTORUN.INF`, `OSC.EXE`, `LINKIN.MOV`,
 * `JACKET01.00J` — the sixteen Linkin Park and Cure pressings that carry one)
 * and a `foo_dr.txt` beside a rip.
 */
export const STRANGERS_FLOOR = 5;

/**
 * How far the music may be outnumbered before the folder stops being about it.
 *
 * **The count alone was not enough, and the live check is what said so.** With a
 * bare floor of five the rule hid `Standalone-Music Access Virus TI` — one demo
 * track, a Virus TI patch bank (`.lib`, `.mid`, `.syx`), a readme and a patch
 * list, which is a single with its patch data and not a dumping ground. The
 * floor separates a record's paperwork from a rubbish heap; it does not
 * separate *a record with unusual paperwork* from a heap, and no count can,
 * because a heap has no ceiling.
 *
 * What separates them is the shape, and it is the same measurement read twice:

 * | folder | not music | music | ratio |
 * |---|---|---|---|
 * | `Downloads` (the root itself) | 199 | 9 | 22.1 |
 * | `Telegram Desktop` | 98 | 7 | 14.0 |
 * | `Standalone-Music Access Virus TI` | 6 | 1 | 6.0 |
 * | every record in the collection | ≤ 4 | ≥ 1 | ≤ 1.0 |
 *
 * A record's companions scale with the record; a dumping ground accumulates with
 * no relation to the music that happens to be in it. Ten is the number that
 * falls between 6.0 and 14.0, and the *statement* is what makes the position
 * defensible rather than the arithmetic: **a folder holding ten files that are
 * not music for every one that is is not a folder of music.**
 *
 * The two conditions are kept together and not folded into the ratio alone: a
 * single track beside eleven stray files is a ratio of eleven, and calling that
 * a dumping ground on the strength of one song is the sort of guess this rule
 * exists to avoid.
 */
export const STRANGERS_PER_SONG = 10;

/** What a person can say about a folder, and the whole of what `junk_mark` holds. */
export type Verdict = 'junk' | 'trust';

/** The files of a folder that are neither the music nor the paperwork. */
export function strangers(files: readonly Counted[]): number {
  return files.filter((file) => file.kind === 'other').length;
}

/** The files of a folder that are music. */
export function songs(files: readonly Counted[]): number {
  return files.filter((file) => file.kind === 'audio').length;
}

/**
 * Whether a folder is a record, and why not.
 *
 * The mark wins where there is one. That is the whole of the allow/block edit:
 * `trust` on a folder the rule would hide, `junk` on one it would keep — and the
 * reason it carries says which of the two happened, because a hidden album that
 * cannot say why is a hidden album nobody can argue with.
 *
 * The reason states both numbers rather than only the one that tripped the rule.
 * A reader checking the filter's work is asking "was this folder mostly not
 * music", and `6 against 1` answers it where `6 files that are not music` leaves
 * them to guess at the denominator — the guess being the thing this rule was
 * wrong about once already.
 */
export function junkReason(files: readonly Counted[], mark?: Verdict): string | null {
  if (mark === 'trust') return null;
  if (mark === 'junk') return 'marked junk by hand';

  const strangers_ = strangers(files);
  if (strangers_ < STRANGERS_FLOOR) return null;

  const songs_ = songs(files);
  if (strangers_ <= STRANGERS_PER_SONG * songs_) return null;

  return `${strangers_} files that are not music, against ${songs_} that are`;
}
