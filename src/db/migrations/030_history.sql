-- What was played, what is playing, and the queue a listener left behind.
--
-- The listener's own layer again, and the third part of it: playlists are what
-- they arranged, stars are what they thought, and these are what they *did*.
-- Nothing on disk states any of it, so no scan writes here — and, like the other
-- two, a scan that takes a row away takes what hangs off it through the cascade.
--
-- Five tables rather than two, and the split is the protocol's own. A `play` is
-- history: it happened, and the row is the only record that it did. `now_playing`
-- is state: one row per player, replaced as the player moves. The queue is state
-- too, but the listener's rather than a player's — it exists so a queue can be
-- resumed on another device, which is why `getPlayQueue` takes no player and why
-- its entries are a table of their own (`play_queue_entry`) beside it. `player`
-- is the fifth, and it is not one of the three states but the row that turns a
-- client's own name into the integer the protocol asks for — see below.
--
-- The count is stated because it was wrong here: this said four while creating
-- five, and a reader counting the tables found a comment that disagreed with the
-- file beside it.

-- Who is playing. The protocol requires a `playerId` (an integer) and an
-- optional `playerName` on every now-playing entry, and **no endpoint accepts
-- either**: the server is meant to derive them. A client names itself with the
-- protocol's own `c` parameter, so that is the name, and this table is what
-- turns it into the stable small integer the protocol asks for. Deriving the
-- number from the name by hashing would be the other way; a row is simpler and
-- it can be read back.
CREATE TABLE player (
  id   INTEGER PRIMARY KEY,
  name TEXT    NOT NULL UNIQUE
);

-- A play that happened.
--
-- **`ON DELETE CASCADE` on the track**, which is a decision rather than an
-- obvious truth: a scrobble is a statement about a *file*, and Last.fm would
-- keep it after the file left. This meta layer's rule is the other one — every
-- row below `root` is a reading of what is on disk, and a reading of a file that
-- is not there is a reading of nothing. A history that outlived its collection
-- would also have nowhere to point: `track_id` is NOT NULL, so the alternatives
-- were a nullable column and a client that has to be told what a row without a
-- track means.
CREATE TABLE play (
  id        INTEGER PRIMARY KEY,
  track_id  INTEGER NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES player(id),
  -- When the play happened, as far as this server knows. The protocol lets a
  -- client state it — `time`, optional, and the only thing that dates a play a
  -- client made offline — and when it does not, this is when the server was told.
  played_at TEXT    NOT NULL
);

CREATE INDEX play_track ON play (track_id);
CREATE INDEX play_played_at ON play (played_at);

-- What each player is playing now, and how far in.
--
-- One row per player and not per user, because the protocol's question is "what
-- is being played by all users" and the only thing that tells two of them apart
-- here is the client. `state`, `position_ms` and `playback_rate` come from
-- `reportPlayback` (the `playbackReport` extension) and are what `getNowPlaying`
-- reports back when a server supports it.
--
-- **Nothing expires a row.** An entry stays until its player says otherwise, so
-- a client that vanishes mid-track leaves one behind and `minutesAgo` is what
-- tells a reader how old it is. That is the honest reading of the protocol —
-- which describes `minutesAgo` as "last update" and leaves the reader to judge —
-- and the alternative, a timeout, would be this server inventing a rule about
-- how long a track is that no client agrees with.
CREATE TABLE now_playing (
  player_id     INTEGER PRIMARY KEY REFERENCES player(id),
  track_id      INTEGER NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  updated_at    TEXT    NOT NULL,
  state         TEXT,
  position_ms   INTEGER,
  playback_rate REAL
);

-- The queue, and there is one of it.
--
-- `savePlayQueue`/`getPlayQueue` are per *user*, and this server has one — so
-- the row is single, like `playlist_sequence`'s counter, and for the same
-- reason: a table that could hold two rows would be a table where a caller has
-- to know which one it meant.
--
-- `current_index` is the protocol's `currentIndex` — a 0-based position in the
-- entries — and `getPlayQueue`, which addresses the current track by *id*
-- instead, is answered by looking that id up at this position. The two endpoints
-- read one queue because the extension exists to fix the older one's ambiguity
-- (a queue may hold the same song twice), not to keep a second queue.
CREATE TABLE play_queue (
  only_row      INTEGER PRIMARY KEY CHECK (only_row = 1),
  current_index INTEGER,
  position_ms   INTEGER NOT NULL DEFAULT 0,
  changed_at    TEXT    NOT NULL,
  changed_by    TEXT    NOT NULL
);

-- A song's place in the queue. `position` is the order, laid out from zero by
-- every save — and a track deleted by a sweep leaves its number unused, exactly
-- as it does in `playlist_track`. That is what makes the number stable, and the
-- stability is load-bearing: the queue's current track is stored *as* one of
-- these numbers (031), so it has to mean the same seat after a deletion as it
-- did before one.
CREATE TABLE play_queue_entry (
  position INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES track(id) ON DELETE CASCADE
);
