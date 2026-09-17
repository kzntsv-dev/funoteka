-- What the listener marked: stars and ratings.
--
-- The second half of the listener's own layer — playlists are the first — and
-- it shares their rule: a scan does not touch it, because nothing on disk says
-- what somebody thought of a record.
--
-- It differs from a playlist in the one way that decides the schema. A playlist
-- is a thing of its own; an annotation is *about a row of the model*, so what it
-- needs is a foreign key to that row and a cascade from it. A star on a track
-- whose file left the disk is a star on nothing, and nothing is what should be
-- left of it.
--
-- **Three tables rather than one with a `kind` column**, and that is the whole
-- reason: a polymorphic column cannot carry a foreign key, so `annotation(kind,
-- item_id)` would leave the cascade to a hand-written sweep somewhere — and a
-- sweep is a thing that can be forgotten, while `ON DELETE CASCADE` cannot.
-- The three are written once here and spoken of once in `annotation/store.ts`,
-- which is where the duplication costs something.
--
-- A row exists only while it says something: unstarring the last star and
-- setting the rating back to zero delete it rather than leaving a row of NULLs,
-- so `starred_at IS NOT NULL` and `rating` say the same thing in the table as
-- they do in an answer.
CREATE TABLE track_annotation (
  track_id   INTEGER PRIMARY KEY REFERENCES track(id) ON DELETE CASCADE,
  starred_at TEXT,
  rating     INTEGER
);

CREATE TABLE album_annotation (
  album_id   INTEGER PRIMARY KEY REFERENCES album(id) ON DELETE CASCADE,
  starred_at TEXT,
  rating     INTEGER
);

CREATE TABLE artist_annotation (
  artist_id  INTEGER PRIMARY KEY REFERENCES artist(id) ON DELETE CASCADE,
  starred_at TEXT,
  rating     INTEGER
);

-- The starred listings are the one query that reads a whole table here rather
-- than a row, and they order by when: an index keeps that from sorting every
-- annotation of every kind.
CREATE INDEX track_annotation_starred ON track_annotation (starred_at);
CREATE INDEX album_annotation_starred ON album_annotation (starred_at);
CREATE INDEX artist_annotation_starred ON artist_annotation (starred_at);
