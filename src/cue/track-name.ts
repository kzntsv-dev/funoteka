/**
 * The title a file's own name states, for a track nothing else names.
 *
 * A collection is not all tags. One of its parts arrives folder-organized with
 * a `readme` and nothing else (requirements:39 §1, the Kroogi sample), and the
 * name of the file is then the only witness left. The contract's chain is cue →
 * tag → *this*: a document about the album speaks with authority, a tag speaks
 * for its own file, and a file name is the weakest of the three — which is why
 * it is asked last and never overrides either.
 *
 * ## What a name carries that is not the track
 *
 * Three things, and each is dropped only on evidence:
 *
 *   - **The track number.** `01-`, `01. `, `01 - ` — a leading count, never part
 *     of a title. Dropped on sight, because nothing else in a file name looks
 *     like it: no title in these collections opens with two digits and a dot.
 *   - **The artist.** The scene writes `Artist - Title` in front of every track,
 *     and a split record gives each track a *different* one, so the album's own
 *     artist cannot find these. The album's folder **name** can: it lists every
 *     player on the record, and a field whose words all appear there is the
 *     album's, not the track's.
 *   - **The release group.** `-kroogi` glued to the tail is the same class as
 *     `-Kroogi.com` in the folder name — where the rip came from, not what the
 *     record is.
 *
 * Two rules were narrowed by measuring the rule against the collection's 850
 * audio files (88 fields dropped, all of them credits: `Cock E.S.P.` ×45,
 * `Emil Hagstrom` ×8, `Suffering Bastard` ×7, …), and both narrowings answer a
 * real file:
 *
 *   - **Only a *leading* field is a field.** `Кино - Спасём мир (MASHCD-148)`
 *     sits in `1986 ● Концерт «Спасём мир» …`, and the folder agrees with its
 *     tail word for word. Dropping a trailing ` - ` field because the folder
 *     agrees leaves `Кино` as the title of a song called `Кино - Спасём мир`:
 *     an album named after the piece it holds is the ordinary case, not the
 *     exception, so the tail of a name is never a field.
 *   - **The scene's own marks need the scene's written separator.** `_` for a
 *     space and a glued `-site` tail are conventions of one layout, and `_-_`
 *     is where that layout declares itself — the same "written, not incidental"
 *     test `SCENE` in `classify/folder-name.ts` rests on. Without it,
 *     `Amp-Destroyer` is a hyphen in a title, and `my_cool_track` keeps its
 *     underscore.
 *
 * Nothing is invented. A name written in lower case stays in lower case: that
 * is what the file says, and a title with its capitals belongs to a source that
 * has them (a tag, or the `readme` tracklist — [[task:2710]]).
 */

import { stemOf } from '../util/names.ts';

/** `01-`, `01.`, `01 - ` — a leading count and the separator after it. */
const TRACK_NUMBER = /^\d{1,2}\s*[.\-_)\]]\s*/;

/** The separator the scene layout writes between artist and title. */
const SCENE_SEPARATOR = '_-_';

/**
 * A word glued to the tail by a dash — `archangelsk-kroogi`.
 *
 * The lookbehind is the whole of the rule: a dash with a space in front of it
 * opens a field, and a field is never the release group it was measured against.
 * Letters, digits, marks and dots only, so `(MASHCD-148)` — a bracket and a
 * number — cannot be read as one.
 */
const GLUED_TAIL = /(?<=\S)-([\p{L}\p{N}\p{M}.]+)$/u;

/**
 * The words a name is made of, folded for comparison.
 *
 * Unicode-aware for the same reason `artistName` is: `Кино` has to survive, and
 * `\p{M}` matters because a tree ripped on macOS stores `Björk` decomposed.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');
}

/**
 * The title this file's name states.
 *
 * `albumName` is the album's own folder name — the whole of the external
 * evidence, and null when nothing supplies one. Without it the file still
 * speaks; it is simply not corroborated, so no field of it is claimed as the
 * album's.
 */
export function titleFromFileName(fileName: string, albumName: string | null): string {
  const stem = stemOf(fileName);

  // Both of the scene's marks stand or fall with its separator, so it is read
  // once, before the folding that loses it.
  const scene = stem.includes(SCENE_SEPARATOR);
  const rest = scene ? stem.replace(/_/g, ' ') : stem;

  const evidence = new Set(words(albumName ?? ''));
  const stated = (field: string): boolean => {
    const found = words(field);
    return found.length > 0 && found.every((word) => evidence.has(word));
  };

  let text = rest.trim();

  // The number goes first: it is the one mark that is proof in itself, and the
  // fields below are read on what is left of the name.
  const number = TRACK_NUMBER.exec(text);
  if (number !== null && number[0].length < text.length) text = text.slice(number[0].length).trim();

  // Never the whole name: a file called `01.mp3` states a number and nothing
  // else, and eating it would leave no title at all.
  let fields = text.split(/\s+-\s+/);
  while (fields.length > 1 && stated(fields[0] ?? '') && fields.slice(1).join(' - ').trim() !== '') {
    fields = fields.slice(1);
  }
  text = fields.join(' - ');

  // The scene's tail: the dash is glued to the word, so it never opened a field.
  const glued = scene ? GLUED_TAIL.exec(text) : null;
  if (glued !== null && stated(glued[1] ?? '') && text.slice(0, glued.index).trim() !== '') {
    text = text.slice(0, glued.index).trim();
  }

  // The underscore fold is a rewrite of somebody's name, so the spacing it
  // leaves behind is this module's to tidy. Nothing else is collapsed: a double
  // space in a name nobody folded is what was written.
  if (scene) text = text.replace(/\s+/g, ' ');

  return text === '' ? stem : text;
}
