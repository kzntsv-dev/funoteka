-- Two lookups that were scanning a table to answer a question about one row.
--
-- Both were found by measuring the playlist-file stage, and neither is about
-- playlists: they are lookups the API and the importer make, and both grew with
-- the size of the collection rather than with the size of the question.

-- A file by its path.
--
-- The unique index on `file (root_id, rel_path)` is declared with the default
-- BINARY collation, and the importer compares paths with `COLLATE NOCASE` on
-- Windows — which names the same file there (`01.FLAC` and `01.flac` do not
-- both exist in one folder). A comparison whose collation differs from the
-- index's cannot use it, so each entry of a `.m3u` walked every file of the
-- root: measured on this collection, 80 µs for a path near the start of the
-- walk and 1083 µs near the end — a list of 5000 entries cost 14 seconds, and a
-- collection three times larger would have cost three times that with no new
-- playlist files at all.
--
-- On other platforms the importer compares without `COLLATE` and keeps using
-- the unique index; this one is simply not chosen there, and costs the space it
-- takes.
CREATE INDEX file_rel_path_nocase ON file (root_id, rel_path COLLATE NOCASE);

-- A playlist by its name.
--
-- Asked once per imported `.m3u`, to tell two lists with the same file name
-- apart (`playlist/import.ts`). Nothing indexed `name`, so each question read
-- the whole table: quadratic in the number of playlists, cheap today and not
-- worth leaving as the third such leg.
CREATE INDEX playlist_name ON playlist (name);
