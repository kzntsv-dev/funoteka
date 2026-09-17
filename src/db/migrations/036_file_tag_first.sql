-- The eight tags a song listing asks for, as one row a file.
--
-- A listing builds a `Child` per song, and eight of that payload's fields come
-- from `file_tag`: the genre, the track artist, the two advisories, and the four
-- ReplayGain numbers. **A page of five hundred songs costs 10.04 ms reading them
-- the obvious way — one correlated subquery per name, which is what the API did
-- — and 6.37 ms reading them off this row**, measured 2026-09-16 on a copy of the
-- live collection, the two statements interleaved in one run (task:2925).
--
-- **That shape is not the defect, and the measurement says so.** A correlated
-- scalar subquery here is one index seek through
-- `sqlite_autoindex_file_tag_1 (file_id, name, position)`, with `ORDER BY
-- position LIMIT 1` free, and an absent name costs a seek that finds nothing.
-- Every alternative was measured and every one is worse: the same eight as one
-- `json_group_object` is no faster and answers differently; a `LEFT JOIN` to a
-- derived pivot — the shape `ALBUM_GENRES` uses — cannot be restricted to the
-- page, so it materialises over the whole tag table and multiplies the page's
-- cost by an order of magnitude (51 ms against 11.29 in the run that measured
-- the alternatives); a covering index `(file_id, name, position, value)` is 13
-- times worse forced (the planner will not choose it: it gives up the free
-- ordering); and `WITHOUT ROWID` is 5 times worse. What is left is that eight
-- seeks per song are eight seeks per song.
--
-- So the values move out of the tag table, and a file's row is joined the way
-- `audio_probe` already is — one primary-key lookup on a table of one row per
-- file. The join is not quite free: a page with no tag columns at all is 6.56 ms
-- in the run that put the eight subqueries at 11.29.
--
-- **The rule is the API's own, copied exactly**, because these columns are what
-- a `Child` is shown: the *first value by position* of each name, trimmed of the
-- whitespace a tag can hide in, with an empty result treated as no value at all
-- so that a second line falls through to a first. `TRIM` is spelled with its
-- character set and not with SQLite's one-argument form, which removes spaces
-- and leaves a tab — the same trap `meta.ts` spells out beside `trimmed`.
--
-- Written by the tags stage from this migration onward (`tags/first.ts` holds
-- the live statement; this is the frozen backfill), so a file whose tags are
-- read again gets its row rewritten in the same transaction that rewrote the
-- tags. A file that has never been read has no row, and the join answers null —
-- which is what the subquery answered too.
CREATE TABLE file_tag_first (
  file_id          INTEGER PRIMARY KEY REFERENCES file(id) ON DELETE CASCADE,
  genre            TEXT,
  track_artist     TEXT,
  advisory_itunes  TEXT,
  advisory_mp4     TEXT,
  rg_track_gain    TEXT,
  rg_album_gain    TEXT,
  rg_track_peak    TEXT,
  rg_album_peak    TEXT
);

-- The collection as it stands, once. From here the stage keeps it.
INSERT INTO file_tag_first (
  file_id, genre, track_artist, advisory_itunes, advisory_mp4,
  rg_track_gain, rg_album_gain, rg_track_peak, rg_album_peak
)
SELECT file_id,
       MAX(CASE WHEN name = 'genre'                 THEN value END),
       MAX(CASE WHEN name = 'artist'                THEN value END),
       MAX(CASE WHEN name = 'itunesadvisory'        THEN value END),
       MAX(CASE WHEN name = 'rtng'                  THEN value END),
       MAX(CASE WHEN name = 'replaygain_track_gain' THEN value END),
       MAX(CASE WHEN name = 'replaygain_album_gain' THEN value END),
       MAX(CASE WHEN name = 'replaygain_track_peak' THEN value END),
       MAX(CASE WHEN name = 'replaygain_album_peak' THEN value END)
  FROM (
    SELECT ft.file_id,
           ft.name,
           TRIM(ft.value, ' ' || CHAR(9) || CHAR(10) || CHAR(13) || CHAR(160) || CHAR(12288)) AS value,
           ROW_NUMBER() OVER (PARTITION BY ft.file_id, ft.name ORDER BY ft.position) AS rn
      FROM file_tag ft
     WHERE ft.name IN ('genre', 'artist', 'itunesadvisory', 'rtng',
                       'replaygain_track_gain', 'replaygain_album_gain',
                       'replaygain_track_peak', 'replaygain_album_peak')
       AND TRIM(ft.value, ' ' || CHAR(9) || CHAR(10) || CHAR(13) || CHAR(160) || CHAR(12288)) <> ''
  )
 WHERE rn = 1
 GROUP BY file_id;

-- The `MAX` above is exact rather than a choice: `rn = 1` leaves one row per
-- (file, name), so the aggregate has nothing to choose between. That is the
-- whole reason for the window function — the cheaper-looking `MIN(position)`
-- beside a bare `value` reads the value out of whichever row the aggregate
-- happened to keep, which SQLite guarantees only while the subquery holds
-- exactly one aggregate. `albumGenres` in `meta.ts` declines that form at
-- length; this declines it for the same reason and pays the same few
-- milliseconds for it, once.
