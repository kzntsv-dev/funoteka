-- Tags, and where a title came from ([[task:2667]]).
--
-- Until now the collection's own metadata was parsed and dropped: `file` knew
-- a file's size and mtime and nothing about what it called itself. 279 of 291
-- files across four sample roots show as `(untitled)` / `--:--` while carrying
-- perfectly good ID3 and Vorbis comments.

-- The encoding a tag's text was read as, and how sure the reader was.
--
-- The same pair `cue` carries, for the same reason and with the same shape: a
-- ripper that writes CP1251 bytes under a Latin-1 declaration produces a title
-- that looks like a title, and "I guessed windows-1251" is the finding that
-- makes it visible. CERTAIN means nothing was inferred.
ALTER TABLE file ADD COLUMN encoding TEXT;
ALTER TABLE file ADD COLUMN encoding_confidence REAL;

-- Which run last read this file's tags.
--
-- The ledger alone is not enough to make this stage incremental. `scan_state`
-- says a file's bytes moved or did not; it cannot say whether anything ever
-- *read* them, because until this migration nothing did. And "no rows in
-- file_tag" cannot stand in for it either: a file with no tags at all is a
-- completely ordinary thing — an untagged rip — and it would be re-read on
-- every scan forever while never producing a row to show for it. So the read
-- is stamped, and NULL means never read.
--
-- Nullable on purpose: every file already on disk has NULL here, which is
-- exactly the backfill condition - the tags of the existing collection get read
-- once, on the first scan after this migration.
ALTER TABLE file ADD COLUMN tags_read_run_id INTEGER REFERENCES scan_run(id);

-- Where an album's or release's title came from: 'folder' | 'cue' | 'tag'.
--
-- A source, written down, instead of a guess from emptiness. `album.title` is
-- never NULL — classify fills it from the folder name or the file's stem — so
-- a tag cannot decide whether it is looking at a placeholder or at a name a cue
-- deliberately chose. With the source recorded, the priority is explicit: a tag
-- overrides the folder and never overrides a cue.
ALTER TABLE album   ADD COLUMN title_source TEXT;
ALTER TABLE release ADD COLUMN title_source TEXT;

-- One tag of one file.
--
-- `position` exists because Vorbis comments repeat a name: two ARTIST lines in
-- one file is how a collaboration is written, and collapsing them would keep
-- one name and silently drop the other.
CREATE TABLE file_tag (
  file_id  INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  name     TEXT    NOT NULL,   -- folded to lower case, as the reader reports it
  value    TEXT    NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (file_id, name, position)
);

-- Reading a tag by name is the only lookup the filling stages do: "the ALBUM
-- of this file", "the ARTIST of this file".
CREATE INDEX idx_file_tag_name ON file_tag (name);
