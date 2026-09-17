-- The year a record was released, which the classifier has been parsing and
-- throwing away.
--
-- `parseFolderName` reads a folder's name once for the pieces a collector puts
-- in it — the year, the artist, the format note — and only the title has ever
-- been used (`classify.ts`). A release called `1988. Группа крови` was filed
-- under `Группа крови` and the 1988 was lost, which is why no client could show
-- a release date: 236 of the 241 albums in the live collection name a year in
-- their path, and the meta layer held none of them.
--
-- `year_source` records which statement the number is, the way `title_source`
-- does: `folder` when the name slot carried it, `tag` when the only thing that
-- said so was a file's own DATE. Local sources own the year until an external
-- one arrives (v1.5, brainstorm:190 Q13) — and the folder outranks the tag for
-- the same reason it outranks it for a title: it is what the collector wrote.
ALTER TABLE album ADD COLUMN year INTEGER;
ALTER TABLE album ADD COLUMN year_source TEXT;
