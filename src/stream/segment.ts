import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

import { probeAsync } from '../probe/ffprobe.ts';
import { HIDDEN } from '../util/child.ts';
import type { TrackTags } from '../tags/encode.ts';
import { flacSegment } from './flac.ts';
import { mpegSegment } from './mpeg.ts';
import { restatedSize, type Reframe } from './rewrite.ts';

/**
 * How a cue track is served.
 *
 * A track cut out of an image is not a file, and there are three honest ways to
 * answer for one, of which this module picks and the route carries out:
 *
 *   - **bytes** — a range of the image with a header built for it, which is what
 *     FLAC and mp3 need and what the client receives as a file;
 *   - **transcode** — ffmpeg reads the segment out and writes a stream, which is
 *     the only way through an MP4 container without writing an MP4 muxer;
 *   - **unavailable** — with the reason, because a refusal a client can read is
 *     worth more than bytes that lie about what they are.
 *
 * The formats are named where the containers are, not here: this decides *how*,
 * and `flac.ts` and `mpeg.ts` know *where*.
 */
export interface ByteSegment {
  /**
   * Bytes to put in front of the cut audio.
   *
   * Empty for mp3, which states no length anywhere a client reads — its frames
   * say how long they are individually, and a player adds them up. A non-empty
   * prefix is a header rebuilt for the segment, which is what a FLAC slice needs
   * so that it does not announce the length of the whole record.
   */
  prefix: Buffer;
  /** The first byte of the image to send, and the first byte not to. */
  from: number;
  to: number;
  /**
   * The frames of that range that do not go out as the file holds them.
   *
   * A FLAC slice needs these: its frames state the number they had in the image,
   * a segment has to state its own, and a frame whose header is restated is a
   * frame whose footer CRC-16 has to be computed again. mp3 has none — its
   * frames carry no number a player counts from, only their own length.
   */
  frames: Reframe[];
}

/**
 * How many bytes a segment comes to.
 *
 * The range, the prefix in front of it, and what restating the frames adds or
 * takes away — a number written in fewer bytes than the image's makes the served
 * stream shorter than the bytes it was cut from. The footers are two bytes for
 * two bytes and change nothing.
 */
export function segmentSize(segment: ByteSegment): number {
  return segment.prefix.length + (segment.to - segment.from) + restatedSize(segment.frames);
}

/**
 * The piece of a segment a client asked for, as what the route sends.
 *
 * A range on a cue track is a range of the *answer*, not of the image: the
 * answer begins with a rebuilt header that exists in no file, and each frame
 * after it is a header written out, a body copied, and a footer computed. So
 * the offsets a client seeks by are answered by building the same stream and
 * passing over what comes before — the prefix is a slice of itself, and the
 * rest is a window onto the frames.
 */
export function windowOf(
  segment: ByteSegment,
  start: number,
  end: number,
): { prefix: Buffer; skip: number; limit: number } {
  const intoPrefix = Math.min(Math.max(start, 0), segment.prefix.length);
  const prefixTo = Math.min(Math.max(end + 1, intoPrefix), segment.prefix.length);
  const prefix = segment.prefix.subarray(intoPrefix, prefixTo);

  return {
    prefix,
    skip: Math.max(0, start - segment.prefix.length),
    limit: end - start + 1 - prefix.length,
  };
}

export type Plan =
  | { kind: 'bytes'; segment: ByteSegment }
  | {
      kind: 'transcode';
      args: (target: string) => string[];
      contentType: string;
      /**
       * What the answer is made of — `flac:none:none`, or `mp3:128:2`.
       *
       * Three fields and not one, because the answer has three: the format, the
       * ceiling that will be obeyed, and the channel count it will be folded to.
       * A field that would not be obeyed is written `none` rather than left out,
       * so that one answer has one spelling and no two answers share one.
       *
       * **Part of the answer's identity**, and it has to be: a re-encoded file is
       * kept and handed to the next client that asks for the same thing, and two
       * clients asking for different things from the same bytes are not asking
       * the same question. Without this the cache answered like with like, and a
       * client that asked for ogg was handed the mp3 that happened to be there
       * first — under an `audio/ogg` header, which is a lie the client has no way
       * to see (found live, task:2865).
       */
      made: string;
      /** The container it is written in, which is what the kept file is named. */
      container: string;
    }
  | { kind: 'unavailable'; reason: string };

