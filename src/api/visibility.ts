import type { ServerConfig } from './config.ts';

/**
 * What a request is allowed to be shown.
 *
 * The junk filter is one question with two answers and a switch between them
 * (requirements:47 §11), and this is the whole of the switch: every listing the
 * server offers asks this first, so there is one place that decides and no
 * listing that decides for itself.
 *
 * `records` is the default and it is what a client gets without asking: what the
 * scanner found and does not expect anyone to want to see is kept out of the way.
 * `all` is what the operator flips to — to check the rule did not overreach, to
 * find what it hid, and to look at a folder before marking it.
 *
 * **Two ways to ask, and they are not equals.** `FUNOTEKA_SHOW_JUNK` is the
 * server's own setting and it belongs to whoever runs the box: the switch the
 * contract means. The `showJunk` query parameter is the same switch for one
 * request, which is what a person wants while standing in front of a client —
 * and it deliberately wins over the setting, because the more specific request
 * is the more recent one. A parameter that was absent is not an answer, so a
 * server configured to show everything still hides nothing from a client that
 * says nothing.
 */
export type Visibility = 'records' | 'all';

/**
 * The parameter a client may set, spelled here so that the one place which reads
 * it and the one place that documents it cannot disagree.
 *
 * Not a Subsonic method and not an OpenSubsonic extension: the protocol has no
 * way to ask this, and inventing a field inside a response would be answering a
 * question no client asked. A parameter is what an operator can put in a browser
 * address bar, which is the whole of what it is for.
 */
export const SHOW_JUNK = 'showJunk';

/** Whether the request asked to be shown everything, by parameter or by setting. */
export function visibilityOf(query: URLSearchParams, config: ServerConfig): Visibility {
  const asked = query.get(SHOW_JUNK);
  if (asked !== null && asked !== '') return isOn(asked) ? 'all' : 'records';
  return config.showJunk ? 'all' : 'records';
}

/** Whether a value that was given reads as a yes — the reading `config.ts` keeps. */
function isOn(value: string): boolean {
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}
