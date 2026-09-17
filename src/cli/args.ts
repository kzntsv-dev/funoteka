import { parseArgs } from 'node:util';

/**
 * What the command line asked for, decided in one pure step.
 *
 * Kept separate from the entry point so the decisions that matter to callers —
 * which command, which roots, which exit code — are testable without spawning a
 * process or writing to stdout. Values are carried as the strings they were
 * given in, and checked where they are turned into a config: one place decides
 * what a port is, whether it arrived as a flag or from the environment.
 */
export type CliInvocation =
  | { kind: 'help' }
  // **No command carries a resolved database path**, and that is the point: a
  // default filled in here would reach `loadConfig` as an override that beats
  // both `FUNOTEKA_DB` and the config file, so a deployment whose database is
  // named in either would have `scan` write a second one beside it. What the
  // flag said is carried as it was given, and every command resolves it the same
  // way a server does.
  | { kind: 'scan'; roots: string[]; dbPath?: string; full: boolean }
  | { kind: 'inventory'; dbPath?: string }
  // What the junk filter hid, and the allow/block edit (requirements:47 §11).
  // The three verbs are the contract's own words: `list` shows what is out,
  // `allow` keeps a folder the rule would hide, `block` hides one it would keep.
  | { kind: 'junk'; action: 'list' | 'block' | 'allow'; path?: string; note?: string; dbPath?: string }
  // The `apiKeyAuthentication` extension's second half: seeing the keys this
  // server accepts and taking one back (task:2915). `add` says what it is for,
  // `revoke` names one by id or by that label.
  | { kind: 'keys'; action: 'list' | 'add' | 'revoke'; what?: string; dbPath?: string }
  | { kind: 'serve'; daemon: boolean; dbPath?: string; host?: string; port?: string }
  // The MCP server an agent starts: it speaks the protocol on stdin and
  // stdout and calls the admin API over the loopback. The token is not a flag —
  // it comes from the same environment the server reads it from, because an
  // argument is readable from the process list.
  | { kind: 'mcp'; url?: string }
  | { kind: 'stop'; dbPath?: string }
  | { kind: 'status'; dbPath?: string }
  | { kind: 'error'; message: string; code: number };

/** Usage errors share a code so scripts can tell them from a failed scan. */
const USAGE_ERROR = 2;

const COMMANDS: ReadonlySet<string> = new Set([
  'scan',
  'inventory',
  'serve',
  'stop',
  'status',
  'junk',
  'keys',
  'mcp',
]);

/** What `junk` can be asked to do, and the verdict each verb writes. */
const JUNK_ACTIONS: ReadonlySet<string> = new Set(['list', 'block', 'allow']);

/** What `keys` can be asked to do. `list` takes nothing; the other two take one name. */
const KEYS_ACTIONS: ReadonlySet<string> = new Set(['list', 'add', 'revoke']);

