import { createHash } from 'node:crypto';
import { readFileSync, statSync, utimesSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A re-encoded answer, kept where a part of it can be asked for.
 *
 * A song no browser plays is re-encoded to FLAC, and ffmpeg produces that answer
 * as a stream — which means its length is not known until it has finished, so a
 * range cannot be answered and a client that seeks hears the song from its
 * beginning again. Keeping the answer in a file of its own settles both at once:
 * the length is known the moment the file is, and the file can be ranged like
 * any other.
 *
 * Three things make it a cache rather than a heap of files. The name is derived
 * from *what was asked for* — the source, its size and modification time, and
 * the stretch of it — so a re-rip or an edit is a different answer rather than
 * the old one served again under a new name. The bytes are written to a
 * temporary name and renamed when they are complete, so a reader never sees half
 * a song — and a half-written file from a killed server is swept rather than
 * served. And the oldest answers are dropped when the directory outgrows its
 * cap, because a cache that only grows is a disk that fills.
 *
 * What is *not* here is how the answer is produced: the caller brings the
 * arguments, since what to re-encode is the delivery layer's question.
 */

/**
 * How much of the disk the re-encoded answers may hold.
 *
 * Written as arithmetic and not as `4 << 30`: JavaScript's bitwise operators are
 * 32-bit, so the shift is zero — a cap of nothing, which drops every answer but
 * the one just written. It was, for an afternoon.
 */
const CACHE_BYTES = 4 * 1024 ** 3;

/** The suffix a half-written answer carries, so it is never mistaken for one. */
const PARTIAL = '.part';

/** Where a swept directory records the shape of the names it now holds. */
const VERSION_MARKER = '.keys';

/**
 * The shape of the names this build writes.
 *
 * **Bumped whenever `keyOf` changes what a name means.** The cache is a
 * directory of names derived from questions, and a build that changes the
 * derivation cannot recognise what an older one left: those answers are not
 * wrong, they are *unreachable* — and they go on being counted in the cap and
 * `statSync`ed after every transcode while never being served again. Measured
 * the first time it happened without one: 803 MiB, across 24 files, half of it
 * turned over by a single commit (task:2900).
 */
const KEY_VERSION = 4;

/** The answers being produced right now, so two clients wait on one transcode. */
const running = new Map<string, Promise<string>>();

/**
 * How many of a directory's entries are asked about in one go.
 *
 * **Bounded, and the measurement is why.** Handing the whole directory to one
 * `Promise.all` looks like the same thing and is not: four thousand `stat` calls
 * are queued at once, and their completions drain in a handful of very long
 * turns of the loop — which is the stall the asynchronous walk was supposed to
 * remove, arrived at from the other side. Measured over 4000 answers: the
 * unbounded form still held the loop for **97 ms** in its worst single turn,
 * against 806 ms for the synchronous walk it replaced. A batch yields between
 * every group, so the longest turn is bounded by this number rather than by how
 * much the cache holds.
 */
const BATCH = 64;

/** `work` over every item, a batch at a time, so the loop runs in between. */
async function inBatches<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const answers: R[] = [];
  for (let at = 0; at < items.length; at += BATCH) {
    answers.push(...(await Promise.all(items.slice(at, at + BATCH).map(work))));
  }
  return answers;
}

/**
 * Directories already swept by this process, so the marker is read once.
 *
 * Holds the *promise* of the sweep rather than a flag, because the sweep is
 * asynchronous now (see below): two requests that arrive together must wait on
 * one sweep rather than start a second, which is the same reason `running` holds
 * promises for transcodes in flight.
 */
const swept = new Map<string, Promise<void>>();

/**
 * The identity of one re-encoded answer.
 *
 * The source is named by its path and by the two things that say *which* file
 * that path holds — its size and its modification time. What is asked of it is
 * named by the stretch, when a stretch is what is wanted: a whole song and a
 * cue track cut from an image are different answers from the same bytes.
 */
