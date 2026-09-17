import type { DatabaseSync } from '../db/index.ts';
import { unchangedCount } from '../db/ledger.ts';
import { hidden } from '../junk/marks.ts';

/**
 * Render the classified collection as a document a human reads.
 *
 * This is the acceptance instrument (requirements:39 §9): every check v1 is
 * judged by — pressings staying separate albums, a box reading as one release
 * with its discs, the same album in two roots staying two, a cue album listing
 * N tracks rather than one, Cyrillic surviving the trip, and the counters
 * adding up — has to be visible here, or it is not checkable by the person the
 * contract answers to.
 *
 * Read-only, and deterministic by construction: same database, same bytes.
 * Two dumps of an untouched collection differ only in the lines naming the run
 * they describe, which is what makes "the rescan changed nothing" something one
 * looks at rather than something one believes. The ledger line says how much of
 * the collection the last walk found unmoved, so that claim is legible from the
 * dump alone.
 *
 * The machine-readable form remains the database itself.
 */

/** Minutes and seconds, or an explicit dash when nothing measured it. */
function duration(ms: number | null): string {
  if (ms === null || ms < 0) return '--:--';
  const total = Math.round(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const tail = `${minutes}:${String(seconds).padStart(2, '0')}`;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : tail;
}

/** `label total  (key n, key n)`, omitting the keys that are zero. */
function breakdown(
  total: number,
  label: string,
  counts: Record<string, number> = {},
): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${key} ${n}`);
  return `  ${label.padEnd(9)}${String(total).padEnd(7)}${parts.length === 0 ? '' : `(${parts.join(', ')})`}`;
}

function tally(rows: { key: string | null; n: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key ?? 'none', row.n]));
}

function count(db: DatabaseSync, sql: string, ...args: (string | number)[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

/**
 * Every row of an album-keyed query, gathered under its album.
 *
 * **One query for the collection rather than one per album.** Three of the things
 * the dump asks for are per-album reads, and asking them inside the loop below
 * is what made `GET /inventory` cost **233.9 ms** on a 472-album collection: 1416
 * statement executions, three for every album. Grouped here, the same three
 * queries are executed three times in all.
 *
 * The order inside a group is the order the query was written with, which is
 * what keeps the dump byte-identical — the promise this file opens with.
 */
function byAlbum<T extends { albumId: number }>(rows: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const row of rows) {
    const list = out.get(row.albumId);
    if (list === undefined) out.set(row.albumId, [row]);
    else list.push(row);
  }
  return out;
}

export function inventory(db: DatabaseSync, options: { dbPath?: string } = {}): string {
  const lines: string[] = [];
  const where = options.dbPath === undefined ? '' : ` — ${options.dbPath}`;
  lines.push(`funoteka inventory${where}`);

  const run = db
    .prepare('SELECT id, status, started_at FROM scan_run ORDER BY id DESC LIMIT 1')
    .get() as { id: number; status: string; started_at: string } | undefined;

  if (run === undefined) {
    lines.push('', 'No scan has run against this database.', '');
    return lines.join('\n');
  }

  lines.push(`run ${run.id} · ${run.status} · ${run.started_at}`, '');

  const roots = db.prepare('SELECT id, path FROM root ORDER BY id').all() as {
    id: number;
    path: string;
  }[];
  // Albums carry the root they belong to, and identity is root-qualified, so a
  // short marker is what lets two roots hold the same relative path and stay
  // legibly two albums.
  const marks = new Map(roots.map((root, index) => [root.id, `#${index + 1}`]));

  const perRoot = (sql: string): Map<number, number> =>
    new Map(
      (db.prepare(sql).all() as { root_id: number; n: number }[]).map((row) => [row.root_id, row.n]),
    );
  const foldersByRoot = perRoot('SELECT root_id, COUNT(*) AS n FROM folder GROUP BY root_id');
  const filesByRoot = perRoot('SELECT root_id, COUNT(*) AS n FROM file GROUP BY root_id');
  const albumsByRoot = perRoot('SELECT root_id, COUNT(*) AS n FROM album GROUP BY root_id');

  lines.push('roots');
  for (const root of roots) {
    lines.push(
      `  ${(marks.get(root.id) ?? '?').padEnd(4)}${root.path}`,
      `      folders ${foldersByRoot.get(root.id) ?? 0}   files ${filesByRoot.get(root.id) ?? 0}   albums ${albumsByRoot.get(root.id) ?? 0}`,
    );
  }

  const fileTotal = count(db, 'SELECT COUNT(*) AS n FROM file');
  const unmoved = unchangedCount(db, run.id);

  lines.push('', 'counters');
  lines.push(
    breakdown(
      count(db, 'SELECT COUNT(*) AS n FROM folder'),
      'folders',
      tally(
        db.prepare('SELECT role AS key, COUNT(*) AS n FROM folder GROUP BY role').all() as {
          key: string | null;
          n: number;
        }[],
      ),
    ),
  );
  lines.push(
    breakdown(
      fileTotal,
      'files',
      tally(
        db.prepare('SELECT kind AS key, COUNT(*) AS n FROM file GROUP BY kind').all() as {
          key: string | null;
          n: number;
        }[],
      ),
    ),
  );
  // `scanned = visible + hidden`, stated here because the dump is where the
  // contract promised it would be (Q14, brainstorm:190) and because a filter
  // nobody can see the size of is a filter nobody can check. What is hidden is
  // named below the counters, with its reason — a count alone cannot tell a rule
  // that overreached from a folder somebody marked.
  const hiddenAlbums = hidden(db);
  lines.push(
    breakdown(count(db, 'SELECT COUNT(*) AS n FROM album'), 'albums', {
      hidden: hiddenAlbums.length,
    }),
  );
  lines.push(breakdown(count(db, 'SELECT COUNT(*) AS n FROM track'), 'tracks'));
  lines.push(breakdown(count(db, 'SELECT COUNT(*) AS n FROM release'), 'releases'));
  lines.push(
    breakdown(count(db, 'SELECT COUNT(*) AS n FROM artist'), 'artists', {
      ambiguous: count(db, 'SELECT COUNT(*) AS n FROM artist WHERE ambiguous = 1'),
    }),
  );
  lines.push(
    breakdown(
      count(db, 'SELECT COUNT(*) AS n FROM issue WHERE scan_run_id = ?', run.id),
      'issues',
      tally(
        db
          .prepare(
            'SELECT severity AS key, COUNT(*) AS n FROM issue WHERE scan_run_id = ? GROUP BY severity',
          )
          .all(run.id) as { key: string | null; n: number }[],
      ),
    ),
  );
  // What the last walk found unmoved. Without it the dump cannot say whether a
  // rescan did anything, which is half of what it is for.
  lines.push(`  ${'ledger'.padEnd(9)}${unmoved} of ${fileTotal} files unmoved since the last walk`);

  // "No silent loss", stated as the things that must be zero. An audio file is
  // accounted for when the meta layer can name it: a whole-file track points at
  // it, or it is the image a cue splits.
  lines.push('', 'unaccounted');
  const unaccounted: [string, number][] = [
    ['folders with no role', count(db, 'SELECT COUNT(*) AS n FROM folder WHERE role IS NULL')],
    [
      'albums with no track',
      count(
        db,
        'SELECT COUNT(*) AS n FROM album a WHERE NOT EXISTS (SELECT 1 FROM track t WHERE t.album_id = a.id)',
      ),
    ],
    [
      'audio files with no track or cue',
      count(
        db,
        `SELECT COUNT(*) AS n FROM file f
          WHERE f.kind = 'audio'
            AND NOT EXISTS (SELECT 1 FROM track t WHERE t.file_id = f.id)
            AND NOT EXISTS (SELECT 1 FROM cue c WHERE c.audio_file_id = f.id)`,
      ),
    ],
  ];
  for (const [label, n] of unaccounted) lines.push(`  ${label.padEnd(34)}${n}`);

  // What the filter keeps out, by name. Printed before the collection rather
  // than after, because it is the one part of the dump that is an *absence*:
  // everything below is what is there, and a reader who does not see this
  // section cannot tell a hidden folder from a folder that never existed.
  lines.push('', `hidden (${hiddenAlbums.length})`);
  if (hiddenAlbums.length === 0) {
    lines.push('  none');
  }
  for (const row of hiddenAlbums) {
    const where = row.relPath === '' ? '(the root itself)' : row.relPath;
    lines.push(
      `  ${(row.source === 'hand' ? 'hand' : 'scan').padEnd(6)}${(marks.get(row.rootId) ?? '?').padEnd(4)}${where.padEnd(44)}${row.title ?? ''}  —  ${row.junkReason}`,
    );
  }

  const albums = db
    .prepare(
      `SELECT a.id AS id, a.root_id AS root_id, a.rel_path AS rel_path, a.title AS title,
              a.disc_number AS disc_number, rel.title AS release_title,
              a.credit_raw AS credit_raw,
              a.artist_id AS artist_id, ar.name AS artist_name, ar.name_key AS artist_key
         FROM album a
         LEFT JOIN artist ar ON ar.id = a.artist_id
         LEFT JOIN release rel ON rel.id = a.release_id
        ORDER BY (ar.name_key IS NULL), ar.name_key, a.root_id, a.rel_path`,
    )
    .all() as {
    id: number;
    root_id: number;
    rel_path: string;
    title: string | null;
    disc_number: number | null;
    release_title: string | null;
    credit_raw: string | null;
    artist_id: number | null;
    artist_name: string | null;
    artist_key: string | null;
  }[];

  // Counted once rather than rescanning the album list per artist, and counted
  // by id rather than by name: two artists can share a name — that is the whole
  // point of the folder split — and counting by name would show them as one
  // artist owning both, hiding the split exactly where a human looks for it.
  const ownedByArtist = new Map<number | null, number>();
  for (const album of albums) {
    ownedByArtist.set(album.artist_id, (ownedByArtist.get(album.artist_id) ?? 0) + 1);
  }

  // Only ever read to show a credit that is more than one name: a single name
  // is already on the album's line, and repeating it would be noise on every
  // one of the collection's albums.
  const creditOf = byAlbum(
    db
      .prepare(
        `SELECT ac.album_id AS albumId, ar.name AS name, ac.join_phrase AS join_phrase
           FROM artist_credit ac JOIN artist ar ON ar.id = ac.artist_id
          ORDER BY ac.album_id, ac.position`,
      )
      .all() as { albumId: number; name: string; join_phrase: string }[],
  );

  // A track's credit, resolved to the rows the artist stage made of it. Written
  // only where the track says something the record does not — see that stage —
  // so a track with no row here is one whose record already speaks for it.
  const trackCreditOf = byAlbum(
    db
      .prepare(
        `SELECT t.album_id AS albumId, tc.track_id AS track_id, ar.name AS name,
                tc.join_phrase AS join_phrase
           FROM track_credit tc
           JOIN track t ON t.id = tc.track_id
           JOIN artist ar ON ar.id = tc.artist_id
          ORDER BY t.album_id, tc.track_id, tc.position`,
      )
      .all() as { albumId: number; track_id: number; name: string; join_phrase: string }[],
  );

  // A track's own PERFORMER, reached through the cue bound to the file it plays
  // from. That binding is the one `applyCues` settled: a second cue naming the
  // same audio is diagnosed and left unbound (`cue-unmatched`), so there is one
  // answer here rather than a choice between documents.
  //
  // The raw string and not an artist: `artist/apply.ts` argues why
  // `track.artist_id` stays empty, and what a reader needs to see is that the
  // parser did not drop what the cue said. A compilation is where that matters
  // — the record is credited `Various Artists`, which is true of the record and
  // false of every track on it (task:2727 §6).
  const tracksOf = byAlbum(
    db
      .prepare(
        `SELECT t.album_id AS albumId, t.id AS id, t.ordinal AS ordinal, t.title AS title,
                t.segment_start_ms AS start_ms, t.segment_end_ms AS end_ms,
                t.duration_ms AS duration_ms, f.rel_path AS file_rel_path,
                (SELECT ct.performer
                   FROM cue c JOIN cue_track ct ON ct.cue_id = c.id
                  WHERE c.audio_file_id = t.file_id AND ct.ordinal = t.ordinal
                  ORDER BY c.id LIMIT 1) AS performer
           FROM track t JOIN file f ON f.id = t.file_id
          ORDER BY t.album_id, t.ordinal`,
      )
      .all() as {
      albumId: number;
      id: number;
      ordinal: number;
      title: string | null;
      start_ms: number | null;
      end_ms: number | null;
      duration_ms: number | null;
      file_rel_path: string;
      performer: string | null;
    }[],
  );

  lines.push('', 'artists');
  let currentArtist: number | null | undefined;
  for (const album of albums) {
    if (album.artist_id !== currentArtist) {
      currentArtist = album.artist_id;
      const owned = ownedByArtist.get(currentArtist) ?? 0;

      // A suffixed key is the one mark that tells two same-named artists apart,
      // and the dump shows only the display name — so without this a split
      // prints as two identical blocks and the reader cannot tell which is
      // which. The key is noise for every artist that won its name outright,
      // so it is shown only when it carries the split's `#`.
      const key = album.artist_key;
      const mark = key === null || !key.includes('#') ? '' : `  [${key}]`;

      lines.push(
        '',
        `  ${(album.artist_name ?? '(unattributed)').padEnd(40)}  ${owned} album${owned === 1 ? '' : 's'}${mark}`,
      );
    }

    const tracks = tracksOf.get(album.id) ?? [];
    const split = tracks.some((track) => track.start_ms !== null);
    const label = album.rel_path === '' ? '(the root itself)' : album.rel_path;
    const disc = album.disc_number === null ? '' : `  disc ${album.disc_number}`;
    const box = album.release_title === null ? '' : ` of ${album.release_title}`;

    // What varies in length — the path, the title, the release — goes last.
    // Padded columns read better until a name outgrows them, at which point
    // they run into the next column and the dump stops being readable exactly
    // where the interesting records are.
    const facts = `${tracks.length} track${tracks.length === 1 ? '' : 's'}${split ? '  split' : ''}${disc}${box}`;
    lines.push(
      `    ${(marks.get(album.root_id) ?? '?').padEnd(4)}${facts.padEnd(30)}  ·  ${label}  —  ${album.title ?? ''}`,
    );

    const credit = creditOf.get(album.id) ?? [];
    if (credit.length > 1) {
      // Rebuilt from the parts rather than echoed from `credit_raw`, so what is
      // printed proves the list and its phrases really do reassemble.
      const rebuilt = credit.map((entry) => entry.join_phrase + entry.name).join('');
      lines.push(`        credit  ${rebuilt}`);
    }

    // The tracks whose credit is not the record's, resolved to people. A track
    // line that showed the cue's own string would be showing a string where the
    // meta layer holds an identity — and where the stage declined to resolve one
    // (the 120 names only a track states), the string is what is left and is
    // shown instead, so a refusal is visible rather than an empty column
    // (task:2729).
    const trackCredits = new Map<number, string>();
    for (const row of trackCreditOf.get(album.id) ?? []) {
      const soFar = trackCredits.get(row.track_id) ?? '';
      trackCredits.set(row.track_id, soFar + row.join_phrase + row.name);
    }

    for (const track of tracks) {
      const segment =
        track.start_ms === null ? '' : `  [${duration(track.start_ms)}–${duration(track.end_ms)}]`;

      // Only where the track says something the record does not. Eleven of the
      // sample's albums state one performer and it is the record's own; printing
      // it on every line is the repetition the credit has already refused to
      // make, and it would bury the tracks that do differ — a compilation's
      // every track, a live disc's `Публика` — in a column of the same name.
      //
      // The resolved credit is what is shown when there is one, because that is
      // what the meta layer holds: a row in `artist`, which search and the tree
      // can follow. The cue's own string is the fallback — a name the stage
      // declined to resolve, or one it refused as a note about the room — and it
      // is shown rather than dropped so the refusal is visible here too.
      const credit = trackCredits.get(track.id);
      const performer =
        credit !== undefined
          ? `  ·  ${credit}`
          : track.performer !== null &&
              track.performer.trim() !== '' &&
              track.performer !== album.credit_raw
            ? `  ·  ${track.performer}`
            : '';

      lines.push(
        `        ${`${String(track.ordinal).padStart(2, '0')}.`.padEnd(5)}${duration(track.duration_ms).padEnd(7)}` +
          `·  ${track.title ?? '(untitled)'}  ·  ${track.file_rel_path}${segment}${performer}`,
      );
    }
  }

  const issues = db
    .prepare(
      `SELECT kind, severity, rel_path, root_id, detail FROM issue
        WHERE scan_run_id = ?
        ORDER BY severity DESC, kind, root_id, rel_path`,
    )
    .all(run.id) as {
    kind: string;
    severity: string;
    rel_path: string | null;
    root_id: number | null;
    detail: string | null;
  }[];

  lines.push('', `issues (run ${run.id})`);
  if (issues.length === 0) lines.push('  none');
  for (const issue of issues) {
    const mark = issue.root_id === null ? '' : (marks.get(issue.root_id) ?? '');
    lines.push(
      `  ${issue.severity.padEnd(6)}${issue.kind.padEnd(24)}${mark.padEnd(4)}${(issue.rel_path ?? '').padEnd(40)}${issue.detail ?? ''}`,
    );
  }
  lines.push('');

  return lines.join('\n');
}
