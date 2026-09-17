import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { PORT_SETTINGS, SETTINGS, isPort } from './settings.ts';

/**
 * The config file: a deployment's settings, written down where a person can
 * read them.
 *
 * The environment is how a service manager hands a server its settings, and it
 * stays the interface a deployed server is configured through. A file is for the
 * two things the environment is bad at: settings a person has to *edit* (a
 * twenty-variable `EnvironmentFile` is a file with extra steps), and settings
 * that outlive one shell — a NAS where nobody remembers which session exported
 * what. So the file is a layer between the defaults and the environment, and the
 * environment keeps the last word. The order is stated in `config.ts`; this
 * module is only the reading and the writing of it.
 *
 * A JSON object and not YAML, because this project has no dependencies and Node
 * parses JSON natively. The vocabulary is the config's own field names
 * (`settings.ts`), so the file and the admin API's `config` route speak one
 * language.
 *
 * **Nothing here is silently forgiven.** A file that cannot be parsed, a key
 * that does not exist, or a value of the wrong shape stops the command with a
 * sentence naming the file and the key. The alternative is the failure this
 * exists to prevent: a server that came up on its defaults beside a file it
 * could not read, looking exactly like a server that was configured.
 */

/** Where the file is when nobody says otherwise: the directory the server runs in. */
export const DEFAULT_CONFIG_FILE = 'funoteka.json';

/**
 * The two names a JSON object can carry that are *known* to mean nothing.
 *
 * JSON has no comments, and this is a file a person edits — `funoteka.json.example`
 * is copy-safe because of these two lines, and an example that explained itself
 * with a key the reader refused would fail on the first run of whoever copied
 * it. They are not the unknown-key rule relaxed: an unknown key is still a
 * refusal, and these are not unknown.
 */
const COMMENTS: ReadonlySet<string> = new Set(['//', '#']);

/** What a file said, once it was read and found to be readable. */
export type FileValues = Record<string, string | number | boolean>;

/** Which file this process reads, which is the one thing env alone decides. */
export function configFilePath(env: NodeJS.ProcessEnv): string {
  return env.FUNOTEKA_CONFIG ?? DEFAULT_CONFIG_FILE;
}

/**
 * Read a config file, or answer with nothing if there is no file there.
 *
 * Absent is not an error: most deployments name their settings in the
 * environment and have no file at all, and refusing to start over a file nobody
 * wrote would make the file mandatory by accident.
 */
export function readConfigFile(path: string): FileValues {
  const parsed = parse(readOf(path), path);

  const values: FileValues = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (COMMENTS.has(key)) continue;
    values[key] = validated(key, value, path);
  }

  return values;
}

/**
 * Write settings into the file, and answer with what it now says.
 *
 * **The file is read as it is and written back with only these keys changed**,
 * rather than being rebuilt from the config. That is what keeps a `//` comment
 * where somebody put it, keeps the keys in the order they were written, and
 * leaves alone any key this server does not know about — a route that rewrote
 * the whole file from its own idea of the config would silently drop the note
 * that explains the deployment to the next person.
 *
 * A value of `null` removes the key, which is how a setting written here is
 * handed back to the environment and the defaults.
 *
 * Written through a temporary file and a rename: a process that dies mid-write
 * leaves the old config or the new one, and never half of either — the file that
 * a restart reads is the file that governs whether there *is* a restart.
 */
export function writeConfigFile(
  path: string,
  changes: Readonly<Record<string, string | number | boolean | null>>,
): FileValues {
  const current = parse(readOf(path), path);

  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      delete current[key];
      continue;
    }
    current[key] = validated(key, value, path);
  }

  const temp = `${path}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, existsSync(path) ? {} : { mode: 0o600 });
    renameSync(temp, path);
  } catch (err) {
    throw new Error(`${path} could not be written: ${(err as Error).message}`);
  }

  return readConfigFile(path);
}

/** The file's text, or an empty object's worth of nothing when there is no file. */
function readOf(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
    throw new Error(`${path} could not be read: ${(err as Error).message}`);
  }
}

function parse(text: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // The parser's own sentence, quoted. It names the line and the character,
    // which is the whole of what the person editing the file needs.
    throw new Error(`${path} is not JSON: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must be an object of settings — this is ${described(parsed)}`);
  }

  return parsed as Record<string, unknown>;
}

/** One key's value, or a refusal naming the file, the key and what it should be. */
function validated(key: string, value: unknown, path: string): string | number | boolean {
  const kind = SETTINGS[key];
  if (kind === undefined) {
    throw new Error(`${path}: unknown key "${key}"${didYouMean(key)}`);
  }

  if (kind === 'number') {
    if (typeof value !== 'number') {
      throw new Error(`${path}: "${key}" must be a number, not ${described(value)}`);
    }
    // Ports are held to the range a socket accepts, and named as sockets in the
    // refusal. Every other number here — an interval in minutes, an hour of the
    // day — is the config's own to bound, and is checked where it is read.
    if (PORT_SETTINGS.has(key) && !isPort(value)) {
      throw new Error(`${path}: "${key}" is not a port number: ${value}`);
    }
    return value;
  }

  if (kind === 'string' && typeof value === 'string') return value;
  if (kind === 'boolean' && typeof value === 'boolean') return value;

  const wanted = kind === 'boolean' ? 'true or false' : 'a string';
  throw new Error(`${path}: "${key}" must be ${wanted}, not ${described(value)}`);
}

/** What a JSON value is, in words, for a refusal that has to name it. */
function described(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  const kind = typeof value;
  if (kind === 'string') return `the string ${JSON.stringify(value)}`;
  if (kind === 'number' || kind === 'boolean') return `the ${kind} ${String(value)}`;
  if (kind === 'object') return 'an object';
  return kind;
}

/**
 * The key they probably meant, when they meant one at all.
 *
 * A refusal that names the key is the whole point (see the top of this file),
 * and the person reading it has usually made a typo rather than invented a
 * setting: `prot` for `port`, `showjunk` for `showJunk`. One guessed neighbour
 * turns "unknown key" into "unknown key, did you mean port" — and it is a guess,
 * so it is offered as a question and never acted on.
 */
function didYouMean(key: string): string {
  let nearest: string | undefined;
  let best = 3;

  for (const known of Object.keys(SETTINGS)) {
    const distance = editDistance(key.toLowerCase(), known.toLowerCase());
    if (distance < best) {
      best = distance;
      nearest = known;
    }
  }

  return nearest === undefined ? '' : ` — did you mean "${nearest}"?`;
}

/**
 * How many single-character edits apart two words are — the Wagner–Fischer
 * table, one row at a time.
 *
 * The `?? 0` on every read is for the compiler's `noUncheckedIndexedAccess` and
 * never for the arithmetic: each index is inside its own row by construction,
 * and a neighbour that were somehow absent could only make the distance
 * larger — a worse guess at the key, never a wrong refusal.
 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at);

  for (let i = 1; i <= a.length; i += 1) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }

  return previous[b.length] ?? 0;
}