/** The formats whose segments are cut from the container by hand. */
const NATIVE = new Set(['flac', 'mp3']);

/**
 * Formats the layer of delivery handles, and the ones it does so with ffmpeg.
 *
 * Monkey's Audio is here for the same reason the MP4 containers are: the audio
 * cannot be cut out by hand — the frames are not self-delimiting the way mp3's
 * are, and nothing in the stream states a length — and ffmpeg decodes it, so a
 * cue image of it is re-encoded instead of being refused. Two albums of the
 * collection are ape images, and a refusal they can read is still no music.
 */
const THROUGH_FFMPEG = new Set(['m4a', 'mp4', 'aac', 'alac', 'ape']);

/**
 * Codecs no browser decodes.
 *
 * The collection holds more than the web does: ALAC is Apple's and no browser
 * decodes it, Monkey's Audio none at all, and both are lossless — which is what
 * makes re-encoding them cheap to justify. The names are ffprobe's own, which is
 * where the meta layer's `codec` comes from.
 */
const UNPLAYABLE_CODECS = new Set([
  'alac',
  'ape',
  'wavpack',
  'wma',
  'wmav1',
  'wmav2',
  'wmavoice',
  'tta',
  'shorten',
  'dsd_lsbf',
  'dsd_msbf',
  'dsd_lsbf_planar',
  'dsd_msbf_planar',
]);

/** Codecs a browser plays, named the way ffprobe names them. */
const PLAYABLE_CODECS = new Set([
  'flac',
  'mp3',
  'mp3float',
  'aac',
  'aac_latm',
  'opus',
  'vorbis',
  'pcm_s16le',
  'pcm_s24le',
  'pcm_s32le',
  'pcm_u8',
  'pcm_f32le',
  'pcm_s16be',
  'pcm_s24be',
  'pcm_mulaw',
  'pcm_alaw',
]);

/** Containers a browser opens. Anything else is re-encoded, whatever is inside. */
const PLAYABLE_CONTAINERS = new Set(['flac', 'mp3', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'wav', 'weba']);

/**
 * Containers that can hold a codec no browser plays, whatever they are named.
 *
 * `.m4a` is one container whether it holds AAC or Apple's ALAC, so the name is
 * the one thing that cannot answer for it — the file has to be read.
 */
const AMBIGUOUS_CONTAINERS = new Set(['m4a', 'm4b', 'mp4', 'mov']);

/**
 * Whether a client can play these bytes as they are.
 *
 * A browser needs both things at once: a container it opens and a codec inside
 * it that it decodes. Neither answer stands in for the other — Monkey's Audio
 * is a box nothing opens whatever is inside it, and ALAC sits in the same `.m4a`
 * that AAC does.
 *
 * A codec this has never heard of is not a codec: the probe is optional, and an
 * older scan of this collection wrote the *container's* name where the codec
 * belongs (`mp4` for AAC, `id3v2` for mp3). Those files play, so an unknown name
 * leaves the container to answer — see `codecOf`, which reads the file when the
 * container is one that could be hiding something.
 */
export function playable(codec: string | null, ext: string): boolean {
  if (!PLAYABLE_CONTAINERS.has(ext)) return false;
  return !(codec !== null && UNPLAYABLE_CODECS.has(codec));
}

interface Reading {
  size: number;
  mtimeMs: number;
  codec: string | null;
}

/** What has been read of which file, kept until the file itself moves. */
const readings = new Map<string, Reading>();

/**
 * The readings being taken right now, so two callers wait on one ffprobe.
 *
 * `readings` answers the *second* question about a file and not the first: two
 * requests that arrive before either probe has returned both find nothing kept
 * and both spawn ffprobe. It was two, and it is a number that multiplies —
 * `getTranscodeDecision` asks this of every song a client asks a decision about,
 * and a client asking about a library asks about a library. One process per file
 * in flight is the bound this keeps; there is no bound across files, which is
 * named and measured in task:2910 rather than guessed at here.
 */
