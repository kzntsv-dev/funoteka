-- The queue's current track is a seat, not an index, and what plays add up to.
--
-- Three corrections to `030_history.sql`, all found by the two review axes of
-- the same change (task:2863) — one of them independently reproduced.

-- **`current_index` was a position read as an index.**
--
-- The column was meant as a position in the saved order, but `queue()` hands
-- back the entries that survived a sweep, compacted, and the API read one as the
-- other. A track deleted *ahead* of the current one shifts every ordinal after
-- it, so `getPlayQueue` announced a different song as playing; delete the
-- current track itself and the stored number ran past the end, so the field was
-- dropped while the queue was not empty — breaking the specification's own
-- "must ensure that `current` exists" for exactly the case it describes.
--
-- Reproduced against the module: queue `[tr:1…tr:5]` with `current=tr:3`,
-- `tr:1` deleted → `current: "tr:4"`.
--
-- `play_queue_entry.position` does not shift: a deleted entry leaves its number
-- unused, which is the whole reason the entries are numbered rather than
-- indexed. So this is the number to store, and `currentIndex` — the ordinal the
-- extension reports — is derived by counting the survivors before it.
ALTER TABLE play_queue RENAME COLUMN current_index TO current_position;

-- **What each track's plays add up to**, for the two fields the protocol puts on
-- every `Child`: `playCount` and `played`.
--
-- `play` is the history and stays the record of what happened. This is a rollup
-- of it, and it exists because the alternative is an aggregate per row in every
-- listing: `SONG_SELECT` feeds `getAlbum`, `getArtist`, `search3`, the folder
-- tree and both starred listings, and a correlated count there is one query
-- multiplied by whatever the listing returns — the cost this project has paid
-- for twice already (task:2806, task:2807).
CREATE TABLE track_play (
  track_id   INTEGER PRIMARY KEY REFERENCES track(id) ON DELETE CASCADE,
  play_count INTEGER NOT NULL DEFAULT 0,
  played_at  TEXT
);

-- **An index with no reader.**
--
-- Nothing orders or filters by `played_at`: a track's history is read by track
-- (`track_play` for the fields, `play_track` for the cascade), and no query asks
-- "what was played between these times" yet. An index nobody reads is space and
-- a write cost on every scrobble, so it goes until a query claims it.
DROP INDEX play_played_at;
