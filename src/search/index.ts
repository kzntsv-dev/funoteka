import type { DatabaseSync } from '../db/index.ts';

/**
 * The search index, built from the meta layer.
 *
 * `track_fts` has been in the schema since the first migration — declared with
 * `unicode61 remove_diacritics 2`, which is a tokenizer that folds case the way
 * Unicode says to — and nothing has ever written to it. This is the stage that
 * was missing.
 *
 * It indexes *songs*, and the artists and albums of a search result are found
 * through them. That is not a shortcut: a record is the folder its songs are in
 * and an artist is whoever owns that record (the identity rule the whole meta
 * layer is built on), so a collection with no songs has no albums or artists to
 * offer a client either. One table, and the three sections of a search answer
 * from one match.
 *
 * The rebuild is total rather than incremental. A stage that derives its rows
 * from the present and replaces them is the rule the other stages already keep,
 * and the alternative here is worse than it looks: an index is a copy, so
 * incrementally updating it means tracking which of the four stages above
 * changed which row's text — a second, larger, silent source of drift about a
 * structure that exists only to be thrown away and rebuilt.
 *
 * `optimize` after the delete is what keeps that honest over time: FTS5 marks
 * deleted rows rather than removing them, so a scan run daily would otherwise
 * grow the index file with the text of every title the collection ever had.
 */
export interface SearchCounters {
  /** Rows the index holds once the rebuild finished. */
  rows: number;
}

export function rebuildSearchIndex(db: DatabaseSync): SearchCounters {
  try {
    // `IMMEDIATE`, and here the word is load-bearing rather than prophylactic.
    //
    // The `DELETE` below goes through FTS5, which reads before it writes — so a
    // deferred `BEGIN` takes its read snapshot first, and the write that follows
    // is an upgrade: meeting another writer, it is refused at once without ever
    // consulting the busy handler. Measured against a held lock, this stage
    // gives up in **0 ms** where the other three wait. `db/index.ts` has the
    // rule (task:2871).
    db.exec('BEGIN IMMEDIATE');

    db.exec('DELETE FROM track_fts');
    db.prepare(
      // The *record's* name, which for a box is its release folder's. A disc's
      // own title is `CD1 ● Альбом`, and indexing that would make a box findable
      // by a name no client is ever shown — while the name it is shown, the
      // record's, would find nothing.
      `INSERT INTO track_fts (rowid, title, artist, album)
       SELECT t.id,
              COALESCE(t.title, ''),
              COALESCE(ar.name, ''),
              COALESCE(rel.title, al.title, '')
         FROM track t
         LEFT JOIN album al ON al.id = t.album_id
         LEFT JOIN release rel ON rel.id = al.release_id
         LEFT JOIN artist ar ON ar.id = COALESCE(al.artist_id, rel.artist_id)`,
    ).run();
    db.exec(`INSERT INTO track_fts (track_fts) VALUES ('optimize')`);

    const counted = db.prepare('SELECT COUNT(*) AS n FROM track_fts').get() as { n: number };
    db.exec('COMMIT');

    return { rows: counted.n };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already unwound; the original error is what matters.
    }
    throw err;
  }
}
