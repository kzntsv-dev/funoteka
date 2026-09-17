-- A playlist that a file asked for.
--
-- A `.m3u` sitting in the collection is a list somebody made, and one whose
-- songs come from different folders is a list this server should offer rather
-- than a folder it should browse. Importing it means writing a row here — so
-- the row has to say which file it came from, or the next scan would import the
-- same list again under a second name, and the one after that under a third.
--
-- `ON DELETE CASCADE` is the other half: the file is the list, and a list whose
-- file is gone is a list nobody asked for. The sweep deletes files; this makes
-- the imported playlist go with its own.
--
-- Rows written by the listener have no file and keep this NULL — the column
-- says where a playlist *came from*, not what it is, and the two kinds are told
-- apart by whether anything is there.
ALTER TABLE playlist ADD COLUMN source_file_id INTEGER REFERENCES file(id) ON DELETE CASCADE;

-- The import asks this question once per file, on every scan that re-reads one.
CREATE INDEX playlist_source_file ON playlist (source_file_id);
