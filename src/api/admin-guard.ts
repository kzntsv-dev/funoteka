/**
 * The two locks on the admin port that are not the token: an address list, and a
 * limit on how many wrong tokens one address may offer.
 *
 * Both are pure enough to test without a socket, which is the point of the file
 * existing next to the listener rather than inside it — an address comparison
 * that is subtly wrong is not something a request log will ever show you.
 *
 * **Neither of these is the gate.** The token is: it is what proves who is
 * calling. The list keeps a port from being knocked at by a machine with no
 * business knocking, and the limit keeps a good token from being *found*; a
 * deployment with both unset is still guarded by its token, and this file says
 * so rather than pretending otherwise.
 */

/**
 * A lockout after this many wrong tokens from one address.
 *
 * Ten, because a person mistyping a token twice is ordinary and a person
 * mistyping it ten times in a row is not — and because the cost of being wrong
 * is bounded on both sides: an attacker gets ten guesses per quarter hour,
 * which against a 32-byte token is not a rate worth measuring, while an operator
 * who locked themselves out can restart the process (the counter lives in
 * memory, deliberately) or wait.
 */
export const MAX_FAILURES = 10;

/** How long an address stays locked out after `MAX_FAILURES`. */
export const LOCKOUT_MS = 15 * 60_000;

export interface Guard {
  /** Whether this address may reach the port at all. */
  allowed(address: string): boolean;
  /** Whether this address is locked out for offering too many wrong tokens. */
  locked(address: string): boolean;
  /** Seconds left of a lockout, for a refusal that can say how long. */
  waitFor(address: string): number;
  /**
   * How many more wrong tokens this address may offer, or nothing when it has
   * not offered any.
   *
   * Answered because a 401 is the only moment the caller can be told the limit
   * exists — the next one is the lockout itself, which arrives without warning
   * and reads as a broken server to somebody who does not know the rule.
   */
  failuresLeft(address: string): number | undefined;
  recordFailure(address: string): void;
  recordSuccess(address: string): void;
}

/**
 * A guard over the rules an operator wrote.
 *
 * `rules` is the `allow` setting: comma-separated addresses and CIDR blocks, or
 * empty for every address. Whitespace is forgiven and an empty entry is not a
 * rule — a trailing comma in a settings file should not lock the operator out of
 * their own server.
 *
 * `now` is a parameter because a lockout is a thing about time, and a test that
 * had to wait fifteen minutes to check one would not be written.
 */
export function guard(rules: string, now: () => number = Date.now): Guard {
  const allowed = rules
    .split(',')
    .map((rule) => rule.trim())
    .filter((rule) => rule !== '')
    .map(block);

  const failures = new Map<string, { count: number; until: number }>();

  return {
    allowed: (address) => allowed.length === 0 || allowed.some((block) => block.holds(address)),

    locked: (address) => (failures.get(address)?.until ?? 0) > now(),

    waitFor: (address) => Math.ceil(((failures.get(address)?.until ?? 0) - now()) / 1000),

    failuresLeft: (address) => {
      const count = failures.get(address)?.count ?? 0;
      return count === 0 ? undefined : Math.max(0, MAX_FAILURES - count);
    },

    recordFailure: (address) => {
      const seen = failures.get(address);
      const count = (seen?.count ?? 0) + 1;

      failures.set(address, {
        count,
        until: count >= MAX_FAILURES ? now() + LOCKOUT_MS : (seen?.until ?? 0),
      });

      // Bounded memory on a port that is being attacked: entries that have
      // neither a lockout running nor a recent failure are dropped as new ones
      // arrive. Without this the map is a place a stranger can write one entry
      // per request for as long as they like.
      if (failures.size > 1_000) {
        for (const [key, value] of failures) {
          if (value.until <= now() && value.count < MAX_FAILURES) failures.delete(key);
        }
      }
    },

    // A correct token clears the count: it proves the caller knows it, and a
    // person who mistyped it five times before getting it right must not be one
    // stranger's attack away from being locked out of their own server.
    recordSuccess: (address) => {
      failures.delete(address);
    },
  };
}

