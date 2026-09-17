/**
 * A string a rip carries that names where it came from, not what it is.
 *
 * Rippers fill tags in with the site they published on, and `ALBUM` is one of
 * the tags they fill in with it: four of the Kino boxes carry
 * `lossless-galaxy.ru`, and every disc of each box agrees on it, so no
 * agreement check can tell it apart from a name. It is the same finding as
 * `-Kroogi.com` glued to a folder name (`classify/folder-name.ts`) and the
 * glued tail `cue/track-name.ts` drops, and it wants the same answer: it
 * describes the download.
 *
 * ## Why the whole value has to be the host
 *
 * A host is written the way a host is written, and that is the whole of the
 * evidence used here. The pattern is lower case throughout, so a title with a
 * capital in it never matches; it has no room for a space, so `Vol. 2` never
 * matches and `Cock E.S.P.` never does either — twice over, since its last
 * label is a single letter and no top-level domain is one. `greatest.hits` is
 * the shape that would match and is not a host, and it is worth saying plainly
 * that the rule is a guess about a string, and a guess allowed to be wrong.
 *
 * The asymmetry is the one `classify/folder-name.ts` already argues for a
 * format note: declining a real name leaves the record its folder name and
 * files an issue, which is visible and costs a name that was never applied;
 * accepting a site name writes a wrong word into the meta layer as knowledge,
 * which is neither.
 */
const SITE_NAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,6}$/;

/**
 * Is this value nothing but a hostname?
 *
 * `lossless-galaxy.ru` and `kroogi.com` are; `Cock E.S.P.`, `Lost.And.Found`
 * and `Vol. 2` are not.
 */
export function isSiteName(value: string): boolean {
  return SITE_NAME.test(value.trim());
}
