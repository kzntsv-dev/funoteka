import { createWriteStream, openSync, type WriteStream } from 'node:fs';

/**
 * A log file for the deployments whose supervisor collects nothing.
 *
 * Everything this server narrates, it narrates to `process.stdout` and
 * `process.stderr` — one line per request when that is turned on, one line per
 * process event always. That is the right shape, because it is the shape every
 * supervisor already understands: Docker's log driver, systemd's journal, the
 * Windows service wrapper, a shell redirection. None of them needs this module.
 *
 * It exists for the one deployment where nothing collects anything: a NAS, a
 * bare `serve --daemon` on a machine whose terminal is gone, an operator who
 * wants the log beside the database rather than in a container runtime's
 * rotating files. There, the alternative to this is no log at all — and a server
 * that cannot say why it died is a server that has to be reproduced from
 * scratch.
 *
 * **It taps the streams rather than replacing the logging.** Every call site in
 * this project writes to `process.stdout` or `process.stderr` and none of them
 * knows about this; a logging module threaded through them would be a second
 * thing to keep honest, and the one place it was forgotten would be the line
 * somebody needed. The cost is that this mutates two globals — so it is done
 * once, at startup, in one place, and it is undone by the function it returns.
 */

/** The two streams, as they were before anything tapped them. */
interface Tee {
  stop: () => void;
}

/**
 * Append this process's output to a file, or say why it cannot and carry on.
 *
 * **A log file that cannot be opened is not a reason to refuse to serve.** The
 * failure is said on stderr — which is where it would have gone anyway — and the
 * server starts without it. The opposite choice, refusing to serve music because
 * a log path is mistyped, trades the whole product for a diagnostic about it.
 *
 * The file is opened *before* the streams are tapped, on purpose: `openSync`
 * throws where a path has no directory, so the failure arrives here as a
 * sentence rather than asynchronously as an unwritable stream nobody is
 * listening to.
 */
export function logToFile(path: string): () => void {
  let stream: WriteStream;
  try {
    stream = createWriteStream(path, { fd: openSync(path, 'a') });
  } catch (err) {
    process.stderr.write(
      `funoteka: no log file at ${path} (${(err as Error).message}) — carrying on without one\n`,
    );
    return () => {};
  }

  const teed: Tee[] = [tee(process.stdout, stream), tee(process.stderr, stream)];

  const stop = (): void => {
    while (teed.length > 0) teed.pop()?.stop();
    stream.end();
  };

  // A disk that filled up is the one failure left, and it arrives here rather
  // than at a call site: the log stops, and a line about it goes to the original
  // stderr — the tapped one would be writing into the stream that just failed.
  stream.on('error', (err) => {
    const original = process.stderr.write.bind(process.stderr);
    stop();
    original(`funoteka: the log file at ${path} stopped (${err.message})\n`);
  });

  return stop;
}

/**
 * One stream tapped: what was written to it goes to the file as well.
 *
 * The return value of the original write is passed back untouched, because call
 * sites and Node itself read it (back-pressure); the callback is passed to the
 * original and *not* to the file, because it belongs to one write and a caller
 * that wanted to know when its line reached a terminal has not asked to be told
 * twice.
 */
function tee(out: NodeJS.WriteStream, stream: WriteStream): Tee {
  const original = out.write.bind(out) as typeof out.write;

  out.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    try {
      stream.write(chunk as string | Uint8Array);
    } catch {
      // The log is not worth a throw on the way to the thing being logged.
    }
    return (original as (c: unknown, e?: unknown, cb?: unknown) => boolean)(chunk, encoding, callback);
  }) as typeof out.write;

  return {
    stop: () => {
      out.write = original;
    },
  };
}
