import { markPlaying, nowPlaying, player, queue, recordPlay, saveQueue } from '../history/store.ts';
import { withTransaction, type DatabaseSync } from '../db/index.ts';
import { childOf, ID, parseId, required } from './browse.ts';
import type { ServerConfig } from './config.ts';
import { ApiError, ERROR } from './envelope.ts';
import { knownTrackIds, song, songsByIds, type SongRow } from './meta.ts';
import type { Payload } from './router.ts';

/**
 * What the listener played, what is playing, and the queue they left.
 *
 * The third set of routes that write — playlists first, then stars — and the
 * same kind of thing: a statement about the music that no file states and no
 * scan can rebuild. These go further than the other two in one way only: they
 * are about *time*, so a row here says the collection was used rather than what
 * somebody thought of it.
 *
 * The shapes are the protocol's, and several fields have no input parameter at
 * all — `playerId`, `playerName` and `minutesAgo` are the server's to derive.
 * Where that is so, the comment below says what it was derived from and why,
 * because a client cannot be told apart from another except by the name it gave.
 */

/** How a client names itself. The protocol's `c`, and the only identity there is. */
function clientOf(query: URLSearchParams): string {
  return query.get('c') ?? '';
}

/**
 * The track an id names, or a refusal.
 *
 * `scrobble`, `savePlayQueue` and the rest all take ids that name *songs*, so a
 * `al:` or a `pl:` is not a narrower answer — it is a client asking the wrong
 * question, and saying "no such id" is truer than answering about an album.
 */
function trackOf(db: DatabaseSync, raw: string): number {
  const parsed = parseId(raw);
  const found = parsed !== undefined && parsed.kind === 'tr' ? song(db, parsed.n) : undefined;
  if (found === undefined) throw new ApiError(ERROR.notFound, `No such id: ${raw}`);
  return found.id;
}

/** Every `id` the request repeated, in the order it was given, empty ones dropped. */
function ids(query: URLSearchParams): string[] {
  return query.getAll('id').filter((raw) => raw !== '');
}

/**
 * The tracks a request named, resolved for the whole call rather than per id.
 *
 * `trackOf` answers with a whole `SongRow` — a `SONG_SELECT`, with the
 * album-groups subquery materialized inside it — and the write paths need
 * nothing from it but the id. Measured on the live daemon: a six-hundred-id
 * `scrobble` paid that select six hundred times, took **1122–1243 ms**, and a
 * `ping` sent during it waited **1133 ms** against 1.8 ms idle. On one thread
 * that is not a slow handler, it is every other client stopped for a second —
 * and the two calls that take a list are the two a client makes with one:
 * finishing an album, uploading a day of offline listening, saving a queue.
 *
 * `knownTrackIds` answers the same question in one statement per five hundred
 * ids — measured at **1.3 ms for six hundred** — which is what `playlist.ts`
 * does for its own ids and for this reason.
 *
 * Order and duplicates are kept. The last id is what a scrobble leaves playing,
 * and a queue may hold the same song at two seats; a set would lose both.
 */
function tracksOf(db: DatabaseSync, raw: readonly string[]): number[] {
  const parsed = raw.map((one) => {
    const id = parseId(one);
    if (id === undefined || id.kind !== 'tr') {
      throw new ApiError(ERROR.notFound, `No such id: ${one}`);
    }
    return id.n;
  });

  const known = knownTrackIds(db, parsed);
  return parsed.map((id, at) => {
    if (!known.has(id)) throw new ApiError(ERROR.notFound, `No such id: ${raw[at]}`);
    return id;
  });
}

/** How long ago, in whole minutes, as the protocol counts it. */
function minutesAgo(from: string, now: Date): number {
  // Floored, not rounded: "last update" is time *elapsed*, and a track thirty
  // seconds in is nought minutes old — reporting it as one would say a client
  // had been playing something it had only just started.
  return Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / 60_000));
}