/** One entry of an address list, which either holds an address or does not. */
interface Block {
  holds: (address: string) => boolean;
}

function block(rule: string): Block {
  const slash = rule.lastIndexOf('/');
  const base = bits(slash === -1 ? rule : rule.slice(0, slash));

  // **The address itself is checked, not only the length.** A rule nobody can
  // read is the worst of both answers: it silently allows nothing, closing a
  // port the operator believes is open — or, if it were read as a wildcard,
  // silently allows everything. So it is refused while the guard is being built,
  // where the sentence reaches somebody at startup with time to fix it.
  if (base.v4 === null && base.v6 === null) {
    throw new Error(`"${rule}" is not an address or a CIDR block`);
  }

  if (slash === -1) return { holds: (address) => same(bits(address), base) };

  const length = Number(rule.slice(slash + 1));
  if (!Number.isInteger(length) || length < 0 || length > base.width) {
    throw new Error(`"${rule}" is not an address or a CIDR block`);
  }

  return { holds: (address) => matches(bits(address), base, length) };
}

/**
 * An address as bits, wide enough for either family.
 *
 * IPv4 and IPv6 are kept apart rather than mapped into one space: a rule written
 * as `10.0.0.0/8` means the IPv4 address, and folding it into the IPv6 space
 * would have it match `::10.0.0.1` — which is a different machine.
 */
interface Bits {
  width: number;
  v4: number | null;
  v6: bigint | null;
}

function bits(address: string): Bits {
  // A socket reached over IPv4 on a machine with IPv6 shows it mapped:
  // `::ffff:10.0.0.5` is 10.0.0.5, and a rule that did not know that would
  // refuse the very address it names.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const text = mapped?.[1] ?? address;

  const v4 = ipv4(text);
  if (v4 !== null) return { width: 32, v4, v6: null };

  const v6 = ipv6(text);
  if (v6 !== null) return { width: 128, v4: null, v6 };

  // An address that cannot be read matches nothing, including itself.
  return { width: 128, v4: null, v6: null };
}

function same(one: Bits, other: Bits): boolean {
  if (one.width !== other.width) return false;
  return one.width === 32 ? one.v4 !== null && one.v4 === other.v4 : one.v6 !== null && one.v6 === other.v6;
}

function matches(address: Bits, base: Bits, length: number): boolean {
  if (address.width !== base.width) return false;

  if (address.width === 32) {
    if (address.v4 === null || base.v4 === null) return false;
    const mask = length === 0 ? 0 : (0xffff_ffff << (32 - length)) >>> 0;
    return ((address.v4 ^ base.v4) & mask) >>> 0 === 0;
  }

  if (address.v6 === null || base.v6 === null) return false;
  const shift = BigInt(128 - length);
  const mask = length === 0 ? 0n : ((1n << BigInt(length)) - 1n) << shift;
  return ((address.v6 ^ base.v6) & mask) === 0n;
}

/** `a.b.c.d` as a 32-bit number, or null when that is not what it is. */
function ipv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** An IPv6 address as 128 bits, or null. `::` stands for as many zero groups as it takes. */
function ipv6(text: string): bigint | null {
  // A zone — `fe80::1%eth0` — names an interface locally and means nothing here.
  const zone = text.indexOf('%');
  const address = zone === -1 ? text : text.slice(0, zone);
  if (!address.includes(':')) return null;

  const halves = address.split('::');
  if (halves.length > 2) return null;

  const groups = (part: string): string[] | null => {
    if (part === '') return [];
    const pieces = part.split(':');
    return pieces.every((piece) => /^[0-9a-f]{1,4}$/i.test(piece)) ? pieces : null;
  };

  const left = groups(halves[0] ?? '');
  const right = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (left === null || right === null) return null;
  // Without a `::`, an address is exactly eight groups; with one, it is at most.
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length > 7) return null;

  const width = 8 - left.length - right.length;
  const all = [...left, ...Array<string>(halves.length === 2 ? width : 0).fill('0'), ...right];

  let value = 0n;
  for (const group of all) value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  return value;
}
