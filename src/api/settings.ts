/**
 * The vocabulary: what a setting is called and what shape its value has.
 *
 * One table, because two things need it and neither owns it — the config file,
 * which has to refuse a key it does not know, and the config itself, which has
 * to know which keys exist to say where each one came from. A second copy of
 * this list is how a setting becomes writable by one half and invisible to the
 * other.
 *
 * These are the field names of `ServerConfig` and `AdminConfig`, which are also
 * the names the admin API's `config` route speaks. The environment spells them
 * differently (`FUNOTEKA_DB` for `dbPath`, `FUNOTEKA_CACHE` for `cacheDir`), and
 * that mapping lives where the reading happens.
 */
export const SETTINGS: Readonly<Record<string, 'string' | 'number' | 'boolean'>> = {
  dbPath: 'string',
  host: 'string',
  port: 'number',
  user: 'string',
  password: 'string',
  apiKey: 'string',
  ffmpeg: 'string',
  cacheDir: 'string',
  logFile: 'string',
  logRequests: 'boolean',
  cors: 'boolean',
  showJunk: 'boolean',
  adminPort: 'number',
  adminHost: 'string',
  adminToken: 'string',
  adminAllow: 'string',
  adminTrustProxy: 'boolean',
  adminTlsCert: 'string',
  adminTlsKey: 'string',
  supervised: 'boolean',
  scanInterval: 'number',
  scanQuietFrom: 'number',
  scanQuietTo: 'number',
  scanWatch: 'boolean',
};

/**
 * The numbers that are ports, and are therefore held to a port's range.
 *
 * Which does not go without saying: this vocabulary now carries numbers that are
 * *not* ports — a scan interval in minutes, an hour of the day — and a reader
 * that held every number to 65535 and called a violation "not a port number"
 * would refuse `scanInterval: 100000` with a sentence about sockets.
 */
export const PORT_SETTINGS: ReadonlySet<string> = new Set(['port', 'adminPort']);

/**
 * The settings whose value is never handed back, only ever accepted.
 *
 * `config get` reports that they are set and where from, and not what they are:
 * a token read back over HTTP is a token in a shell history, a log line and
 * whatever proxy is in front, and the operator who needs to see it already has
 * the file it is in.
 */
export const SECRET_SETTINGS: ReadonlySet<string> = new Set(['password', 'adminToken', 'apiKey']);

/**
 * Whether a number can be a port, which is the range a socket accepts.
 *
 * 0 is inside it on purpose: it asks the kernel to pick a free port, which is
 * what a test does and what an operator whose port is taken does.
 */
export function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}
