-- Server-side playlists: the one thing in this database that is not derived
-- from the filesystem.
--
-- Every other table here is an overlay over the collection — a row exists
-- because a file exists, and a scan can rebuild all of it. A playlist is the
-- listener's own statement and is nowhere on disk: it is the first thing the
-- API writes, and the first thing a scan must leave alone.
--
-- That is why the two tables live in the meta layer rather than beside it. They
-- share the one file with the classified model, and the model's rule — the
-- scanner is the only writer — is narrowed rather than broken: the scanner
-- writes the model, and this is the one part of the file it never touches.

CREATE TABLE playlist (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  comment    TEXT,
  -- The protocol's `public`, kept although one listener cannot tell the
  -- difference: there is no second account to share with, and a server that
  -- dropped what a client set would hand that client back a playlist claiming
  -- not to be public — the client's own setting, denied to it.
  public     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  -- When anything about the playlist last moved: its name, its comment, or a
  -- song. The protocol shows both timestamps to a client, and a client that
  -- syncs by them needs this one to change on an edit — a `changed` that only
  -- moved when songs were added would tell such a client its stale copy of the
  -- name was current.
  changed_at TEXT    NOT NULL
);

-- A song's place in a playlist.
--
-- `position` is the order the client is shown, and every write lays it out from
-- zero with no holes — because the protocol addresses entries by their index,
-- and `songIndexToRemove` counts on the same density. A song taken out by the
-- cascade below does leave its number unused until the next write, and nothing
-- minds: the number is read as an order (the rows are sorted by it), never as
-- the position a client means.
--
-- The same song may sit at two positions. The protocol says nothing against it,
-- a listener may well want it, and a schema that forbade it would be inventing
-- a rule the client cannot see.
--
-- `ON DELETE CASCADE` on the track is the whole of what "a playlist survives a
-- rescan" costs. A track still on disk keeps its id — the scanner upserts on
-- `(album_id, ordinal)` rather than re-inserting — so its entries stay exactly
-- where they were. A track whose file is gone is dropped by the sweep, and its
-- entries go with it instead of pointing at a row that is no longer there.
--
-- The cascade on the playlist is the obvious half: a deleted playlist holds
-- nothing. It is also what makes `deletePlaylist` one statement.
CREATE TABLE playlist_track (
  playlist_id INTEGER NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  track_id    INTEGER NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  PRIMARY KEY (playlist_id, position)
);

-- The sweep deletes tracks, and SQLite has to find this table's rows to cascade
-- into them; without this it scans every entry of every playlist per deleted
-- track.
CREATE INDEX playlist_track_track ON playlist_track (track_id);