export function keyOf(input: {
  source: string;
  startMs?: number;
  endMs?: number;
  /**
   * What the answer is made of — see `Plan.made` in `segment.ts`.
   *
   * Required, and not defaulted: a caller that forgot it would silently share
   * the entry of whatever lossless answer happened to be made first, which is
   * the live bug this field was added to close. A default leaves that reachable
   * from the type (task:2865).
   */
  made: string;
}): string {
  const stat = statSync(input.source);
  // The stretch as one string, with the shape riding after it: two clients
  // asking for different things from the same bytes are not asking the same
  // question, and a cache that answered one with the other's answer handed back
  // an mp3 under an `audio/ogg` header (found live, task:2865).
  //
  // The separator is a real NUL, written as the same escape the digest below
  // uses. What stood here was that escape doubled, which is the six characters
  // `\u0000` and not a NUL at all — a sequence a source path could contain,
  // and so a key two different questions can collide on.
  const stretch =
    `${input.startMs === undefined ? 'whole' : `${input.startMs}-${input.endMs ?? 0}`}` +
    `\u0000${input.made}`;
  // The version rides in the digest and not beside it, so that a name stays a
  // function of one string: two builds that mean different things by the same
  // question cannot arrive at the same name.
  return createHash('sha1')
    .update(`v${KEY_VERSION}`)
    .update(`${input.source}\u0000${stat.size}\u0000${Math.round(stat.mtimeMs)}\u0000${stretch}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The file an answer is kept in, producing it if it is not there yet.
 *
 * `produce` is handed the path to write to, and the rename happens here: a
 * caller cannot forget it, and a caller that throws leaves nothing behind for
 * the next request to serve.
 */
export async function kept(input: {
  dir: string;
  key: string;
  extension: string;
  produce: (target: string) => Promise<void>;
  /** The cap, where a caller has a better idea of it than this module has. */
  cap?: number;
}): Promise<string> {
  const target = join(input.dir, `${input.key}${input.extension}`);

  const ready = isAnswer(target);
  if (ready) {
    // Touched on every use, which is what makes "oldest" mean least recently
    // wanted rather than first written.
    const now = new Date();
    utimesSync(target, now, now);
    return target;
  }

  const already = running.get(target);
  if (already !== undefined) return already;

  const work = produce(input, target, input.cap ?? CACHE_BYTES).finally(() =>
    running.delete(target),
  );
  running.set(target, work);
  return work;
}

/**
 * The last steps of building an answer, and why they are not synchronous calls.
 *
 * **Adding a name to this directory costs twenty milliseconds, and removing one
 * costs the same.** Measured 2026-09-16, on this deployment, three megabytes
 * written and then renamed:
 *
 *   cache dir `C:\ProgramData\funoteka\cache`   rename p50 20.7  rm p50 20.6
 *   the directory above it                      rename p50 19.7  rm p50 19.0
 *   a fresh directory under `C:\ProgramData`    rename p50 53.3  rm p50 52.7
 *   the same work in `%TEMP%`                   rename p50  0.9  rm p50  0.6
 *
 * Twenty-five times the price, on one volume — and it is the *directory entry*
 * and not the bytes: `writeFile` is 1.8 ms in both, `stat` 0.07, `utimes` 0.3,
 * and `mkdir` over a directory that already exists 0.2. What is expensive is
 * creating or removing a name, which is what a filter driver watching a
 * deployment's own folder would charge for.
 *
 * That price was being paid **in the thread that answers every client**. A
 * transcode already waits a second or two for ffmpeg, so twenty milliseconds is
 * nothing to the client that asked — but it is twenty milliseconds in which no
 * other client is answered at all, and the same twenty are paid again by every
 * answer the trim drops. The review found it as a `ping` column of 43.7–121 ms
 * at the moment ffmpeg exited, and could not attribute it (task:2927).
 *
 * **Twenty renames in this directory, and the longest turn of the loop:**
 *
 *   `renameSync`                       1437.9 ms   — 72 ms each, all of it blocking
 *   `await rename`                        3.1 ms   — the same twenty, on the pool
 *
 * And on the live daemon, six cold transcodes with a `ping` every 5 ms from
 * another process, before and after:
 *
 *   worst ping across the six windows   109.8 ms  ->  15.9 ms
 *   the same measurement with no transcode in flight  18.4  ->  14.9
 *
 * So the column is gone, and what is left in those windows is the background of
 * a daemon with a client attached rather than a cost of re-encoding.
 *
 * The two calls that touch a directory entry are therefore on the pool, where
 * `prune` and the sweep already are. `statSync`, `utimesSync` and the marker
 * read stay where they are: they are a fifth of a millisecond, and a promise
 * costs more than they do.
 */
async function produce(
  input: { dir: string; produce: (target: string) => Promise<void> },
  target: string,
  cap: number,
): Promise<string> {
  const partial = `${target}${PARTIAL}`;
  try {
    // The directory is the module's to make: a deployment configures where the
    // answers go and nothing else has to know that it is not there yet.
    await mkdir(input.dir, { recursive: true });
    await sweepIfStale(input.dir);
    await input.produce(partial);
    await rename(partial, target);
  } catch (error) {
    // Nothing half-written is left for a later request to mistake for an answer.
    await rm(partial, { force: true });
    throw error;
  }
  // The trim is not this request's answer, and the client does not wait for it.
  void prune(input.dir, target, cap);
  return target;
}

/**
 * Empty a cache whose names were derived by a different build.
 *
 * Once per directory per process, and only when the marker does not already say
 * this build. A cache is allowed to be thrown away — every byte in it is
 * reproducible from the collection — which is what makes this cheaper *and* more
 * honest than keeping answers nothing can name any more: an unreachable entry
 * still counts against the cap and is still `statSync`ed after every transcode.
 *
 * Half-written answers are left where they are. They belong to a request in
 * flight, whose own producer will rename or sweep them, and deleting one under
 * its producer would turn a version bump into a failed request.
 */
function sweepIfStale(dir: string): Promise<void> {
  const already = swept.get(dir);
  if (already !== undefined) return already;

  const sweep = sweepNow(dir);
  swept.set(dir, sweep);
  return sweep;
}

/**
 * **Asynchronous for the same reason `prune` is, and it was the larger of the
 * two.** This walk deletes rather than measures, so it was measured first and
 * worst: on a directory holding 4000 answers and no marker, the synchronous
 * version held the thread that answers clients for **806 ms** — six times the
 * `prune` walk over the same directory, because every entry costs a deletion and
 * not a `stat`.
 *
 * It runs once per directory per process, which is what made it look harmless:
 * "once" is once per day for a long-lived daemon, and a version bump is exactly
 * the moment a full cache is swept. Once is all it takes to be the request that
 * happened to arrive first.
 *
 * `readFile` is on the pool too, but the marker is one small file, and leaving
 * that one call synchronous keeps the "is this directory already ours?" decision
 * free of an await for the overwhelming majority of calls — the ones that return
 * at the line below.
 */
async function sweepNow(dir: string): Promise<void> {
  const marker = join(dir, VERSION_MARKER);
  try {
    if (readFileSync(marker, 'utf8').trim() === String(KEY_VERSION)) return;
  } catch {
    // No marker at all: a directory from a build that wrote none, or a new one.
  }

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  await inBatches(
    names.filter((name) => name !== VERSION_MARKER && !name.endsWith(PARTIAL)),
    (name) => rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined),
  );

  try {
    await writeFile(marker, `${KEY_VERSION}\n`);
  } catch {
    // A cache that cannot be marked is swept again next process, which is wasted
    // work and never a wrong answer.
  }
}

/** Whether a complete answer is there, as opposed to none or half of one. */
function isAnswer(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Drop the least recently wanted answers until the directory fits.
 *
 * Half-written files are swept first and without counting: they are the remains
 * of a server that was killed mid-transcode, they are never served, and nothing
 * will ever finish them. What is left is measured and trimmed oldest-first, and
 * the answer just written is never the one dropped — a cache that evicted what
 * it had only just produced would transcode the same song forever.
 *
 * **The walk is asynchronous, and the measurement is what settled it.** The
 * version before this one read the directory with `readdirSync` and called
 * `statSync` once per entry, in the thread that answers clients — a cost nobody
 * had written down (task:2869 measured it around ffmpeg's noise, task:2908
 * carried it as unattributable). Measuring the walk on its own, with no
 * transcode running, is what made it attributable, and the answer was larger
 * than expected: **~35 µs a name**, against a `ping` floor of 0.8 ms.
 *
 *   cache        25 names (this deployment, 267 MiB)   walk p50   1.0 ms
 *                 400 names (a 4 GiB cache of albums)  walk p50  14.3 ms
 *                1000 names                           walk p50  33.9 ms
 *                4000 names                           walk p50 132.2 ms
 *
 * So it was never "the cache holds one file" — it holds one file at the start of
 * an afternoon, and the cap it is allowed to reach is four gigabytes. A
 * thirty-millisecond stall of a single-threaded server, after every transcode,
 * is a real mechanic to trade.
 *
 * The fix is not to do less: it is to do the same work on the pool. `readdir`,
 * `stat` and `rm` from `node:fs/promises` run on libuv's threads, so the event
 * loop stays free to answer while the directory is being walked, and the stall
 * becomes latency that overlaps instead of latency that blocks.
 *
 * **Serialised among themselves, and only among themselves.** Two prunes running
 * at once would each compute a total from a directory the other is changing, so
 * the chain keeps the arithmetic sound — but it is a chain of promises, not a
 * lock on the loop, and a client is answered between every step of it.
 *
 * **And nobody waits on it** (task:2927). It used to be awaited by the request
 * that had just been transcoded, which is the one request that can least afford
 * it: that client has already waited a second for ffmpeg, and the trim it was
 * then made to wait for is bookkeeping about *other* answers — a walk whose
 * evictions cost 20 ms each in this directory. So `kept` returns the answer the
 * moment the answer exists, and the chain runs on behind it.
 *
 * A failure is swallowed rather than reported, and that is the one place in this
 * module where silence is the honest answer: there is no logger here, and a
 * directory that could not be trimmed is trimmed by the next one. What must
 * never happen is an *unobserved* rejection — a promise no one awaits takes the
 * process down with it — so the returned promise is the swallowed copy and not
 * the raw one. `trimmed` is how anything that genuinely needs the directory
 * settled waits for it.
 */
let pruning: Promise<void> = Promise.resolve();

function prune(dir: string, keep: string, cap: number): Promise<void> {
  // The chain is advanced by a copy that has already swallowed a failure, so
  // that one prune throwing cannot wedge every prune after it. That copy is
  // also what is returned, because the callers of this one do not await it.
  pruning = pruning.then(() => pruneNow(dir, keep, cap)).catch(() => undefined);
  return pruning;
}

/**
 * The trimming this module has been asked for, done.
 *
 * `kept` hands back an answer as soon as the answer exists and lets the trim
 * that keeps the directory inside its cap follow on its own, so this is the only
 * way to know the cache has settled — a test that asserts what was dropped, or
 * an operator about to measure the directory. Nothing on a request's path should
 * wait here: that is the whole point of the trim being detached.
 */
export function trimmed(): Promise<void> {
  return pruning;
}

async function pruneNow(dir: string, keep: string, cap: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }

  const measured = await inBatches(names, async (name) => {
    // The marker is not an answer and is never dropped: it is how the next
    // process knows this directory's names are ones it can read.
    if (name === VERSION_MARKER) return null;
    const path = join(dir, name);
    try {
      return { name, path, info: await stat(path) };
    } catch {
      return null;
    }
  });

  const files: { path: string; size: number; at: number }[] = [];
  for (const entry of measured) {
    if (entry === null || !entry.info.isFile()) continue;
    if (entry.name.endsWith(PARTIAL)) {
      // A partial file older than this run's is a corpse. The one being
      // written now belongs to another request and is left alone.
      if (Date.now() - entry.info.mtimeMs > 60 * 60 * 1000) {
        await rm(entry.path, { force: true });
      }
      continue;
    }
    files.push({ path: entry.path, size: entry.info.size, at: entry.info.mtimeMs });
  }

  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= cap) return;

  files.sort((left, right) => left.at - right.at);
  for (const file of files) {
    if (total <= cap) break;
    if (file.path === keep) continue;
    await rm(file.path, { force: true });
    total -= file.size;
  }
}