/**
 * Register a play, or that one is happening.
 *
 * **Both kinds update what is playing**, and only one writes a play. The
 * protocol's own description of this method is what settles it — a scrobble
 * "makes the media files appear in the Now playing page … and appear in the list
 * of songs returned by `getNowPlaying`" — while `submission=false` is the
 * narrower notification a client sends as a track *starts*. So the two differ in
 * whether a play is recorded, and not in whether the client is shown as playing:
 * a client that only ever sends submissions is still shown, which is what the
 * bullet above promises it.
 *
 * An id that names nothing refuses the whole call before anything is written —
 * `trackOf` throws while the list is still being built — so a batch of forty
 * songs written one at a time cannot leave thirty-nine of them behind.
 *
 * **`time` is read, per id.** The protocol pairs it with `id` one for one
 * ("Since 1.8.0 you may specify multiple `id` (and optionally `time`)
 * parameters"), and it is the only thing that dates a play made while the client
 * was offline — which is the case the playback-report extension names. An id
 * whose `time` is absent, unreadable or missing is stamped with the moment the
 * server was told, which is what every play was stamped with before this.
 */
export function scrobble(db: DatabaseSync, query: URLSearchParams): Payload {
  const named = ids(query);
  if (named.length === 0) required(query, 'id');

  const trackIds = tracksOf(db, named);
  const submission = query.get('submission') !== 'false';
  const at = new Date();
  const times = query.getAll('time');

  withTransaction(db, () => {
    // Inside the transaction with everything else: `player` is a read and a
    // possible insert, and its twin in `playlist/store.ts` documents why that
    // pair has to be one atomic step.
    const who = player(db, clientOf(query));

    if (submission) {
      recordPlay(
        db,
        who,
        trackIds.map((trackId, index) => ({ trackId, at: playTime(times[index], at) })),
      );
    }

    // The last one named: a client finishing an album is the ordinary batch, and
    // the track it finished on is the one that was playing.
    markPlaying(db, who, trackIds[trackIds.length - 1] as number, at.toISOString());
  });

  return {};
}