const probing = new Map<string, Promise<string | null>>();

/**
 * The codec of a file that is about to be sent.
 *
 * The meta layer answers for it when it named a codec this knows — either one a
 * browser plays or one it does not — because that reading is the scan's own and
 * was taken from the same bytes. When it named something else, and the container
 * is one that could be hiding an unplayable codec, the file is read here: a
 * `.m4a` whose codec nobody has established is exactly the case this exists for,
 * and sending ALAC to a browser is a download it sits silent through.
 *
 * The reading is kept per file until its size or modification time moves — the
 * same guard the frame index uses — so a re-encode is noticed rather than
 * answered from the reading of the file it replaced.
 *
 * Awaited, because this stands on the hot path of every `stream` of such a file
 * and the reading is a whole ffprobe process: asked synchronously it held this
 * single-threaded server for 90 ms apiece (measured, task:2898).
 */
export async function codecOf(
  path: string,
  ext: string,
  known: string | null,
): Promise<string | null> {
  if (known !== null && (UNPLAYABLE_CODECS.has(known) || PLAYABLE_CODECS.has(known))) return known;
  if (!AMBIGUOUS_CONTAINERS.has(ext)) return known;

  const stat = statSync(path);
  const kept = readings.get(path);
  if (kept !== undefined && kept.size === stat.size && kept.mtimeMs === stat.mtimeMs) {
    return kept.codec ?? known;
  }

  const already = probing.get(path);
  if (already !== undefined) return (await already) ?? known;

  const work = probeAsync(path)
    .then((probe) => {
      readings.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, codec: probe.codec });
      return probe.codec;
    })
    .finally(() => probing.delete(path));

  probing.set(path, work);
  return (await work) ?? known;
}

/**
 * Whether the binary is there, asked once per process.
 *
 * Asked before any byte is written, never after: a stream that discovers
 * half-way through that it cannot be made has already told the client it could.
 * The probe costs one short-lived process and the answer cannot change under a
 * running server, which is why it is kept.
 */
const ready = new Map<string, boolean>();

export function ffmpegWorks(binary: string): boolean {
  const known = ready.get(binary);
  if (known !== undefined) return known;

  let works = false;
  try {
    execFileSync(binary, ['-version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 10_000,
      ...HIDDEN,
    });
    works = true;
  } catch {
    works = false;
  }

  ready.set(binary, works);
  return works;
}

/**
 * The stretch of its file a song is, or nothing when it is the whole file.
 *
 * **The row's own facts decide this, and they decide it in one place.** A cue
 * track is a stretch of an image whether or not the client knows it; a whole
 * file is a file. The route asking "is this a segment?" in one place and "which
 * format?" in another is what let a cue track asked for in another format be
 * answered with the whole image — the format branch built its plan from the
 * *image* path and the client's offset, and the segment's bounds never reached
 * it (task:2865).
 *
 * `timeOffset` moves the near end of the stretch and never the far one: the
 * protocol's `Transcode Offset` says "start transcoding at any position", which
 * is where the answer begins, not how much of it there is.
 *
 * A stretch nobody can bound is a refusal rather than an answer. A file whose
 * length the scan never measured, or an offset at or past the end of one, would
 * otherwise become `-t 0.000` — an empty file, produced without complaint, kept,
 * and handed to every later client that asked the same question.
 */
export type Stretch =
  | { kind: 'file' }
  | { kind: 'span'; startMs: number; endMs: number }
  | { kind: 'refused'; reason: string };

