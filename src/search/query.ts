/**
 * What a user typed, said in the index's own language.
 *
 * The one rule here is that a query is *words*. FTS5 has a query language of its
 * own — `OR`, `NEAR`, parentheses, quotes, `*`, `-` — and handing it a user's
 * text unread means the user is writing that language by accident: a title with
 * a hyphen in it becomes a NOT, an unclosed quote is a syntax error, and a
 * search for "Pictures or You" asks a question about the search engine. So the
 * text is reduced to its words and rebuilt as a phrase list, where nothing the
 * user can type means anything but "this word".
 *
 * Every word has to be there, which is what makes a second word narrow a search
 * rather than widen it. The last word is a prefix, because a search is typed a
 * letter at a time and `Disint` should already find `Disintegration`.
 *
 * Null means "no words at all", which is not the same query as any word: FTS5
 * has no expression for "everything", and the caller answers an empty search
 * from the tables instead. That distinction is the whole reason this returns a
 * nullable string rather than an empty one.
 */
export function matchExpression(query: string): string | null {
  const words = query.match(/[\p{L}\p{N}]+/gu);
  if (words === null || words.length === 0) return null;

  return words
    .map((word, at) => (at === words.length - 1 ? `"${word}"*` : `"${word}"`))
    .join(' ');
}
