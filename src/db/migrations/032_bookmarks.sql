-- Where the listener stopped.
--
-- The fourth part of the listener's own layer — playlists are what they
-- arranged, stars what they thought, plays what they did, and this is how far
-- they got. Nothing on disk states it, so no scan writes here, and what a scan
-- takes away goes through the cascade.
--
-- **Keyed by the song, with no id of its own.** One listener, one place per
-- track, which is the protocol's own rule in its own words: "if a bookmark
-- already exists for this file it will be overwritten". A second column of
-- identity would be a second bookmark per song, and a client with two resume
-- points and no way to choose between them.
--
-- `position_ms` is where in the *song* — which for a track cut out of a cue
-- image is the track's own timeline and not the image's, exactly as `duration`
-- is: a position is what a client seeks to, and it seeks within what it was
-- given.
CREATE TABLE bookmark (
  track_id    INTEGER PRIMARY KEY REFERENCES track(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  comment     TEXT,
  -- Both, and they part company on the second write: a client that moves the
  -- mark has not made a new one, and the difference is the only thing that says
  -- whether a bookmark is the one somebody left or one they keep moving.
  created_at  TEXT    NOT NULL,
  changed_at  TEXT    NOT NULL
);