export function resolveCommand(argv: string[]): CliInvocation {
  let values: {
    db?: string;
    help?: boolean;
    host?: string;
    port?: string;
    daemon?: boolean;
    note?: string;
    full?: boolean;
    url?: string;
  };
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        host: { type: 'string' },
        port: { type: 'string' },
        daemon: { type: 'boolean' },
        note: { type: 'string' },
        full: { type: 'boolean' },
        url: { type: 'string' },
      },
    }));
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, code: USAGE_ERROR };
  }

  if (values.help) return { kind: 'help' };

  const dbPath = values.db;
  const [command, ...roots] = positionals;
  if (command === undefined) return { kind: 'error', message: 'no command given', code: USAGE_ERROR };
  if (!COMMANDS.has(command)) {
    return { kind: 'error', message: `unknown command "${command}"`, code: USAGE_ERROR };
  }

  if (command === 'serve') {
    if (roots.length > 0) {
      return { kind: 'error', message: 'serve takes no roots', code: USAGE_ERROR };
    }
    return {
      kind: 'serve',
      daemon: values.daemon === true,
      dbPath: values.db,
      host: values.host,
      port: values.port,
    };
  }

  if (command === 'mcp') {
    if (roots.length > 0) {
      return { kind: 'error', message: 'mcp takes no arguments', code: USAGE_ERROR };
    }
    return { kind: 'mcp', url: values.url };
  }

  if (command === 'stop' || command === 'status') {
    if (roots.length > 0) {
      return { kind: 'error', message: `${command} takes no roots`, code: USAGE_ERROR };
    }
    if (values.daemon === true) {
      return { kind: 'error', message: `${command} takes no --daemon`, code: USAGE_ERROR };
    }
    return { kind: command, dbPath: values.db };
  }

  // Where to listen is the server's question alone. A flag accepted and ignored
  // is worse than one refused: the operator would believe they had moved it.
  const misplaced = [
    ...(values.host === undefined ? [] : ['--host']),
    ...(values.port === undefined ? [] : ['--port']),
    ...(values.daemon === true ? ['--daemon'] : []),
    // `--note` belongs to `junk` alone, and it is refused here rather than
    // there because this is where every command that does not take it is
    // checked. A flag accepted and ignored is worse than one refused: the
    // operator would believe the note had been kept.
    ...(values.note === undefined || command === 'junk' ? [] : ['--note']),
    // `--full` belongs to `scan` alone, and it is refused elsewhere rather than
    // there: the operator who put it on `inventory` would otherwise believe they
    // had asked for a re-read.
    ...(values.full === true && command !== 'scan' ? ['--full'] : []),
    ...(values.url === undefined || command === 'mcp' ? [] : ['--url']),
  ];
  if (misplaced.length > 0) {
    return {
      kind: 'error',
      message: `${command} takes no ${misplaced.join(' or ')}`,
      code: USAGE_ERROR,
    };
  }

  if (command === 'inventory') {
    if (roots.length > 0) {
      return { kind: 'error', message: 'inventory takes no roots', code: USAGE_ERROR };
    }
    return { kind: 'inventory', dbPath };
  }

  if (command === 'keys') {
    const [action = 'list', ...rest] = roots;
    if (!KEYS_ACTIONS.has(action)) {
      return {
        kind: 'error',
        message: `keys does not take "${action}" (one of: list, add, revoke)`,
        code: USAGE_ERROR,
      };
    }
    if (action === 'list') {
      if (rest.length > 0) {
        return { kind: 'error', message: 'keys list takes nothing', code: USAGE_ERROR };
      }
      return { kind: 'keys', action: 'list', dbPath };
    }
    if (rest.length !== 1 || rest[0] === '') {
      return {
        kind: 'error',
        message:
          action === 'add'
            ? 'keys add needs one label — what the key is for, or whose it is'
            : 'keys revoke needs one id or label',
        code: USAGE_ERROR,
      };
    }
    return { kind: 'keys', action: action as 'add' | 'revoke', what: rest[0], dbPath };
  }

  if (command === 'junk') {
    const [action = 'list', ...rest] = roots;
    if (!JUNK_ACTIONS.has(action)) {
      return {
        kind: 'error',
        message: `junk does not take "${action}" (one of: list, block, allow)`,
        code: USAGE_ERROR,
      };
    }
    if (action === 'list') {
      if (rest.length > 0) {
        return { kind: 'error', message: 'junk list takes no paths', code: USAGE_ERROR };
      }
      return { kind: 'junk', action: 'list', dbPath };
    }
    if (rest.length !== 1) {
      return {
        kind: 'error',
        message: `junk ${action} needs one path`,
        code: USAGE_ERROR,
      };
    }
    if (values.note !== undefined && values.note === '') {
      return { kind: 'error', message: '--note needs a value', code: USAGE_ERROR };
    }
    return {
      kind: 'junk',
      action: action as 'block' | 'allow',
      path: rest[0],
      note: values.note,
      dbPath,
    };
  }

  if (roots.length === 0) {
    return { kind: 'error', message: 'scan needs at least one root', code: USAGE_ERROR };
  }

  return { kind: 'scan', roots, dbPath, full: values.full === true };
}
