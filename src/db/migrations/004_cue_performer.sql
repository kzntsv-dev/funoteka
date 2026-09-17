-- The cue's album-level PERFORMER, which was parsed and then dropped.
--
-- `applyCues` has always filled `doc.performer` — in a cue sheet the performer
-- written above the first TRACK names the record's artist, and the per-track
-- ones below it name each track — but there was nowhere to put it. The result
-- was an artist stage with nothing to go on: the per-track PERFORMER survived
-- in `cue_track`, while the album's own went in the bin.
--
-- Nullable, and legitimately so: a cue need not name a performer at all, and a
-- compilation often names only the tracks.

ALTER TABLE cue ADD COLUMN performer TEXT;
