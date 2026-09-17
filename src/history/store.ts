import { withTransaction, type DatabaseSync } from '../db/index.ts';

/**
 * What the listener did: plays that happened, what is on now, and the queue they
 * left behind.
 *
 * The third part of the listener's own layer — playlists are what they arranged,
 * stars are what they thought — and the same rule holds: nothing on disk states
 * any of it, so no scan writes here, and what a scan takes away goes through the
 * cascade (`030_history.sql`).
 *
 * The five tables are the protocol's own split and not an accident of storage:
 * a **play** is history and the row is the only record it happened; **now
 * playing** is state, one row per player, replaced as the player moves; the
 * **queue** is state too, but the listener's rather than a player's, which is
 * why `getPlayQueue` takes no player at all; the queue's entries are their own
 * table beside it; and **player** is the row that turns a client's own name into
 * the integer the protocol asks for.
 */

/**
 * The row for a client, by the name it gave.
 *
 * The protocol requires a `playerId` — an integer — on every now-playing entry
 * and no endpoint accepts one, so the server derives it. A client names itself
 * with the protocol's `c` parameter; this turns that name into the row the
 * integer is, and finds it again on the next call.
 */
export function player(db: DatabaseSync, name: string): number {
  const found = db.prepare('SELECT id FROM player WHERE name = ?').get(name) as
    | { id: number }
    | undefined;
  if (found !== undefined) return found.id;

  const inserted = db.prepare('INSERT INTO player (name) VALUES (?)').run(name);
  return Number(inserted.lastInsertRowid);
}

/**
 * That a track was played, in the history and in the rollup.
 *
 * Both, because they answer different questions and neither can answer the
 * other's: `play` is what happened (which track, which client, when) and
 * `track_play` is what the protocol *shows* — `playCount` and `played` are
 * fields on every `Child`, and a field on every Child cannot be an aggregate
 * over a listing (`031_queue_position_and_plays.sql`).
 *
 * One transaction around the pair, so the history and the rollup cannot
 * disagree: a scrobble that wrote one and not the other would leave a count that
 * does not match the rows behind it.
 */
export function recordPlay(
  db: DatabaseSync,
  playerId: number,
  played: readonly { trackId: number; at: string }[],
): void {
  withTransaction(db, () => {
    const insert = db.prepare('INSERT INTO play (track_id, player_id, played_at) VALUES (?, ?, ?)');
    const roll = db.prepare(
      `INSERT INTO track_play (track_id, play_count, played_at) VALUES (?, 1, ?)
       ON CONFLICT (track_id) DO UPDATE SET
         play_count = track_play.play_count + 1,
         played_at  = excluded.played_at`,
    );

    // Each play carries its own time: the protocol pairs `time` with `id` one
    // for one, so a client uploading a day of offline listening dates each of
    // them separately and they must not all be stamped now.
    for (const play of played) {
      insert.run(play.trackId, playerId, play.at);
      roll.run(play.trackId, play.at);
    }
  });
}

/**
 * What a player is on, and how far in.
 *
 * One row per player, replaced rather than accumulated: the protocol's question
 * is what is playing *now*, and a table that kept every track a client had
 * opened would be a history with a different name.
 *
 * The three fields beside the track come from `reportPlayback` and are all the
 * server's to remember — the client is told them back by a *different* client
 * through `getNowPlaying`, which is the whole reason they are stored rather than
 * answered from the request.
 */
export function markPlaying(
  db: DatabaseSync,
  playerId: number,
  trackId: number,
  at: string,
  details: { state?: string | null; positionMs?: number | null; playbackRate?: number | null } = {},
): void {
  db.prepare(
    `INSERT INTO now_playing (player_id, track_id, updated_at, state, position_ms, playback_rate)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (player_id) DO UPDATE SET
       track_id      = excluded.track_id,
       updated_at    = excluded.updated_at,
       state         = excluded.state,
       position_ms   = excluded.position_ms,
       playback_rate = excluded.playback_rate`,
  ).run(
    playerId,
    trackId,
    at,
    details.state ?? null,
    details.positionMs ?? null,
    details.playbackRate ?? null,
  );
}

