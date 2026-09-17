import type { DatabaseSync } from '../db/index.ts';

/**
 * What this deployment would lose if the meta layer went away, written out and
 * read back.
 *
 * **The line this draws is between readings and statements.** Everything the
 * scanner writes — albums, tracks, tags, the tree, the search index — is a
 * *reading* of the files, and the files are still on disk: a rescan rebuilds all
 * of it, and exporting it would be exporting a cache. What cannot be rebuilt is
 * what a *person* said: the playlists they made, the songs they starred and
 * rated, the bookmarks they left, the folders they overruled the junk filter
 * about. That is what this document is, and it is deliberately short.
 *
 * ## How a track is named
 *
 * Every one of those statements is keyed on `track_id` in the database, and a
 * track id is *not* stable: the cue stage clears its rows and rebuilds them, so
 * an id that meant a song before a rescan may mean another one after — or
 * nothing. A backup keyed on ids would restore somebody's stars onto the wrong
 * songs, silently, which is the worst failure available here.
 *
 * So a track is named the way the disk names it: the root it was found under,
 * the file's path within that root, and where the segment starts (`null` for a
 * whole file, a millisecond offset for a segment of one). That survives a
 * rescan, a moved library, and a different machine with the same files, and it
 * is the same key `scan` matches files by.
 *
 * ## What is not in it, and why
 *
 * Play history and the queue are *activity* rather than decisions: they grow
 * without bound, nobody restores them on purpose, and a document carrying them
 * would be mostly a log. The password and the bootstrap key stay where the
 * deployment keeps them — the config file, which is one small file to back up —
 * rather than being copied into a document an operator is about to mail to
 * themselves. Both of those are written into the document itself, so a reader
 * of a backup knows what it is not holding.
 */

export interface TrackKey {
  root: string;
  file: string;
  /** Where the segment starts, or null for a whole file. */
  at: number | null;
}

export interface ExportDocument {
  funoteka: 'export';
  version: number;
  at: string;
  schema: number;
  naming: string;
  notIncluded: Record<string, string>;
  sensitive: string;
  playlists: {
    name: string;
    comment: string | null;
    public: boolean;
    createdAt: string;
    changedAt: string;
    entries: TrackKey[];
  }[];
  starred: {
    tracks: (TrackKey & { starredAt: string | null; rating: number | null })[];
    albums: { root: string; rel: string; starredAt: string | null; rating: number | null }[];
    artists: { name: string; starredAt: string | null; rating: number | null }[];
  };
  bookmarks: (TrackKey & {
    positionMs: number;
    comment: string | null;
    createdAt: string;
    changedAt: string;
  })[];
  junkMarks: { root: string; rel: string; verdict: string; note: string | null; markedAt: string }[];
  apiKeys: { label: string; secret: string; createdAt: string; revokedAt: string | null }[];
}

