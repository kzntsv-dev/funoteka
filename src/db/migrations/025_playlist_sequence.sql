-- A playlist id is handed out once and never handed out again.
--
-- `playlist.id` is an INTEGER PRIMARY KEY, which in SQLite is the rowid: the
-- next row takes the highest number ever used plus one, so a row deleted and a
-- row created afterwards are given the *same* number — the highest ever used
-- went down when the first was deleted. Measured: create, delete, create, and
-- the second playlist is `pl:1` as well.
--
-- That is invisible to a client holding nothing and wrong for one holding a
-- playlist. An id this server handed out names a different playlist after the
-- original is deleted, and nothing in the answer says so — a player with the
-- old one open shows the new one, a bookmark opens somebody else's list.
--
-- `AUTOINCREMENT` is SQLite's own answer to exactly this, and it needs the
-- table rebuilt, which this migration deliberately is not: the table is already
-- deployed and may already hold a listener's playlists. A counter in a table of
-- its own says the same thing — the number is handed out, written down, and
-- never read back out of the rows.
CREATE TABLE playlist_sequence (
  only_row INTEGER PRIMARY KEY CHECK (only_row = 1),
  next     INTEGER NOT NULL
);

-- Seeded past whatever is already there, so an id already handed out is not
-- handed out again by this either.
INSERT INTO playlist_sequence (only_row, next)
VALUES (1, (SELECT COALESCE(MAX(id), 0) + 1 FROM playlist));
