import { statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The half-write gate: a file that is still being written is not read.
 *
 * A copy in progress is a file that is longer a second from now, and a scan that
 * meets one records a size that is already wrong and hands the stages half a
 * song. The contract's acceptance is that a half-written file does **not** enter
 * the library (§5), and until this existed only the watcher had anything against
 * it — the path that is off by default, while the path the clock starts waited
 * for nothing.
 *
 * **The rule is the watcher's: five seconds of quiet.** `rescan.ts` waits for
 * silence before it acts on a change; this waits for it before it records a
 * file. One rule, one number, both paths.
 *
 * ## Two designs died before this one, and both died by measurement
 *
 * **Looking twice in a row does not work.** The first version compared the
 * walk's observation against a `stat` taken straight after it and held a file
 * when the two disagreed — the idea being that a second look costs nothing on a
 * settled collection. What it got wrong is the size of the gap: for one file it
 * is the walk returning and a `statSync`, tens of microseconds, and a
 * `writeFileSync` of a few kilobytes takes about the same. So while a writer ran
 * the two looks agreed roughly as often as not, and the live check caught it: a
 * file being rewritten in a tight loop was read as settled twice in a row, while
 * the same check called from a script held it — because three `console.log`s
 * between the looks had widened the gap. **A gate whose window is two adjacent
 * syscalls is not a gate.**
 *
 * **Holding everything recent is worse than the disease.** The second version
 * held any file whose mtime was inside the window, no second look. It satisfies
 * the acceptance and breaks the ordinary case: a scan run after a copy holds
 * every file the copy has just finished, so the album arrives without its last
 * track and waits a whole interval for the rest. Measured the blunt way — it
 * turned twenty-one tests red, every one of them a fixture written and then
 * scanned immediately, which is what an operator does. (That design is gone, so
 * the run is not reproducible from this tree; what is reproducible is its shape,
 * and it is why `RunOptions.settleMs` exists: most of the suite's scans are a
 * fixture it has just written, and every one of them is a test about something
 * else.)
 *
 * ## What is here, and the wait it costs
 *
 * A file inside the window is **waited out** — the remainder of the window from
 * its own mtime — and then looked at again; one that moved is still being
 * written and is not recorded. That is what separates "new and finished" from
 * "new and still arriving", and it is the only thing that can: the difference is
 * not visible in one observation at any instant.
 *
 * The cost is bounded and paid only when it buys something. A settled collection
 * has nothing inside the window, so it waits not at all; a scan that follows a
 * copy waits at most the window and then records the whole album. What is left
 * is a scan that lands *while* a copy runs: the file in flight is held, and it
 * arrives on the next scan — which is the acceptance and not a defect.
 *
 * **What it cannot catch is the watcher's blind spot too.** A copy that pauses
 * for longer than the window and then resumes — over a network, where the pause
 * is the point — reads as quiet. The answer is the next scan, which meets a file
 * that has stopped; the price is that the half-written version was in the library
 * for one interval.
 *
 * ## The clock the window is measured against is the walk's
 *
 * `stillMoving` is given the instant the **walk started**, not the reading taken
 * when it is called: a walk of a real collection takes seconds, and a file met at
 * the beginning of one has not been quiet for those seconds — it has been
 * *unlooked at* for them. Passing the later reading would make exactly the oldest
 * observation in the run read as the most settled, and the file a copy was
 * halfway through when the walk passed it would be recorded with the size the
 * copy had reached by then. A file written *during* a walk reads as fresh, which
 * is what it is; the cost is bounded because the wait is.
 *
 * ## The window is the caller's
 *
 * `scan` takes it rather than assuming it, and its default is **no gate**, which
 * is the unusual direction to leave a safety off and is deliberate: only the
 * caller knows whether it can afford to wait. `runStages` is the one path that
 * scans in production and it asks for the window; the suite calls `scan` directly
 * hundreds of times to test things that have nothing to do with time, and a
 * blanket five-second wait would put minutes on it to prove nothing.
 *
 * Zero means no gate in the strongest sense — `stillMoving` returns before it
 * looks at anything — so the default costs a settled suite nothing at all, and
 * the shim `RunOptions.settleMs` exists for the tests that scan a fixture they
 * have just written and are not asking about time either.
 */
export const SETTLE_MS = 5_000;

/** An observation of one file: what the walk and the second look both report. */
export interface Observation {
  size: number;
  /** Whole milliseconds, because that is how the walk spells it. See `observed`. */
  mtimeMs: number;
}

/** A file the walk met: where it sits in the collection, and what was seen of it. */
export interface Looked extends Observation {
  /** Where the file sits *in the collection*, not where it sits on the disk. */
  relPath: string;
}

/**
 * An observation, in the one spelling both looks use.
 *
 * `walk.ts` reports the files it met through this, and the second look takes its
 * reading the same way — so what the gate compares is one rule spelled twice,
 * not two rules that agree today. The fraction is dropped because the walk
 * cannot keep it: a second look that kept the fraction would disagree with the
 * walk about a file nobody had touched. The first version of this did exactly
 * that, and the integration test caught it: every file in the fixture was held,
 * because a fractional millisecond made a settled collection look as though it
 * were being written to.
 */
export function observed(stat: { size: number; mtimeMs: number }): Observation {
  return { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

/**
 * Block this thread for a moment, synchronously.
 *
 * `Atomics.wait` rather than a spin: the scan process is a process of its own
 * and holds no lock while it walks, so sleeping costs the server nothing — but a
 * busy loop would burn a core of the machine the operator is listening to music
 * on, which is the thing this whole gate exists to be careful about.
 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The files under one root that were still being written.
 *
 * Absolute paths come from the root rather than from the walk, because the walk
 * reports where a file sits *in the collection* and this needs where it sits on
 * the disk.
 */
export function stillMoving(
  rootPath: string,
  files: readonly Looked[],
  nowMs: number,
  window: number,
): string[] {
  // **No gate, and saying so here rather than at the callers.** `0` is what
  // `scan` defaults to, and the difference between "no window" and "a window of
  // zero milliseconds" is not worth leaving to arithmetic: the filter below
  // would take any file whose mtime is not in the past — which under a clock
  // that disagrees is every file — and then wait for it.
  if (window <= 0) return [];

  const pending = files.filter((file) => nowMs - file.mtimeMs <= window);
  if (pending.length === 0) return [];

  // Out the remainder of the window as measured from the newest of them: waiting
  // a fixed five seconds would make a scan that met a file written one
  // millisecond ago — the most settled file there can be that is still new — pay
  // the full price for nothing.
  //
  // **And never more than the window, which is the one part of this that is a
  // safeguard rather than a rule.** `nowMs` is this process's clock; an mtime is
  // whatever wrote the file. So the subtraction can come out longer than the
  // window — a share whose clock runs ahead, an archive unpacked with the mtimes
  // it was packed with — and waiting that out means sleeping for the skew, with
  // the run stuck in `running` and nothing able to start another (measured:
  // +24.1 s end to end at a skew of 20 s). A file whose clock is ahead of ours
  // is not a file being written; it is a clock disagreeing, and the second look
  // below is what decides it either way.
  //
  // Folded rather than spread: `Math.max(...pending)` is a call whose arguments
  // are the array, and Node throws `RangeError` somewhere around 125 000 of them
  // — a whole collection inside one window, which is exactly the clock-skew case
  // above. A crash there would fail the run rather than hold a file.
  const newest = pending.reduce((most, file) => (file.mtimeMs > most ? file.mtimeMs : most), -Infinity);
  const wait = Math.max(0, Math.min(window, window - (nowMs - newest)));
  if (wait > 0) sleep(wait);

  const second = new Map<string, Observation>();
  for (const file of pending) {
    try {
      second.set(file.relPath, observed(statSync(join(rootPath, file.relPath))));
    } catch {
      // Left out of the map, which reads as moved: a file that cannot be looked
      // at twice has not been seen to settle.
    }
  }

  return pending
    .filter((file) => {
      const again = second.get(file.relPath);
      return again === undefined || again.size !== file.size || again.mtimeMs !== file.mtimeMs;
    })
    .map((file) => file.relPath);
}