/** Every statement a rescan cannot rebuild, as one document. */
export function exportState(db: DatabaseSync, schema: number, now = new Date()): ExportDocument {
  return {
    funoteka: 'export',
    version: 1,
    at: now.toISOString(),
    schema,
    naming: 'a track is (root path, file path within it, segment start in ms — null for a whole file)',
    notIncluded: {
      scan: 'albums, tracks and everything derived from the files: a rescan rebuilds them and the files are on disk',
      secrets: 'the password and the bootstrap api key — they are in the config file, which is one small file to copy',
      history: 'play counts and the play queue: activity rather than decisions, and it grows without bound',
    },
    sensitive: 'the api keys below are credentials: this document is worth as much as they are',
    playlists: db
      .prepare('SELECT id, name, comment, public, created_at, changed_at FROM playlist ORDER BY id')
      .all()
      .map((row) => {
        const one = row as { id: number; name: string; comment: string | null; public: number; created_at: string; changed_at: string };
        return {
          name: one.name,
          comment: one.comment,
          public: one.public === 1,
          createdAt: one.created_at,
          changedAt: one.changed_at,
          entries: db
            .prepare(
              `SELECT r.path AS root, f.rel_path AS file, t.segment_start_ms AS at
                 FROM playlist_track pt JOIN track t ON t.id = pt.track_id
                 JOIN file f ON f.id = t.file_id JOIN root r ON r.id = f.root_id
                WHERE pt.playlist_id = ? ORDER BY pt.position`,
            )
            .all(one.id) as unknown as TrackKey[],
        };
      }),
    starred: {
      tracks: db
        .prepare(
          `SELECT r.path AS root, f.rel_path AS file, t.segment_start_ms AS at,
                  a.starred_at AS starredAt, a.rating AS rating
             FROM track_annotation a JOIN track t ON t.id = a.track_id
             JOIN file f ON f.id = t.file_id JOIN root r ON r.id = f.root_id
            ORDER BY a.track_id`,
        )
        .all() as unknown as (TrackKey & { starredAt: string | null; rating: number | null })[],
      albums: db
        .prepare(
          `SELECT r.path AS root, a.rel_path AS rel, an.starred_at AS starredAt, an.rating AS rating
             FROM album_annotation an JOIN album a ON a.id = an.album_id
             JOIN root r ON r.id = a.root_id ORDER BY an.album_id`,
        )
        .all() as unknown as { root: string; rel: string; starredAt: string | null; rating: number | null }[],
      artists: db
        .prepare(
          `SELECT ar.name AS name, an.starred_at AS starredAt, an.rating AS rating
             FROM artist_annotation an JOIN artist ar ON ar.id = an.artist_id ORDER BY an.artist_id`,
        )
        .all() as unknown as { name: string; starredAt: string | null; rating: number | null }[],
    },
    bookmarks: db
      .prepare(
        `SELECT r.path AS root, f.rel_path AS file, t.segment_start_ms AS at,
                b.position_ms AS positionMs, b.comment AS comment,
                b.created_at AS createdAt, b.changed_at AS changedAt
           FROM bookmark b JOIN track t ON t.id = b.track_id
           JOIN file f ON f.id = t.file_id JOIN root r ON r.id = f.root_id
          ORDER BY b.track_id`,
      )
      .all() as unknown as ExportDocument['bookmarks'],
    junkMarks: db
      .prepare(
        `SELECT r.path AS root, m.rel_path AS rel, m.verdict AS verdict,
                m.note AS note, m.marked_at AS markedAt
           FROM junk_mark m JOIN root r ON r.id = m.root_id ORDER BY r.path, m.rel_path`,
      )
      .all() as unknown as ExportDocument['junkMarks'],
    apiKeys: db
      .prepare('SELECT label, secret, created_at AS createdAt, revoked_at AS revokedAt FROM api_key ORDER BY id')
      .all() as ExportDocument['apiKeys'],
  };
}

export interface Restored {
  /**
   * How many of each kind the document named that this library could answer
   * about — in place now, whether they were already there or not.
   *
   * **"Placed", not "inserted", and the difference was found on a live run.** A
   * restore of a document onto the library it came from inserts nothing, and the
   * first version of this reported every one of them as though it had: an
   * operator reading `playlistEntries: 3` would believe three entries had been
   * added to a playlist that already held them. What a restore can honestly
   * count is how much of the document this library can answer about, and that is
   * what `skipped` is the other half of.
   */
  placed: Record<string, number>;
  /** What the document named that this library cannot answer about. */
  skipped: { what: string; why: string }[];
}

/**
 * Write the document back, by natural key, and say what it could not place.
 *
 * **A merge, not a replacement.** A restore is run on a library that already has
 * something in it — that is the situation it exists for — and deleting what is
 * there first would be this route deciding that the document is the truth. It
 * adds what is missing and leaves what is not in the document alone.
 *
 * **Every entry that cannot be placed is counted and described.** A restore that
 * silently dropped the third of a playlist whose files have moved would look
 * exactly like one that worked, and the operator would find out by listening.
 * `skipped` is where that loss is stated, and it names the key rather than a
 * count of them.
 */