/** See `Stretch`. */
export function stretchOf(
  song: {
    segment_start_ms: number | null;
    segment_end_ms: number | null;
    duration_ms: number | null;
  },
  offsetMs: number | null,
): Stretch {
  if (song.segment_start_ms === null) {
    if (offsetMs === null) return { kind: 'file' };
    if (song.duration_ms === null) {
      return {
        kind: 'refused',
        reason: 'This song has no measured length, so there is nothing to start it later from',
      };
    }
    if (offsetMs >= song.duration_ms) {
      return {
        kind: 'refused',
        reason: `timeOffset ${offsetMs / 1000} is at or past the end of a song of ${song.duration_ms / 1000} seconds`,
      };
    }
    return { kind: 'span', startMs: offsetMs, endMs: song.duration_ms };
  }

  // The closing track of a disc has no following index to end it, and its
  // length comes from the measurement the probe took rather than from the cue.
  const endMs = song.segment_end_ms ?? song.segment_start_ms + (song.duration_ms ?? 0);
  const startMs = song.segment_start_ms + (offsetMs ?? 0);
  if (endMs <= startMs) {
    return {
      kind: 'refused',
      reason:
        offsetMs === null
          ? 'This segment has no length to serve'
          : `timeOffset ${offsetMs / 1000} is at or past the end of this track`,
    };
  }
  return { kind: 'span', startMs, endMs };
}

/**
 * What to do about one track that is a segment of `path`.
 *
 * `startMs` and `endMs` are the segment's own times, which the cue stage settled
 * and the meta layer holds — or, when a client asked to start later, those times
 * moved, which is `stretchOf`'s to work out.
 */
export async function planSegment(input: {
  path: string;
  ext: string;
  startMs: number;
  endMs: number;
  /**
   * The song the segment is, which is what the bytes are tagged with.
   *
   * Not the image's tags and not optional: a segment cut by hand or by ffmpeg is
   * a file this server built, and a file it built with nothing to say about
   * itself is the defect task:2895 names. See `tags/encode.ts`.
   */
  tags: TrackTags;
}): Promise<Plan> {
  const { path, ext, startMs, endMs, tags } = input;
  const seconds = (ms: number): string => (ms / 1000).toFixed(3);

  if (NATIVE.has(ext)) {
    const segment =
      ext === 'flac'
        ? await flacSegment(path, startMs, endMs, tags)
        : await mpegSegment(path, startMs, endMs, tags);
    if (segment === null) {
      return {
        kind: 'unavailable',
        reason: `The ${ext} stream could not be walked, so this segment cannot be cut from it`,
      };
    }
    return { kind: 'bytes', segment };
  }

  if (THROUGH_FFMPEG.has(ext)) {
    // No target: a segment of an image is re-encoded only when nothing else can
    // be done with it, and what it is re-encoded into is the lossless default —
    // a cue image of ALAC or Monkey's Audio decoded and written back out without
    // losing anything. A client that named a format of its own goes through
    // `planTarget` instead, which is where the ceiling and the container live.
    return planOf(reencode(path, { startMs, endMs }, null, tags));
  }

  return { kind: 'unavailable', reason: `A segment of a .${ext} file cannot be served` };
}

/**
 * What a client asked the answer to *be*, when it did not ask for the file.
 *
 * The protocol's two parameters, and they answer different questions: `format`
 * names a container, `maxBitRate` a ceiling in kilobits per second. A client
 * usually names one of them and sometimes both.
 */
export interface TranscodeTarget {
  /** A container this server can make — see `TARGETS`. */
  format: string;
  /** The ceiling in kilobits per second, or nothing for no ceiling. */
  maxBitRate: number | null;
  /**
   * A limit on the channels of the answer, where a client named one.
   *
   * The protocol's own `stream` has no such parameter — this arrives from the
   * `transcoding` extension, where a client states its capabilities and one of
   * them is how many channels it decodes. It is *not* dropped for a lossless
   * target the way a bitrate ceiling is: a client that cannot decode six
   * channels cannot play six channels whatever they are wrapped in, while a
   * ceiling on a lossless answer is a request to throw samples away and call
   * the result lossless.
   */
  maxChannels?: number | null;
}

/** One thing ffmpeg can be asked to produce, and how. */
interface Made {
  codec: string;
  container: string;
  contentType: string;
  /**
   * Whether the target keeps every sample.
   *
   * A ceiling on a lossless target is a contradiction — it would mean throwing
   * audio away while still calling the answer lossless — so it is dropped where
   * it cannot mean anything, rather than passed to ffmpeg to be obeyed.
   */
  lossless: boolean;
}