/** One player's now-playing row, with the name the protocol asks for beside it. */
export interface NowPlayingRow {
  playerId: number;
  playerName: string;
  trackId: number;
  updatedAt: string;
  state: string | null;
  positionMs: number | null;
  playbackRate: number | null;
}

/**
 * What every player is on, most recently updated first.
 *
 * A row whose track is gone is gone with it — the cascade — so nothing here has
 * to be filtered: what comes back is a list of tracks that are still in the
 * collection.
 */
export function nowPlaying(db: DatabaseSync): NowPlayingRow[] {
  return db
    .prepare(
      `SELECT np.player_id     AS playerId,
              p.name           AS playerName,
              np.track_id      AS trackId,
              np.updated_at    AS updatedAt,
              np.state         AS state,
              np.position_ms   AS positionMs,
              np.playback_rate AS playbackRate
         FROM now_playing np
         JOIN player p ON p.id = np.player_id
        ORDER BY np.updated_at DESC, np.player_id`,
    )
    .all() as unknown as NowPlayingRow[];
}

/** One seat in the queue. */
export interface QueueEntry {
  /**
   * The seat itself — `play_queue_entry.position` — and not a place in the list.
   *
   * The difference is the whole of what `031` corrected. A sweep that takes a
   * queued track away leaves this number unused, so every other seat keeps the
   * value it had; a caller that indexed the compacted list instead would read a
   * different song as the current one the moment anything ahead of it went.
   */
  position: number;
  trackId: number;
}

/** The queue as it was saved, or nothing when none was ever saved. */
export interface SavedQueue {
  /** The seat the current track occupies, or nothing when the queue has none. */
  currentPosition: number | null;
  positionMs: number;
  changedAt: string;
  changedBy: string;
  /** The seats still occupied, in order. */
  entries: QueueEntry[];
}

/**
 * The queue, seat by seat.
 *
 * The seats are returned with their numbers rather than as a bare list, because
 * the current track is stored as one of those numbers and a caller has to be
 * able to find it. Reading the list and indexing it would work until a deletion
 * ahead of the current seat moved everything after it — which is what happened
 * (task:2863).
 */
export function queue(db: DatabaseSync): SavedQueue | null {
  const row = db
    .prepare(
      `SELECT current_position AS currentPosition, position_ms AS positionMs,
              changed_at AS changedAt, changed_by AS changedBy
         FROM play_queue WHERE only_row = 1`,
    )
    .get() as Omit<SavedQueue, 'entries'> | undefined;
  if (row === undefined) return null;

  const entries = db
    .prepare('SELECT position, track_id AS trackId FROM play_queue_entry ORDER BY position')
    .all() as unknown as QueueEntry[];

  return { ...row, entries };
}

/**
 * Replace the queue, whole.
 *
 * Every save lays the positions out from zero again, the rule every other
 * ordered write in this project follows: a queue is addressed by index, so a
 * save that appended would leave the numbers meaning something the client did
 * not send. An empty list is a queue with nothing in it — how a client says
 * "forget this" — and it is saved rather than deleted, so `changedBy` still says
 * who did it.
 */
export function saveQueue(
  db: DatabaseSync,
  input: {
    trackIds: readonly number[];
    /** The seat the current track is at — an ordinal in `trackIds`, which is
     *  exactly what a save's seats are, laid out from zero. */
    currentPosition: number | null;
    positionMs: number;
    changedBy: string;
  },
  at: string,
): void {
  withTransaction(db, () => {
    db.prepare('DELETE FROM play_queue_entry').run();

    const insert = db.prepare('INSERT INTO play_queue_entry (position, track_id) VALUES (?, ?)');
    input.trackIds.forEach((trackId, position) => insert.run(position, trackId));

    db.prepare(
      `INSERT INTO play_queue (only_row, current_position, position_ms, changed_at, changed_by)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (only_row) DO UPDATE SET
         current_position = excluded.current_position,
         position_ms      = excluded.position_ms,
         changed_at       = excluded.changed_at,
         changed_by       = excluded.changed_by`,
    ).run(input.currentPosition, input.positionMs, at, input.changedBy);
  });
}