/** The client's `time` for one play, or the moment the server was told. */
function playTime(raw: string | undefined, at: Date): string {
  if (raw === undefined || raw === '') return at.toISOString();

  const ms = Number(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : at.toISOString();
}

/**
 * What every client is playing, and how far in.
 *
 * `minutesAgo` is the whole of what tells a reader whether an entry is live:
 * this server does not expire one, because the protocol leaves the judgement to
 * whoever reads the list and any timeout would be a rule about how long a track
 * is that no client agreed to. `now` is taken once for the whole answer so two
 * entries updated in the same second cannot disagree by a minute, and it is a
 * seam because that is the only way a test can ask about an entry that is not
 * brand new.
 */
export function getNowPlaying(
  db: DatabaseSync,
  config: ServerConfig,
  now: () => Date = () => new Date(),
): Payload {
  const rows = nowPlaying(db);
  const songs = songsByIds(db, rows.map((row) => row.trackId));
  const byId = new Map(songs.map((row) => [row.id, row]));
  const at = now();

  const entry = rows.flatMap((row) => {
    const found = byId.get(row.trackId);
    if (found === undefined) return [];

    return [
      {
        ...childOf(found),
        username: config.user,
        minutesAgo: minutesAgo(row.updatedAt, at),
        playerId: row.playerId,
        // Absent rather than empty when the client named itself after nothing:
        // a `playerName` of `""` is a player whose name is nothing, and one that
        // is not there is a player nobody named.
        ...(row.playerName === '' ? {} : { playerName: row.playerName }),
        ...(row.state === null ? {} : { state: row.state }),
        ...(row.positionMs === null ? {} : { positionMs: row.positionMs }),
        ...(row.playbackRate === null ? {} : { playbackRate: row.playbackRate }),
      },
    ];
  });

  return { nowPlaying: { entry } };
}

/**
 * Where a player is in a track, as the `playbackReport` extension reports it.
 *
 * **This server keeps the state and does not scrobble from it.** The extension
 * asks a server to record a play once the media reaches a `stopped` state, and
 * that is a rule this server has not decided: "was it played" is a policy — half
 * the track, four minutes, whatever a person means by having listened — and the
 * clients here already say it themselves through `scrobble`, which is the method
 * the protocol provides for it. So `state` and `positionMs` are remembered and
 * reported back by `getNowPlaying` to a *different* client, which is what this
 * extension is for, and no play is written here.
 *
 * `ignoreScrobble` is therefore accepted and has nothing to suppress. It is not
 * ignored in the sense of being unimplemented — there is no scrobble on this
 * path for it to prevent — and that is said here rather than left for whoever
 * wonders why the parameter changes nothing.
 */
export function reportPlayback(db: DatabaseSync, query: URLSearchParams): Payload {
  const mediaId = required(query, 'mediaId');

  // `mediaType` is required by the extension, so an absent one is a missing
  // parameter and not a bad value — the two are answered differently on purpose
  // (`ERROR.missingParameter` against `ERROR.generic`), and a client that forgot
  // it should be told it forgot rather than that it sent the wrong thing.
  const mediaType = required(query, 'mediaType');
  if (mediaType !== 'song') {
    throw new ApiError(
      ERROR.generic,
      `mediaType is not a song this server holds: ${mediaType} (it has no podcasts)`,
    );
  }

  const rawPosition = required(query, 'positionMs');
  const positionMs = Number(rawPosition);
  if (!Number.isFinite(positionMs) || positionMs < 0) {
    throw new ApiError(ERROR.generic, `positionMs is not a position: ${rawPosition}`);
  }

  const state = required(query, 'state');
  if (!STATES.has(state)) {
    throw new ApiError(ERROR.generic, `state is not one of ${[...STATES].join(', ')}: ${state}`);
  }

  const rawRate = query.get('playbackRate');
  const rate = rawRate === null || rawRate === '' ? 1 : Number(rawRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new ApiError(ERROR.generic, `playbackRate is not a speed: ${rawRate ?? ''}`);
  }

  const trackId = trackOf(db, mediaId);
  withTransaction(db, () => {
    markPlaying(db, player(db, clientOf(query)), trackId, new Date().toISOString(), {
      state,
      positionMs,
      playbackRate: rate,
    });
  });

  return {};
}

const STATES: ReadonlySet<string> = new Set(['starting', 'playing', 'paused', 'stopped']);

/**
 * The seat the current track occupies, from the id a client can also use.
 *
 * The older endpoint addresses the current track by id and the `indexBasedQueue`
 * extension by seat, and both read the same queue — the extension exists because
 * an id cannot say *which* of two identical entries is playing, not to keep a
 * second list. So a save by id finds the seat here, and a save by seat uses it
 * as given.
 *
 * The *first* matching seat wins, which is the only answer an id can give when
 * the queue holds the same song twice; a client that means the second one says
 * so with the endpoint that can.
 */
function seatOfTrack(entries: readonly { position: number; trackId: number }[], trackId: number, raw: string): number {
  const found = entries.find((entry) => entry.trackId === trackId);
  if (found === undefined) {
    throw new ApiError(ERROR.generic, `current is not in the queue: ${raw}`);
  }
  return found.position;
}

/** The `position` parameter, which the protocol says to read as zero when absent. */
function positionOf(query: URLSearchParams): number {
  const raw = query.get('position');
  if (raw === null || raw === '') return 0;

  const position = Number(raw);
  if (!Number.isFinite(position) || position < 0) {
    throw new ApiError(ERROR.generic, `position is not a position: ${raw}`);
  }
  return position;
}

/**
 * The two saves, which differ only in how the current track is named.
 *
 * `id` is optional in both — OpenSubsonic's change — and a call with none is how
 * a client says "forget this queue": the whole queue is cleared and `changedBy`
 * still says who cleared it. `currentIndex` is *not* read on that path, because
 * the specification forbids it: "Send a call without any parameters to clear the
 * currently saved queue. In this case, `currentIndex` **must not** be set." A
 * call that sets it anyway is a client that has confused the two endpoints, and
 * clearing its queue in silence is the one answer that would hide that.
 */
function save(db: DatabaseSync, query: URLSearchParams, byIndex: boolean): Payload {
  const named = ids(query);
  const at = new Date().toISOString();
  const changedBy = clientOf(query);

  if (named.length === 0) {
    const stray = query.get('currentIndex');
    if (stray !== null && stray !== '') {
      throw new ApiError(
        ERROR.missingParameter,
        `currentIndex names a track in a queue that was not sent: ${stray} (send no id to clear)`,
      );
    }
    saveQueue(db, { trackIds: [], currentPosition: null, positionMs: 0, changedBy }, at);
    return {};
  }

  const trackIds = tracksOf(db, named);
  const positionMs = positionOf(query);

  let currentPosition: number;
  if (byIndex) {
    const raw = required(query, 'currentIndex');
    // Code 10 by the specification's own words: "if `currentIndex` is not
    // between 0 and length of the queue - 1 (inclusive), the server must respond
    // with error code 10" — which is this protocol's name for a parameter that
    // cannot be used, whatever the reason it cannot be.
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= trackIds.length) {
      throw new ApiError(
        ERROR.missingParameter,
        `currentIndex is not a position in the queue: ${raw} (0..${trackIds.length - 1})`,
      );
    }
    currentPosition = index;
  } else {
    const raw = required(query, 'current');
    currentPosition = seatOfTrack(
      trackIds.map((trackId, position) => ({ position, trackId })),
      trackOf(db, raw),
      raw,
    );
  }

  saveQueue(db, { trackIds, currentPosition, positionMs, changedBy }, at);
  return {};
}