/**
 * The formats this server will make, and nothing else.
 *
 * **A closed list, and the refusal names it.** The protocol lets a client ask
 * for any format string at all, and a server that accepted one it could not make
 * would either fail inside ffmpeg with a message no client can act on or, worse,
 * hand back something else. So an unknown name is refused with the list of what
 * is on offer — the same shape `getOpenSubsonicExtensions` will take when it
 * says which extensions exist (task:2866).
 */
const TARGETS: Record<string, Made> = {
  mp3: { codec: 'libmp3lame', container: 'mp3', contentType: 'audio/mpeg', lossless: false },
  opus: { codec: 'libopus', container: 'ogg', contentType: 'audio/ogg', lossless: false },
  ogg: { codec: 'libvorbis', container: 'ogg', contentType: 'audio/ogg', lossless: false },
  aac: { codec: 'aac', container: 'mp4', contentType: 'audio/mp4', lossless: false },
  flac: { codec: 'flac', container: 'flac', contentType: 'audio/flac', lossless: true },
  wav: { codec: 'pcm_s16le', container: 'wav', contentType: 'audio/wav', lossless: true },
};

/** The one the server falls back to on its own, and the only one it ever chose. */
const LOSSLESS_FORMAT = 'flac';
const LOSSLESS: Made = TARGETS[LOSSLESS_FORMAT] as Made;

/**
 * The lossy default when a ceiling is named and no format is.
 *
 * The protocol says a ceiling is "an attempt to limit the bitrate" and names no
 * format to limit it *to* — and a lossless file cannot be limited without
 * leaving lossless. So a ceiling alone is a request for the lossy format every
 * client can play.
 */
export const DEFAULT_LOSSY = 'mp3';

/** What this server can be asked to make, for a refusal that says so. */
export function formatsOffered(): string[] {
  return Object.keys(TARGETS);
}

/** Whether a target keeps every sample. */
export function isLossless(format: string): boolean {
  return TARGETS[format]?.lossless === true;
}

/**
 * The codecs that *are* a format, as a probe spells them.
 *
 * Asked so that a file already holding what a client asked for is not decoded
 * and encoded again for nothing. What a file is called is not the question:
 * `.m4a` is not `mp4` to a client, and the codec is what it is asking about.
 *
 * The PCM names are all here because a wav is a wav at any width — answering
 * `format=wav` for a 24-bit file by re-encoding it to the 16-bit one this server
 * would write throws bits away to no purpose.
 */
const CODECS_OF: Record<string, readonly string[]> = {
  mp3: ['mp3', 'mp3float'],
  opus: ['opus'],
  ogg: ['vorbis'],
  aac: ['aac', 'aac_latm'],
  flac: ['flac'],
  wav: [
    'pcm_s16le',
    'pcm_s24le',
    'pcm_s32le',
    'pcm_u8',
    'pcm_f32le',
    'pcm_s16be',
    'pcm_s24be',
    'pcm_mulaw',
    'pcm_alaw',
  ],
};

/** Whether a file already holds the codec a format names. */
export function codecIs(format: string, codec: string | null): boolean {
  if (codec === null) return false;
  return CODECS_OF[format]?.includes(codec) === true;
}

/**
 * Containers that are one container under more than one name.
 *
 * A client names the container, and the name a file carries is not the thing it
 * is: `.m4a` and `.m4b` are ISO base media whatever they are called, and `.oga`
 * and `.opus` are Ogg. Only the names that differ are here.
 */
const CONTAINER_CLASS: Record<string, string> = {
  m4a: 'mp4',
  m4b: 'mp4',
  mov: 'mp4',
  oga: 'ogg',
  opus: 'ogg',
};

/**
 * The container a name means, where two names are one container.
 *
 * Asked by everything that compares a container a client named with a container
 * this server holds or writes — a file's extension, a `format` parameter, or a
 * profile in the `transcoding` extension's `ClientInfo`. Exported because
 * `SourceStream` reports a container to a client in this vocabulary too: the
 * `.m4a` on disk is an `mp4` in the protocol, and a client matching its own
 * direct-play profile against `m4a` would match nothing.
 */
