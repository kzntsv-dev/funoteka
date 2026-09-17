-- The container the tag reader recognised in a file, NULL when it recognised
-- none ([[task:2706]]).
--
-- `tag-format-unknown` is an aggregate on purpose — one finding per root and
-- extension, because 309 `m4a` files are a fact about the collection and not 309
-- facts — and it was counted over the files the stage opened *this run*. That
-- made the number a property of the run rather than of the collection: a second
-- run opens nothing, so it was not recomputed at all, and a run that opened one
-- new file reported one while an older row still claimed two.
--
-- Counting it over the whole collection needs the reader's verdict to outlive
-- the run that reached it, which is what this column is. Read its NULL two ways,
-- told apart by `tags_read_run_id`: never read, and read with nothing
-- recognised. A file whose ripper wrote no tags at all is neither — its
-- container is named and it has simply stated nothing, which is a different
-- thing from a format nothing here can open.
ALTER TABLE file ADD COLUMN tags_container TEXT;

-- Every file already on disk predates the column, so its NULL means "not
-- recorded", which is not the same as "the reader recognised nothing". Left
-- alone, the whole collection would be counted as a format nothing can read.
-- Clearing the stamp is what makes the next scan open those files again and
-- write the verdict down — the same backfill migration 006 chose, for the same
-- reason and at the same cost: one full read of the collection's tags.
UPDATE file SET tags_read_run_id = NULL;
