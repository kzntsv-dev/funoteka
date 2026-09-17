import { appendFileSync } from 'node:fs';

/**
 * What the admin surface did, written down where it can be read afterwards.
 *
 * A control surface that changes a server and keeps no record of it is a surface
 * whose mistakes cannot be found: the port was moved, the token was rotated, the
 * server restarted — by whom, from where, and at what time are the questions
 * asked *after* something went wrong, and a request log that was turned off is
 * no answer to them.
 *
 * So this is **mutations only**, and it is not the request log: `GET /config`
 * happens whenever somebody looks, and a record of looking is noise that buries
 * the record of changing. Everything that changes something is here, including
 * the ones that were refused — a refusal is often the interesting line.
 *
 * One JSON object per line, appended, and the file is the whole of the storage.
 * It lives beside the meta layer because that is where this deployment's own
 * data already is, and it is a file rather than a table because the thing most
 * likely to have gone wrong is the database: a record of what was done to it
 * should not be inside it.
 */

export interface AuditEntry {
  /** When, in UTC, as everything else in this project is. */
  at: string;
  method: string;
  path: string;
  /** Who asked, as the address the request arrived from. */
  address: string;
  /** What the answer said. A refusal is recorded too, and is often the reason to read this. */
  status: number;
  /** What it changed, where the route can say. */
  detail?: Record<string, unknown>;
}

/** Where a deployment's audit lines go when nobody says otherwise. */
export function auditPath(dbPath: string): string {
  return `${dbPath}.audit.jsonl`;
}

/**
 * A writer for one audit file.
 *
 * **Appended synchronously**, which is the unusual choice and the deliberate
 * one: these lines are rare (a person operating a server, not a client polling
 * it), so the cost is nothing, and what it buys is that the line exists before
 * the answer does. A buffered writer loses exactly the lines written just before
 * a crash, which are the ones somebody will want.
 *
 * A file that cannot be written is said on stderr and reported in the answer
 * rather than thrown: the mutation has already happened by the time this runs,
 * and failing the request would describe it as not having happened. What the
 * caller is owed is the truth about both halves — it was done, and it was not
 * recorded.
 */
export function auditLog(path: string): (entry: AuditEntry) => boolean {
  return (entry) => {
    try {
      appendFileSync(path, `${JSON.stringify(entry)}\n`);
      return true;
    } catch (err) {
      process.stderr.write(`funoteka admin: could not write ${path} (${(err as Error).message})\n`);
      return false;
    }
  };
}
