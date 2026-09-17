-- Which FILE each cue mark was written in.
--
-- `cue_track` carried one `file_index` — the file the track opens — and two times,
-- and nothing said which file each time was counted from. A cue writes the pregap
-- of a track that opens a file at the *end* of the file before it, so `INDEX 00`
-- can sit in one FILE and `INDEX 01` in the next; the row then read
-- `index00_ms 895173, index01_ms 0`, which says the track ends before it begins.
-- Measured on this collection: 31 rows of 1001, across six cues.
--
-- Nothing in v1 reads those two columns directly, and every segmented album here
-- has a single `file_index`, so no output changes. The columns are added because
-- a schema that cannot say what its numbers are counted from is a schema the next
-- reader — the MCP surface v1.1 — would read as a lie.
ALTER TABLE cue_track ADD COLUMN index00_file_index INTEGER;
ALTER TABLE cue_track ADD COLUMN index01_file_index INTEGER;
