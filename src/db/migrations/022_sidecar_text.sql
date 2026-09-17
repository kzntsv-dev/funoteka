-- The text a sidecar file holds, decoded.
--
-- An `.nfo` and an EAC `.log` are the record's own documentation, and a FLAC rip
-- already carries both *inside* itself: `logfile` and `cuesheet` are tags that 41
-- files of this collection state. A rip that keeps them as files beside the audio
-- had them nowhere — the scanner recorded their kind and their size and never
-- opened them, so `file.encoding` was NULL for all 417 of them and the meta layer
-- could not be read across the two shapes (task:2757).
--
-- The text is here rather than in `file_tag`, and that is the point of a table of
-- its own. A tag is something a file states about itself and is queried by name;
-- a whole document under a name is what once put 562 KB of base64 into
-- `file_tag`, one value at a time (TAGS_METHOD 2). These run to 15 KB each. The
-- encoding and how much it was a guess are the `file` row's, beside every other
-- file's.
CREATE TABLE sidecar_text (
  file_id INTEGER PRIMARY KEY REFERENCES file(id) ON DELETE CASCADE,
  text    TEXT NOT NULL
);