export function containerOf(name: string): string {
  return CONTAINER_CLASS[name] ?? name;
}

/**
 * Whether a file is held in the container a format names.
 *
 * The pair to `codecIs`, and never a substitute for it — see `alreadyIs`.
 */
export function containerIs(format: string, ext: string): boolean {
  const named = TARGETS[format]?.container;
  if (named === undefined) return false;
  return containerOf(named) === containerOf(ext);
}

/**
 * The format this server would make of a stream a client named, or nothing.
 *
 * A client's transcoding profile names a container and a codec in the protocol's
 * vocabulary; this server makes six things and no others. The question is both
 * halves at once — a container this server writes holding a codec it writes —
 * which is the same pair `alreadyIs` asks from the other direction, so it is
 * asked with the same two predicates rather than a second table.
 */
export function formatFor(container: string, codec: string): string | null {
  for (const format of Object.keys(TARGETS)) {
    if (containerIs(format, container) && codecIs(format, codec)) return format;
  }
  return null;
}

/**
 * What this server's answer would be, in the protocol's own words.
 *
 * `TARGETS` names ffmpeg's encoders and the containers ffmpeg writes; a client
 * reads `StreamDetails` in the protocol's vocabulary, where the codec of an ogg
 * is `vorbis` and not `libvorbis`, and where what an `.m4a` is written in is
 * `mp4`. Two vocabularies, so the translation lives in one place — the same
 * reason `metadata` sits beside `tags/encode.ts` instead of being guessed at
 * each call.
 *
 * The codec is the *first* name `CODECS_OF` lists, and that is the one ffmpeg
 * itself would write: the rest of each list is the other spellings a probe may
 * report for the same codec in a file that already holds it.
 */
export function streamOf(format: string): { container: string; codec: string } | null {
  const made = TARGETS[format];
  const codecs = CODECS_OF[format];
  if (made === undefined || codecs === undefined) return null;
  // The transport is not here, and deliberately: this module knows what ffmpeg
  // writes, and the protocol's one transport is a fact about the API. It is
  // named once, where the protocol is spoken — `HTTP` in `transcode.ts`.
  return { container: made.container, codec: codecs[0] as string };
}

/**
 * Whether a stretch of this container is cut out by hand, or by ffmpeg.
 *
 * The question `stream` settles before it can call a cue track playable at all:
 * a stretch of FLAC or mp3 is the file's own frames restated, and a stretch of
 * anything else has to be decoded and written again — which is a transcode, and
 * so not a thing a client can be told it will play as it is.
 */
export function cutByHand(ext: string): boolean {
  return NATIVE.has(ext);
}

/**
 * Whether the file already is what the client asked for.
 *
 * **Both questions, and both have to be yes.** The codec has to be the one the
 * format names *and* the container has to be the one it would be written in.
 * Either alone is a lie to a client: an `.ogg` holding vorbis is not the
 * `format=opus` answer though its container is right, and a `.mp4` holding ALAC
 * is not the `format=aac` answer *though its container is right too* — answering
 * on the container alone handed a client that had said it decodes AAC the ALAC
 * it could not, which is exactly the class of lie `playable` exists to prevent
 * (measured, task:2865).
 *
 * A file whose bitrate nobody measured cannot be shown to be under a ceiling, so
 * it is re-encoded: the safe answer is the one that obeys.
 *
 * **The channel cap is asked here too, and it is the one question this function
 * cannot answer by looking at the format.** It is an agreement between the
 * client and the *file* rather than between the client and the container: a
 * six-channel FLAC asked for as `format=flac` is trivially the format that was
 * named, and it is not what a client that decodes two channels asked for.
 * Without this the shortcut below would hand that client the six channels the
 * decision had just promised to fold down — one decision with two answers,
 * which is the class `Plan.made` and `keyOf` exist to close, and which was found
 * by the standards axis rather than by this suite (task:2896).
 *
 * A count nobody measured does *not* block, and that is the opposite of the
 * ceiling above for a reason that was measured the hard way: a cap handed to
 * ffmpeg is a number of channels to **produce**, so treating an unmeasured file
 * as "not shown to be within the cap" made a stereo mp3 come out as a 52 MB 5.1
 * FLAC against a client that had only said "no more than six" (task:2896). A cap
 * is a limit on a file known to exceed it; the rest go as they are.
 *
 * `channels` is required rather than optional for the reason `keyOf`'s `made`
 * is: a caller that forgot it would silently get the old, wrong answer.
 */
