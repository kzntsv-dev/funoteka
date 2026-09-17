import { addKey, listKeys, revokeKey, type ApiKey } from '../api/keys.ts';
import type { DatabaseSync } from '../db/index.ts';

/**
 * The `keys` command, as text a person reads.
 *
 * Kept out of the entry point for the same reason the other reports are: what
 * the command *says* is testable without spawning a process, and the wording is
 * the part of a key registry that decides whether anyone dares use it.
 *
 * **The environment's key is listed, and it is listed first.** A person asking
 * "which keys does this server accept" is owed the answer in full — a listing
 * that showed only the registered ones would say "one key" to a server that
 * accepts two, and the one it left out is the one every existing client is
 * probably using. What it says about that key is where it lives, because that is
 * where it is revoked.
 */
export function reportKeys(db: DatabaseSync, environmentKey: string): string {
  const lines: string[] = [];

  if (environmentKey !== '') {
    lines.push(
      'from the environment (FUNOTEKA_APIKEY) — always valid, revoked by editing start.cmd:',
      `  ${environmentKey}`,
      '',
    );
  } else {
    // **Said even though there is nothing to show.** The daemon is started by
    // `start.cmd`, which sets this variable in its own process; a person running
    // this command in an ordinary shell has it unset while the server they are
    // asking about has it set. Silence here reads as "none" — which is how you
    // spend an afternoon looking for a key that is working exactly as intended.
    lines.push(
      'from the environment (FUNOTEKA_APIKEY): not set in this shell.',
      '  The daemon is started by start.cmd, which sets it in its own process — this',
      '  command does not read that file. If a client is using a key that is not listed',
      '  below, that is where it is, and editing that file is how it is revoked.',
      '',
    );
  }

  const keys = listKeys(db);
  const active = keys.filter((key) => key.revokedAt === null);

  lines.push(
    active.length === 0
      ? 'registered keys: none'
      : `registered keys (${active.length} active):`,
    ...active.map((key) => `  #${key.id}  ${key.label}  added ${key.createdAt}\n      ${key.secret}`),
  );

  const revoked = keys.filter((key) => key.revokedAt !== null);
  if (revoked.length > 0) {
    lines.push(
      '',
      `revoked (${revoked.length}) — kept so that one taken back cannot be added again:`,
      ...revoked.map((key) => `  #${key.id}  ${key.label}  revoked ${key.revokedAt}`),
    );
  }

  return `${lines.join('\n')}\n`;
}

/** What `keys add` says: the secret, once, and the id to revoke it by. */
export function addedKey(key: ApiKey): string {
  return (
    `#${key.id}  ${key.label}\n` +
    `  ${key.secret}\n` +
    '  A client presents this as `apiKey`, on its own — no `u` beside it.\n' +
    `  Take it back with: funoteka keys revoke ${key.id}\n`
  );
}

/** What `keys revoke` says: the key that stopped being accepted. */
export function revokedKey(key: ApiKey): string {
  return (
    `#${key.id}  ${key.label} is revoked as of ${key.revokedAt}.\n` +
    '  Any client still using it is refused from now on, with no restart.\n'
  );
}

export { addKey, revokeKey };
