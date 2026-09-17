import { execFile, execFileSync } from 'node:child_process';

import { HIDDEN } from '../util/child.ts';

export interface Probe {
  durationMs: number | null;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitrate: number | null;
  ok: boolean;
  err: string | null;
}

export interface ProbeOptions {
  /** Override the binary; mainly so the missing-ffprobe path is testable. */
  ffprobePath?: string;
  timeoutMs?: number;
}

/** Fields ffprobe reports as strings; absent when the file lacks them. */
interface ProbeJson {
  format?: { duration?: string; bit_rate?: string };
  streams?: { codec_name?: string; sample_rate?: string; channels?: number }[];
}

function describe(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const { stderr, message } = err as { stderr?: Buffer | string; message?: string };
    const text = stderr === undefined ? '' : String(stderr).trim();
    if (text !== '') return text.split('\n')[0] ?? text;
    if (message !== undefined) return message;
  }
  return String(err);
}

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Which reading of a file a stored probe row belongs to.
 *
 * A row is an answer about a file *as read by a particular method*, and the two
 * cannot be told apart once stored: this collection's `codec` column was filled
 * by a method that wrote the *container's* name where a codec belongs (`mp4` for
 * AAC, `id3v2` for mp3) and nothing in a row said so, so two thousand files
 * carried a reading that was not one. Raising this number is how a change of
 * method is announced — every row below it is no longer an answer, and the next
 * scan takes those files again.
 *
 * **2 — the reader that seeds a row states more about the file than it used to.**
 * The MPEG frame walk now reports the sample rate and the channel count beside
 * the length (task:2910), so a row seeded by the reader carries four facts where
 * it carried two. The stored row is not the same answer, which is precisely what
 * this number exists to say.
 *
 * It has to be this number and not `TAGS_METHOD` alone, and the first attempt at
 * this change proved it: re-reading a file is not enough, because the seed
 * defers to a row that already succeeded — `seedProbe`'s guard is
 * `probe_ok = 0 OR stale OR probe_method <> ?`, and a row sitting at method 1 on
 * an unmoved file passes none of the three. Rescanning the collection with
 * `TAGS_METHOD` bumped moved all 3350 audio files to the new reader and changed
 * **not one** of the 728 channel counts, because the reader's answer never
 * reached the row it was meant to correct.
 *
 * **3 — the MP4 reader names a codec**, which is the same kind of change as 2
 * and lands in the same place: a seeded row now carries `aac` or `alac` where
 * it carried null, and a row already sitting at method 2 on an unmoved file
 * passes none of the seed's three conditions. Without this the 1425 `.m4a`
 * would keep their empty codec and the decision path would keep spawning
 * ffprobe for every one of them (task:2910).
 *
 * **4 — that reader states the channel count and the sample rate as well**, out
 * of the same header it was already standing on. An `.m4a` row that carried a
 * codec and nothing else now carries what `alreadyIs` needs to answer a
 * client's `maxAudioChannels`, so the file is served rather than transcoded
 * whole. Same reasoning as 2 and 3, and the number moves for the same reason:
 * what the reader states has moved, and a row on an unmoved file cannot be
 * told otherwise.
 */
export const PROBE_METHOD = 4;

/**
 * Ask ffprobe about one file.
 *
 * Nothing here is required to work: a duration the file's own bytes did not
 * state, and the codec inside a container whose name does not say (a `.m4a` is
 * AAC or ALAC and only the file knows), are the two questions asked of it. A
 * failure is data, not an exception — the caller records `ok: false` and
 * carries on, and the closing track of a cue split simply has no end. That is
 * why this never throws.
 */
/** What the question is: the codec and the length, and nothing else. */
function probeArgs(absPath: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'format=duration,bit_rate:stream=codec_name,sample_rate,channels',
    '-of',
    'json',
    absPath,
  ];
}

/** A file ffprobe was never asked about, which is a fact like any other. */
function unasked(err: unknown): Probe {
  return {
    durationMs: null,
    codec: null,
    sampleRate: null,
    channels: null,
    bitrate: null,
    ok: false,
    err: describe(err),
  };
}

/**
 * The same question, asked without holding the thread that asked it.
 *
 * `codecOf` needs this one: it stands on the hot path of `stream`, for the files
 * whose container tells a client nothing about what is inside — a `.m4a` is AAC
 * or ALAC and only the file knows. Asked synchronously it cost the daemon 90 ms
 * of answering nobody, per file, for 1422 files of this collection (measured,
 * task:2898). The scan, which is not answering anybody, keeps the sync one.
 *
 * Like `probeFile` this never rejects: a failure to ask is `ok: false` and a
 * sentence, because the callers treat it as data.
 */
export function probeAsync(absPath: string, options: ProbeOptions = {}): Promise<Probe> {
  const bin = options.ffprobePath ?? 'ffprobe';

  return new Promise<Probe>((resolve) => {
    execFile(
      bin,
      probeArgs(absPath),
      {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 30_000,
        ...HIDDEN,
      },
      (err, stdout) => {
        resolve(err === null ? parseProbe(stdout) : unasked(err));
      },
    );
  });
}

export function probeFile(absPath: string, options: ProbeOptions = {}): Probe {
  const bin = options.ffprobePath ?? 'ffprobe';

  let stdout: string;
  try {
    stdout = execFileSync(bin, probeArgs(absPath), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 30_000,
      ...HIDDEN,
    });
  } catch (err) {
    return unasked(err);
  }

  return parseProbe(stdout);
}

/**
 * What ffprobe said, as a `Probe`.
 *
 * Shared by both spellings of the call, so that what is known about a file does
 * not depend on which one asked it.
 */
function parseProbe(stdout: string): Probe {
  /** Nothing known, with a reason: every refusal below is this plus a sentence. */
  const nothing = (err: string): Probe => ({ ...unasked(err), err });

  let parsed: ProbeJson;
  try {
    parsed = JSON.parse(stdout) as ProbeJson;
  } catch (err) {
    return nothing(`unreadable ffprobe output: ${describe(err)}`);
  }

  const stream = parsed.streams?.[0];
  if (stream === undefined) {
    return nothing('no audio stream found');
  }

  const seconds = parsed.format?.duration === undefined ? null : Number(parsed.format.duration);
  const durationMs = seconds === null || Number.isNaN(seconds) ? null : Math.round(seconds * 1000);
  const channels = stream.channels ?? null;

  const probed: Probe = {
    durationMs,
    codec: stream.codec_name ?? null,
    sampleRate: toInt(stream.sample_rate),
    channels,
    bitrate: toInt(parsed.format?.bit_rate),
    ok: false,
    err: null,
  };

  // A stream being present is not enough to call the file readable. A truncated
  // or corrupt file can make ffprobe report a codec while giving no format
  // section at all — exit code 0, a plausible codec name, and a zero sample
  // rate. Since the only thing we need from ffprobe is a usable duration, that
  // is what "ok" means.
  if (durationMs === null || durationMs <= 0 || channels === 0) {
    return { ...probed, err: 'stream is not readable (no usable duration)' };
  }

  return { ...probed, ok: true };
}
