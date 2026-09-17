-- What the collection holds that is not a record, and who said so.
--
-- The contract asks for a junk filter that hides what is not music from the
-- default view and **never deletes anything** (requirements:47 §11). Two halves,
-- stored apart because they have different owners:
--
--   1. `album.junk_reason` is *derived*, like every other column classify
--      writes: it is re-computed from the folder on every pass, so it follows
--      the disk and a rescan can change its mind. NULL means "a record".
--   2. `junk_mark` is *said*, and only a person says it. It is what the
--      contract calls the allow/block edit, and it outlives everything: it is
--      keyed on the path and not on the album row, so a folder that vanishes
--      and comes back is still marked, and a mark for a folder that is gone is
--      kept rather than swept — a statement about a path does not stop being
--      true because the disk is unavailable.
--
-- The two are not equal partners: classify reads the marks and lets them win
-- over its own reading, which is why `source` is on the row. The rule the
-- project keeps for every derived field (Q15, brainstorm:190) is that the
-- *owner* of a field decides and never "whoever wrote last" — here the owner is
-- the person, and the scan is the default they override.

-- Why an album is not a record, or NULL when it is one. Written by classify.
ALTER TABLE album ADD COLUMN junk_reason TEXT;

CREATE TABLE junk_mark (
  root_id   INTEGER NOT NULL,
  rel_path  TEXT    NOT NULL,
  verdict   TEXT    NOT NULL CHECK (verdict IN ('junk', 'trust')),
  note      TEXT,
  marked_at TEXT    NOT NULL,
  PRIMARY KEY (root_id, rel_path)
);
