-- The cue's own TITLE, which was parsed and then dropped on the floor.
--
-- 003 did exactly this for CATALOG, and gave the reason in almost these words.
-- It stopped one column short: `doc.title` is read on every run — it is what
-- names a release better than the folder name does — and nothing persisted it,
-- so the moment a run ended the only record of what a cue said was gone.
--
-- That is visible wherever the priority chain *turns a title away*. Both of the
-- Wall's cues write `The Wall [Disc 1]` and `The Wall [1994 Remaster](Disc 2)`:
-- EAC writes a disc's own label into TITLE, each label names a disc rather than
-- the record, and the release keeps its folder name. The decision is right and
-- is reported as an issue — but a refusal is a judgement about a value, and
-- without this column the value did not survive the judgement, so there was
-- nothing left to review the decision against.
--
-- Kept for every cue, not only the turned-away ones. Which titles are refused
-- is a rule that will move, and a column that only holds the refusals of today's
-- rule cannot show what tomorrow's would have done differently.

ALTER TABLE cue ADD COLUMN title TEXT;
