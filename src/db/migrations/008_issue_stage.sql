-- Which stage filed each issue, so a stage can clear its own rows.
--
-- Most stages derive their report from the present: `cues` and `artists` walk
-- every root on every run, so an earlier run's rows are dead weight — every
-- reader scopes by run, and nothing removed them. Without ownership, a
-- collection rescanned daily grows this table by one run's worth per day, and
-- any reader that forgets the scope counts duplicates.
--
-- Two stages are not like that. `scan` records a healed root path and a twin
-- whose rows were dropped, which happen once and raise nothing on a later run;
-- `tags` reads only the files the ledger reports changed, so a row describes the
-- last time that file was read. Clearing those would not replace the rows with
-- an equal report — it would delete the only record that the thing happened.
--
-- Ownership is by stage and never by a list of kinds: a hand-kept list is a list
-- that drifts, and the cue stage's kinds are born in two files.

ALTER TABLE issue ADD COLUMN stage TEXT NOT NULL DEFAULT '';

-- Rows that predate the column. The two stages that clear replace theirs on the
-- next run, so only `scan` and `tags` rows survive this mapping — and those are
-- the two the rules below get right.
--
-- The empty default exists for this backfill alone. Every writer binds a stage,
-- and the value it binds is a union type, so omitting one is a compile error
-- rather than a row no `clearIssues` will ever match.
UPDATE issue SET stage = CASE
  WHEN kind LIKE 'artist-%' THEN 'artists'
  WHEN kind LIKE 'tag-%'    THEN 'tags'
  WHEN kind LIKE 'cue-%'    THEN 'cues'
  WHEN kind IN ('ripper-marker-titles', 'track-without-index',
                'album-without-audio', 'track-count-mismatch') THEN 'cues'
  ELSE 'scan'
END;

-- Serves both scopes a clear uses: the stage alone (a prefix of this index) and
-- the per-file delete `tags` does, which is one statement per file read and
-- would otherwise scan the stage's rows each time.
CREATE INDEX idx_issue_stage ON issue (stage, root_id, rel_path);
