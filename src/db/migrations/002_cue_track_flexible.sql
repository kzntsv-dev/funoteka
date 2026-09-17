-- Two things a cue sheet can legally do, neither of which the first schema
-- could store. Both crashed a scan outright rather than being reported.
--
--   1. Declare a TRACK with no INDEX 01. The parser reports this honestly as a
--      null index, and the planner already flags it — but `index01_ms` was
--      NOT NULL, so the insert threw and took the whole run down with it.
--
--   2. Span several files, restarting TRACK numbering at each FILE. The matrix
--      calls this out explicitly ("FILE CD1.flac" + "FILE CD2.flac") and the
--      parser records the file index, but the old UNIQUE (cue_id, ordinal)
--      saw the second FILE's TRACK 01 as a duplicate and threw.
--
-- SQLite cannot alter a constraint, so the table is rebuilt.

CREATE TABLE cue_track_new (
  id          INTEGER PRIMARY KEY,
  cue_id      INTEGER NOT NULL REFERENCES cue(id) ON DELETE CASCADE,
  -- Which FILE of the cue this track belongs to; 0 for the common single-file
  -- case, so numbering restarts legitimately per file.
  file_index  INTEGER NOT NULL DEFAULT 0,
  ordinal     INTEGER NOT NULL,
  title       TEXT,
  performer   TEXT,
  index00_ms  INTEGER,
  -- Nullable: a declared track may have no index. Callers report it.
  index01_ms  INTEGER,
  UNIQUE (cue_id, file_index, ordinal)
);

INSERT INTO cue_track_new (id, cue_id, file_index, ordinal, title, performer, index00_ms, index01_ms)
  SELECT id, cue_id, 0, ordinal, title, performer, index00_ms, index01_ms FROM cue_track;

DROP TABLE cue_track;

ALTER TABLE cue_track_new RENAME TO cue_track;