export function alreadyIs(
  target: TranscodeTarget,
  file: { ext: string; codec: string | null; bitrate: number | null; channels: number | null },
): boolean {
  if (!codecIs(target.format, file.codec)) return false;
  if (!containerIs(target.format, file.ext)) return false;

  if (target.maxChannels != null && file.channels !== null && file.channels > target.maxChannels) {
    return false;
  }

  if (target.maxBitRate === null) return true;
  if (isLossless(target.format)) return true;

  return file.bitrate !== null && file.bitrate <= target.maxBitRate * 1000;
}

/**
 * The song's tags in ffmpeg's own spelling.
 *
 * Lowercase names and no underscores, which is what ffmpeg's metadata keys are —
 * `album_artist` for the album artist, `track` for the number — and the reason
 * the mapping is written out rather than derived from `tags/encode.ts`'s table:
 * two writers, two vocabularies, and a translation is one place for the
 * difference to live instead of a guess at each call.
 */
function metadata(tags: TrackTags): Record<string, string> {
  const wanted: [string, string | number | null][] = [
    ['title', tags.title],
    ['artist', tags.artist],
    ['album_artist', tags.albumArtist],
    ['album', tags.album],
    ['track', tags.trackNumber],
    ['disc', tags.discNumber],
    ['date', tags.date],
    ['genre', tags.genre],
  ];

  return Object.fromEntries(
    wanted
      .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== '')
      .map(([name, value]) => [name, String(value)]),
  );
}

/**
 * The plan a re-encode is, whichever question asked for it.
 *
 * Three callers and one shape, so it is written once. The plan's fields are the
 * re-encode's own, and a field added to either would otherwise have to be added
 * in three places that are easy to keep two of — the shape this module has
 * already been bitten by once, when `made` gained its third component.
 */
function planOf(made: ReturnType<typeof reencode>): Exclude<Plan, { kind: 'bytes' }> {
  return {
    kind: 'transcode',
    args: made.args,
    contentType: made.contentType,
    made: made.made,
    container: made.container,
  };
}

/** A plan that makes the format a client named, whatever the file holds. */
export function planTarget(input: {
  path: string;
  target: TranscodeTarget;
  times: { startMs: number; endMs: number } | null;
  tags: TrackTags;
}): Exclude<Plan, { kind: 'bytes' }> {
  return planOf(reencode(input.path, input.times, input.target, input.tags));
}

/**
 * What to do about a whole file a client cannot play.
 *
 * The same answer a segment of an MP4 or ape image gets, without the times: the
 * file is decoded and written out as FLAC. Lossless in, lossless out — ALAC and
 * Monkey's Audio are both lossless, so re-encoding costs processor time and
 * gives back exactly the audio that was asked for, and a lossy transcode would
 * be a quality decision the collection never asked anyone to make.
 *
 * A range cannot be honoured on the answer, since its length is not known until
 * ffmpeg has produced it; a client that seeks re-asks for the song.
 */
export function planWholeFile(input: {
  path: string;
  ext: string;
  target?: TranscodeTarget | null;
  times?: { startMs: number; endMs: number } | null;
  tags: TrackTags;
}): Exclude<Plan, { kind: 'bytes' }> {
  const { path, target = null, times = null, tags } = input;
  return planOf(reencode(path, times, target, tags));
}

/**
 * The arguments that make the format that was asked for out of whatever is there.
 *
 * Six possible answers and not one: `wanted` is the format a client named, or
 * the lossless default when it named none. The header here used to promise FLAC
 * and nothing else, which stopped being true the moment `format` arrived — and a
 * comment that promises what the code no longer does weighs as much as a bug in
 * this project (task:2865).
 *
 * `-ss` and `-t` are input options, so ffmpeg seeks before decoding rather than
 * decoding from the start and discarding; `-map 0:a:0` keeps the audio of a file
 * that may also carry a video stream, and `-vn` makes sure of it.
 */