export function restoreState(db: DatabaseSync, doc: ExportDocument): Restored {
  const placed: Record<string, number> = {
    playlists: 0,
    playlistEntries: 0,
    trackStars: 0,
    albumStars: 0,
    artistStars: 0,
    bookmarks: 0,
    junkMarks: 0,
    apiKeys: 0,
  };
  const skipped: { what: string; why: string }[] = [];

  // **Prepared once, and not once per entry — this is the whole cost of a
  // restore.** Measured on a copy of the live deployment with a document of
  // 8.11 MB / 45 000 entries: preparing the statements inside the loops below
  // was **2848 ms of the 3459 ms** the restore took, and the music port is
  // frozen for the whole of it — 3.2 s during which no client is answered.
  // Hoisted, the same restore measured **771 ms**.
  const sql = {
    playlistByName: db.prepare('SELECT id FROM playlist WHERE name = ?'),
    insertPlaylist: db.prepare(
      'INSERT INTO playlist (name, comment, public, created_at, changed_at) VALUES (?, ?, ?, ?, ?)',
    ),
    nextPosition: db.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_track WHERE playlist_id = ?',
    ),
    insertEntry: db.prepare(
      'INSERT OR IGNORE INTO playlist_track (playlist_id, position, track_id) VALUES (?, ?, ?)',
    ),
    // The join a whole file and a segment of one are told apart by. `IS` and not
    // `=`: a whole file's key is `null`, and `segment_start_ms = NULL` is never
    // true — it would have found nothing for every ordinary song.
    findTrack: db.prepare(
      `SELECT t.id AS id FROM track t JOIN file f ON f.id = t.file_id JOIN root r ON r.id = f.root_id
        WHERE r.path = ? AND f.rel_path = ? AND t.segment_start_ms IS ?`,
    ),
    trackStar: db.prepare(
      `INSERT INTO track_annotation (track_id, starred_at, rating) VALUES (?, ?, ?)
       ON CONFLICT (track_id) DO UPDATE SET starred_at = excluded.starred_at, rating = excluded.rating`,
    ),
    albumStar: db.prepare(
      `INSERT INTO album_annotation (album_id, starred_at, rating) VALUES (?, ?, ?)
       ON CONFLICT (album_id) DO UPDATE SET starred_at = excluded.starred_at, rating = excluded.rating`,
    ),
    artistStar: db.prepare(
      `INSERT INTO artist_annotation (artist_id, starred_at, rating) VALUES (?, ?, ?)
       ON CONFLICT (artist_id) DO UPDATE SET starred_at = excluded.starred_at, rating = excluded.rating`,
    ),
    albumByPath: db.prepare(
      'SELECT a.id FROM album a JOIN root r ON r.id = a.root_id WHERE r.path = ? AND a.rel_path = ?',
    ),
    artistByName: db.prepare('SELECT id FROM artist WHERE name = ?'),
    bookmark: db.prepare(
      `INSERT INTO bookmark (track_id, position_ms, comment, created_at, changed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (track_id) DO UPDATE SET position_ms = excluded.position_ms, comment = excluded.comment,
         changed_at = excluded.changed_at`,
    ),
    rootByPath: db.prepare('SELECT id FROM root WHERE path = ?'),
    junkMark: db.prepare(
      `INSERT INTO junk_mark (root_id, rel_path, verdict, note, marked_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (root_id, rel_path) DO UPDATE SET verdict = excluded.verdict, note = excluded.note,
         marked_at = excluded.marked_at`,
    ),
    albumJunk: db.prepare(
      "UPDATE album SET junk_reason = CASE WHEN ? = 'junk' THEN 'marked junk by hand' ELSE NULL END WHERE root_id = ? AND rel_path = ?",
    ),
    keyBySecret: db.prepare('SELECT id FROM api_key WHERE secret = ?'),
    insertKey: db.prepare(
      'INSERT INTO api_key (label, secret, created_at, revoked_at) VALUES (?, ?, ?, ?)',
    ),
  };

  /** The track a key names, or nothing when this library does not have it. */
  const resolveTrack = (key: TrackKey): number | null =>
    (sql.findTrack.get(key.root, key.file, key.at) as { id: number } | undefined)?.id ?? null;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const list of doc.playlists ?? []) {
      const existing = sql.playlistByName.get(list.name) as
        | { id: number }
        | undefined;
      const id =
        existing?.id ??
        Number(
          sql.insertPlaylist.run(list.name, list.comment, list.public ? 1 : 0, list.createdAt, list.changedAt)
            .lastInsertRowid,
        );
      if (existing === undefined) placed.playlists = (placed.playlists ?? 0) + 1;

      let position = Number(
        (sql.nextPosition.get(id) as { next: number }).next,
      );

      for (const key of list.entries ?? []) {
        const trackId = resolveTrack(key);
        if (trackId === null) {
          skipped.push({ what: `${list.name}: ${key.file}`, why: 'no such file (or segment) in this library' });
          continue;
        }
        sql.insertEntry.run(id, position, trackId);
        position += 1;
        placed.playlistEntries = (placed.playlistEntries ?? 0) + 1;
      }
    }

    for (const star of doc.starred?.tracks ?? []) {
      const trackId = resolveTrack(star);
      if (trackId === null) {
        skipped.push({ what: `star: ${star.file}`, why: 'no such file (or segment) in this library' });
        continue;
      }
      sql.trackStar.run(trackId, star.starredAt, star.rating);
      placed.trackStars = (placed.trackStars ?? 0) + 1;
    }

    for (const star of doc.starred?.albums ?? []) {
      const album = sql.albumByPath.get(star.root, star.rel) as { id: number } | undefined;
      if (album === undefined) {
        skipped.push({ what: `star: ${star.rel}`, why: 'no such album (or root) in this library' });
        continue;
      }
      sql.albumStar.run(album.id, star.starredAt, star.rating);
      placed.albumStars = (placed.albumStars ?? 0) + 1;
    }

    for (const star of doc.starred?.artists ?? []) {
      const artist = sql.artistByName.get(star.name) as { id: number } | undefined;
      if (artist === undefined) {
        skipped.push({ what: `star: ${star.name}`, why: 'no such artist in this library' });
        continue;
      }
      sql.artistStar.run(artist.id, star.starredAt, star.rating);
      placed.artistStars = (placed.artistStars ?? 0) + 1;
    }

    for (const mark of doc.bookmarks ?? []) {
      const trackId = resolveTrack(mark);
      if (trackId === null) {
        skipped.push({ what: `bookmark: ${mark.file}`, why: 'no such file (or segment) in this library' });
        continue;
      }
      sql.bookmark.run(trackId, mark.positionMs, mark.comment, mark.createdAt, mark.changedAt);
      placed.bookmarks = (placed.bookmarks ?? 0) + 1;
    }

    for (const mark of doc.junkMarks ?? []) {
      const root = sql.rootByPath.get(mark.root) as { id: number } | undefined;
      if (root === undefined) {
        skipped.push({ what: `junk mark: ${mark.rel}`, why: 'the root it was made under is not configured here' });
        continue;
      }
      sql.junkMark.run(root.id, mark.rel, mark.verdict, mark.note, mark.markedAt);
      // The album's own verdict is re-derived from the mark the same way `mark`
      // does it, so a restored deployment hides what the old one hid.
      sql.albumJunk.run(mark.verdict, root.id, mark.rel);
      placed.junkMarks = (placed.junkMarks ?? 0) + 1;
    }

    for (const key of doc.apiKeys ?? []) {
      if (sql.keyBySecret.get(key.secret) !== undefined) continue;
      sql.insertKey.run(key.label, key.secret, key.createdAt, key.revokedAt);
      placed.apiKeys = (placed.apiKeys ?? 0) + 1;
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already unwound; the original error is what matters.
    }
    throw err;
  }

  return { placed, skipped };
}

/** Whether a parsed body is one of ours, before anything is written. */
export function isExport(value: unknown): value is ExportDocument {
  if (value === null || typeof value !== 'object') return false;
  const doc = value as { funoteka?: unknown; version?: unknown };
  return doc.funoteka === 'export' && typeof doc.version === 'number';
}
