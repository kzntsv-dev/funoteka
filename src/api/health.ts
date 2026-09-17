import type { DatabaseSync } from '../db/index.ts';
import { SERVER_VERSION } from './envelope.ts';

/**
 * Whether this server is alive and able to read its own meta layer.
 *
 * **A surface of its own, outside `/rest/`, and the reason is who asks.** Every
 * other route here answers a client about the collection; this one answers a
 * *supervisor* about the process — Docker's healthcheck, a systemd `ExecCondition`,
 * a NAS's monitoring, whoever is looking at a machine that has gone quiet. Those
 * askers have one thing in common: they have no credentials and no way to get
 * one, because they run before anyone has logged in and they must keep working
 * when the credentials are the thing that is wrong. So this route is public, and
 * it is public because there is nothing in it to protect.
 *
 * **It says nothing about the collection.** Not how many songs, not what was
 * scanned, not which roots — a stranger who finds the port learns that there is
 * a funoteka here and nothing else. What it does say is the one fact a probe can
 * act on: the process answers, and the meta layer it serves is readable.
 *
 * The uptime is here because it is the question an operator asks second, after
 * "is it up": a server that has been up for four seconds has been restarting,
 * and a log full of nothing looks the same either way.
 */

/** An answer: the status line's number, and the body as it goes on the wire. */
export interface Health {
  status: number;
  body: string;
}

/** Seconds this process has been up, which is health's own business to report. */
export const startedAgo = (): number => process.uptime();

/**
 * Read the meta layer and answer.
 *
 * A read that throws is the failure this route exists to catch, and it is
 * answered rather than propagated: a database that has been replaced by a
 * directory, a disk that has gone read-only, a file another process has locked
 * for longer than a transaction should — each of them is a server that is *up*
 * and cannot serve, which is a different state from "not running" and the one a
 * supervisor must be told about.
 *
 * The schema version is read from the database rather than from the build's own
 * constant: what a reader wants to know is what the *file* is at, and a build
 * that expected a migration the file never got is exactly the mismatch this
 * number makes visible.
 */
export function health(db: DatabaseSync, uptimeSeconds: number = startedAgo()): Health {
  const base = {
    server: 'funoteka',
    version: SERVER_VERSION,
    uptime: Math.round(uptimeSeconds * 10) / 10,
  };

  try {
    const read = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return { status: 200, body: JSON.stringify({ status: 'ok', ...base, schema: read.user_version }) };
  } catch (err) {
    return {
      status: 503,
      body: JSON.stringify({ status: 'failed', ...base, error: (err as Error).message }),
    };
  }
}
