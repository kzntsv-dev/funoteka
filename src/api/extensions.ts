import type { Payload } from './router.ts';

/**
 * What this server tells a client it supports.
 *
 * OpenSubsonic's one answer about itself, and the only one a client reads
 * *before* it decides how to talk to the server: a client that knows
 * `indexBasedQueue` will send a queue position where it would otherwise send an
 * id, and one that does not will never find out that it could have.
 *
 * Which is exactly why the list is short and has to stay honest. **A promise
 * here has no way back**: nothing in the protocol lets a client ask again after
 * a call fails, and nothing tells it that the failure was the server's
 * overstatement. `requirements:47` says the same thing from the other side —
 * "getOpenSubsonicExtensions — только работающее".
 */

/**
 * One extension, and the versions of it this server speaks.
 *
 * `versions` is a list because an extension may grow; each of these is at its
 * first, which is the version the specification describes.
 */
interface Supported {
  name: string;
  versions: number[];
}

/**
 * The extensions this server implements, each with the endpoint that carries it.
 *
 * `transcoding` was deliberately absent until it was built, and the entry below
 * is what that discipline looks like once it holds: the two endpoints exist, so
 * the name does. A client that read the name before the code would call
 * `getTranscodeDecision` and get "unknown method" from a server that had just
 * told it the method existed — and nothing in the protocol lets it ask again or
 * tell it whose fault that was.
 */
const EXTENSIONS: readonly Supported[] = [
  // getPlayQueueByIndex / savePlayQueueByIndex — the same queue, addressed by
  // position rather than by id, because an id cannot say which of two identical
  // entries is playing.
  { name: 'indexBasedQueue', versions: [1] },
  // reportPlayback — what a player says about a song it has just played, which
  // is the history the server did not witness.
  { name: 'playbackReport', versions: [1] },
  // The `timeOffset` parameter on `stream` — `Transcode Offset`: start the
  // answer later than the song does.
  { name: 'transcodeOffset', versions: [1] },
  // getTranscodeDecision / getTranscodeStream — a client states what it can play
  // and is told what this server would do with a song, instead of naming a
  // format and a ceiling and hoping. Over http only: the client's HLS profiles
  // are skipped and answered with `canTranscode: false`, because this server
  // produces no HLS (task:2896).
  { name: 'transcoding', versions: [1] },
  // `apiKey` as a whole credential, and the pair of promises the extension is:
  // a key that arrives alone is accepted, and a server that accepts one offers
  // a way to see the keys it holds and to take one back. The first half worked
  // from the beginning and the second did not exist, which is why the name was
  // withheld: the key lived in a variable in `start.cmd` and revoking it meant
  // editing that file and restarting the daemon (task:2915).
  //
  // It is declared now because both halves are true — the registry and the two
  // CLI verbs are `keys.ts` and `cli/keys.ts`. The environment's key is outside
  // the registry on purpose and `list` says so; see the migration.
  { name: 'apiKeyAuthentication', versions: [1] },
];

/** The answer to `getOpenSubsonicExtensions`, and the whole of it. */
export function openSubsonicExtensions(): Payload {
  return { openSubsonicExtensions: EXTENSIONS.map(({ name, versions }) => ({ name, versions })) };
}