export function savePlayQueue(db: DatabaseSync, query: URLSearchParams): Payload {
  return save(db, query, false);
}

export function savePlayQueueByIndex(db: DatabaseSync, query: URLSearchParams): Payload {
  return save(db, query, true);
}

/**
 * Where in the surviving seats the current one is.
 *
 * The stored number is a *seat*, and a sweep that takes a queued track away
 * leaves the seat unused rather than moving the ones after it. So the current
 * track is found by its number and not by counting from the front — and when the
 * seat itself is gone, the queue has moved on, so the answer is the next seat
 * along and the last one when there is no next.
 *
 * The protocol requires a current track to be named whenever the queue is not
 * empty ("OpenSubsonic servers must ensure that `current` exists and is a valid
 * id in the list of songs"), which is why this never answers "none" while there
 * is something to point at.
 */
function currentSeat(entries: readonly { position: number }[], seat: number): number {
  const exact = entries.findIndex((entry) => entry.position === seat);
  if (exact !== -1) return exact;

  const next = entries.findIndex((entry) => entry.position > seat);
  return next === -1 ? entries.length - 1 : next;
}

/**
 * The queue, answered the two ways its two endpoints ask.
 *
 * `changed` and `changedBy` are the protocol's required fields, and they are
 * absent in exactly one case: no queue has ever been saved. The specification's
 * list of required fields describes a queue, and before the first save there is
 * none to describe — so the answer names the user, carries no entries, and says
 * nothing about who last changed a thing that has never changed. A queue that
 * was saved and then emptied *does* carry them, which is the difference between
 * "nobody has ever queued anything" and "this client cleared the queue", and a
 * client syncing between devices wants to tell those apart.
 */
function read(db: DatabaseSync, config: ServerConfig, byIndex: boolean): Payload {
  const saved = queue(db);
  const rows = saved === null ? [] : songsByIds(db, saved.entries.map((entry) => entry.trackId));
  const byId = new Map(rows.map((row) => [row.id, row]));

  // Every seat has its track: `play_queue_entry` cascades, so a swept track took
  // its seat with it. The order is the seats' own, which is the order they were
  // saved in.
  const entries = (saved?.entries ?? []).map((entry) => childOf(byId.get(entry.trackId) as SongRow));

  const seat = saved === null || saved.currentPosition === null || entries.length === 0
    ? null
    : currentSeat(saved.entries, saved.currentPosition);

  const current = seat === null ? undefined : ID.track((saved as { entries: { trackId: number }[] }).entries[seat]?.trackId as number);

  const body: Payload = {
    username: config.user,
    ...(saved === null ? {} : { changed: saved.changedAt, changedBy: saved.changedBy }),
    ...(current === undefined ? {} : { current }),
    position: saved?.positionMs ?? 0,
    entry: entries,
  };

  if (!byIndex) return { playQueue: body };

  // The extension's own shape: the same queue, addressed by seat, and the id
  // left out — a client that asked ByIndex has said it does not want to be told
  // which id is playing, because an id cannot tell two equal entries apart.
  const { current: _ignored, ...byIndexBody } = body;
  return {
    playQueueByIndex: { ...byIndexBody, ...(seat === null ? {} : { currentIndex: seat }) },
  };
}

export function getPlayQueue(db: DatabaseSync, config: ServerConfig): Payload {
  return read(db, config, false);
}

export function getPlayQueueByIndex(db: DatabaseSync, config: ServerConfig): Payload {
  return read(db, config, true);
}
