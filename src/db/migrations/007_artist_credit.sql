-- An artist credit is a list, not a name ([[task:2684]]).
--
-- Until now an album pointed at exactly one artist. A collaboration is not one
-- artist: `Cock E.S.P. + Thirdorgan`, `Suffering Bastard + Cock E.S.P.` — and on
-- the sample this showed up as 11 of 28 albums with no artist at all, because
-- the per-track ARTIST values inside a split disagree and no majority exists
-- (`2011 - Demonologists + Cock E.S.P.` is 10 to 1, and calling that album
-- `Cock E.S.P.` would be confidently wrong).
--
-- The shape is OpenSubsonic's `artists[]` with `joinPhrase`: an ordered list,
-- each entry carrying the phrase that joined it to the one before.

CREATE TABLE artist_credit (
  album_id    INTEGER NOT NULL REFERENCES album(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  artist_id   INTEGER NOT NULL REFERENCES artist(id) ON DELETE CASCADE,
  -- Verbatim, whitespace and all, so `a + b` rebuilds as `a + b` and not
  -- `a+b`. Empty for the first entry: nothing joined it to anything.
  join_phrase TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (album_id, position)
);

-- What the source said, before it was read as a list.
--
-- The list is lossless — it reassembles exactly — so this is not a backup. It
-- is the thing a human audits: a rule that splits `Smell & Quim` into two
-- artists cannot be argued with unless the original is still on the row, and
-- the rule that split it is a guess that has to stay visible.
ALTER TABLE album ADD COLUMN credit_raw    TEXT;
ALTER TABLE album ADD COLUMN credit_source TEXT;  -- 'cue' | 'folder' | 'tag'

-- Pruning reads this table: an artist named only by a credit is still an
-- artist. Without that, `pruneArtists` would delete the row and the cascade
-- above would silently take the credit with it.
CREATE INDEX idx_artist_credit_artist ON artist_credit (artist_id);
