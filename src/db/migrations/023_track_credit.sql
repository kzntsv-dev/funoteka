-- Who a track is by, when that is not who the record is by.
--
-- An album's credit is a list with join phrases (`artist_credit`), because a
-- record can be by two people and the source says which word joined them. A
-- track's is the same shape, for the same reason — and `track.artist_id` cannot
-- hold it: one column holds one artist, and `Кино & Джоанна Стингрей` is two.
--
-- What this is for, measured on the live collection: of 2626 tracks whose cue
-- states a performer, 1862 state the record's own credit again, 218 differ —
-- and 534 have no album row at all, so for them the performer is not a
-- refinement of the record's credit but the only credit that exists (task:2729).
--
-- `position` is the order the source stated, and `join_phrase` is the word it
-- joined them with, exactly as `artist_credit` keeps both.
CREATE TABLE track_credit (
  track_id    INTEGER NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  artist_id   INTEGER NOT NULL REFERENCES artist(id) ON DELETE CASCADE,
  join_phrase TEXT,
  PRIMARY KEY (track_id, position)
);

CREATE INDEX track_credit_artist ON track_credit (artist_id);