function reencode(
  path: string,
  times: { startMs: number; endMs: number } | null,
  wanted: TranscodeTarget | null,
  tags: TrackTags,
): { args: (target: string) => string[]; contentType: string; made: string; container: string } {
  const seconds = (ms: number): string => (ms / 1000).toFixed(3);
  // What the answer *is* — which is not everything that was asked for, and the
  // difference is the point. A re-encode a client named as `format=flac` and one
  // the server fell back to with nothing asked are the same arguments and the
  // same bytes — and two spellings of one identity stored the *same*
  // 68 863 444-byte answer twice, 785 ms apart, under two names (measured,
  // task:2865).
  //
  // The ceiling is dropped from it for a lossless target for the same reason it
  // is dropped from the arguments below: it never reaches ffmpeg, so it is not
  // part of the answer. `flac:128` and `flac:none` were two names for one
  // answer. The channel limit is *not* dropped — it changes the bytes — and it
  // is part of the identity even when it is absent, so that one answer has one
  // spelling rather than two.
  const identity = wanted ?? { format: LOSSLESS_FORMAT, maxBitRate: null, maxChannels: null };
  const made = wanted === null ? LOSSLESS : (TARGETS[wanted.format] as Made);

  const line = [
    '-v',
    'error',
    '-nostdin',
    ...(times === null
      ? []
      : ['-ss', seconds(times.startMs), '-t', seconds(Math.max(0, times.endMs - times.startMs))]),
    '-i',
    path,
    '-map',
    '0:a:0',
    '-vn',
    '-c:a',
    made.codec,
    // A ceiling on a lossless target would be a request to throw audio away
    // while calling the answer lossless, so it is dropped where it cannot mean
    // anything — and FLAC has no bitrate to cap in the first place.
    ...(wanted === null || wanted.maxBitRate === null || made.lossless
      ? []
      : ['-b:a', `${wanted.maxBitRate}k`]),
    // The channel limit, by contrast, is obeyed whatever the target is. It comes
    // from the `transcoding` extension, where a client states what it can
    // decode: one that cannot decode six channels cannot play six channels
    // whether they arrive as mp3 or as FLAC, and answering a lossless format
    // with them anyway would be a promise about the client's hardware.
    ...(wanted?.maxChannels == null ? [] : ['-ac', String(wanted.maxChannels)]),
    // What the answer says about itself. ffmpeg copies no metadata unless it is
    // asked to (`-map 0:a:0` maps the audio and nothing else), so without these
    // a re-encoded song arrives with no tags — the same defect the hand-cut
    // segments had, in the branch that decodes (task:2895).
    //
    // `-map_metadata -1` first, and it is not redundant: `-metadata` *adds* to
    // whatever the input carried, and the input here can be a cue image whose
    // own tags name the disc rather than the track. Clearing first is what makes
    // the file state the song and only the song.
    ...['-map_metadata', '-1'],
    ...Object.entries(metadata(tags)).flatMap(([name, value]) => ['-metadata', `${name}=${value}`]),
    // **ID3v2.3, where ffmpeg would write 2.4.** The tags are the same either
    // way, and the readers are not: 2.3 is understood by both generations of
    // them, 2.4 only by the modern ones — a reader that knows 2.3 alone sees
    // every tag except the year, which lives in `TDRC` in 2.4 and in `TYER` in
    // 2.3. There is nothing in these tags that 2.4 says better, so the version
    // that everybody reads is the one to write. Asked of ffmpeg only where it
    // means something: the option belongs to the mp3 muxer.
    ...(made.container === 'mp3' ? ['-id3v2_version', '3'] : []),
    '-f',
    made.container,
  ];

  return {
    args: (target: string) => [...line, target],
    contentType: made.contentType,
    made: `${identity.format}:${made.lossless ? 'none' : (identity.maxBitRate ?? 'none')}:${identity.maxChannels ?? 'none'}`,
    container: made.container,
  };
}
