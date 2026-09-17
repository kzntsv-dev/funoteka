-- Incremental rescan (plan:32 этап 6, requirements:39 §8).

-- scan_state is the ledger of the last observation of each file: a scan writes
-- what it saw and whether that differed from the run before it. The verdict has
-- to be taken during the walk, not read back afterwards — scan writes the file
-- row and this ledger from the same observation, so comparing the two later
-- always agrees and tells nothing.
--
-- Defaults to 1 (changed): assuming movement costs a re-read, assuming stillness
-- costs correctness.
ALTER TABLE scan_state ADD COLUMN changed INTEGER NOT NULL DEFAULT 1;

-- The "did this run see it" stamp `file` has carried since 001, extended to the
-- rows a rescan must also let go of. Without it, dropping what is no longer on
-- disk means matching path prefixes in SQL, which is both slower and wrong at
-- the boundaries (`Album` would swallow `Album 2`).
ALTER TABLE folder  ADD COLUMN last_seen_run_id INTEGER REFERENCES scan_run(id);
ALTER TABLE album   ADD COLUMN last_seen_run_id INTEGER REFERENCES scan_run(id);
ALTER TABLE release ADD COLUMN last_seen_run_id INTEGER REFERENCES scan_run(id);

CREATE INDEX idx_folder_last_seen ON folder (root_id, last_seen_run_id);
CREATE INDEX idx_album_last_seen ON album (root_id, last_seen_run_id);
CREATE INDEX idx_release_last_seen ON release (root_id, last_seen_run_id);
