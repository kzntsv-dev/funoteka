-- The cover a file carries, as a place in the file rather than a copy.
--
-- A picture inside a file is the answer for a record whose folder holds none —
-- measured on the live collection, 54 of the 59 albums without a folder image
-- carry their art inside their files, 47 of them as an MP4 `covr` and 7 as an
-- ID3v2 `APIC`. Copying those bytes into the meta layer would mean gigabytes of
-- something already on the disk, and a copy that goes stale the moment somebody
-- edits the file's tags — so what is written down is where the image is.
--
-- `picture_type` is the file's own numbering, where 3 is a front cover: it says
-- which picture this is, and it is what `betterPicture` chose between when a
-- file carried more than one.
CREATE TABLE cover_art (
  file_id      INTEGER PRIMARY KEY REFERENCES file(id) ON DELETE CASCADE,
  mime         TEXT    NOT NULL,
  picture_type INTEGER NOT NULL,
  offset       INTEGER NOT NULL,
  length       INTEGER NOT NULL
);

-- A table a stage derives is empty until that stage runs again, and the tags
-- stage only reads files the ledger reports as moved or never read — so on the
-- scan after this migration every file would keep its old `tags_read_run_id`,
-- the stage would skip all of them, and this table would stay empty while the
-- collection it describes is full of covers. Clearing the stamp is what makes
-- the next scan read them once more; it costs one full read of the collection
-- and its absence costs the feature.
UPDATE file SET tags_read_run_id = NULL WHERE kind = 'audio';
