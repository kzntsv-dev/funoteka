import { spawn } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Transform } from 'node:stream';

import { HIDDEN } from '../util/child.ts';

import { kept, keyOf } from '../stream/recode.ts';
import { restating } from '../stream/rewrite.ts';
import {
  alreadyIs,
  codecOf,
  DEFAULT_LOSSY,
  ffmpegWorks,
  formatsOffered,
  planSegment,
  planTarget,
  planWholeFile,
  playable,
  segmentSize,
  stretchOf,
  windowOf,
  type ByteSegment,
  type Plan,
  type TranscodeTarget,
} from '../stream/segment.ts';
import { contentType, trackId } from './browse.ts';
import { ApiError, ERROR } from './envelope.ts';
import type { TrackTags } from '../tags/encode.ts';
import { song, type SongRow } from './meta.ts';
import type { RouteContext } from './router.ts';

/**
 * The bytes a client plays.
 *
 * The one method that does not answer in the protocol's envelope: `stream`
 * answers with audio, and everything else about the exchange — the status, the
 * headers, the range — is HTTP's business. So it is a route of a different kind
 * (`binaryRoute` in `router.ts`), and the server hands it the response rather
 * than asking it for a payload.
 *
 * Two kinds of song arrive here and they are not alike. A whole file is a file:
 * it is sent, and a range of it is sent, which is how seeking works. A song cut
 * from a cue image is not a file at all — it is a stretch of another one — and
 * `stream/segment.ts` decides how to produce it: by hand for FLAC and mp3, by
 * ffmpeg for everything else.
 *
 * Range is offered for both, and it means the same thing to a client either way:
 * the bytes it asked for. For a whole file that is a range of the file; for a cue
 * track it is a range of the *answer*, which is built rather than copied, so the
 * range is answered by building the same answer and passing over what comes
 * before it. That is what makes the bar move on a track that is not a file.
 *
 * What cannot be ranged is what ffmpeg has yet to produce: a re-encoded song or
 * a cue track of an ape or MP4 image states no length until it has one, so a
 * client that seeks there re-asks for the song from its beginning.
 */
export async function stream(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await serveSong(context, request, response, {
    id: trackId(context.query),
    asked: () => askedFor(context.query),
    offsetMs: () => offsetOf(context.query),
  });
}

/**
 * One song, in the bytes the caller asked for — the whole of `stream` below the
 * query string.
 *
 * A function of its own because `stream` is no longer the only method that
 * answers with a song's bytes. `getTranscodeStream` — the second half of the
 * `transcoding` extension — answers with the very same thing, having been told
 * *which* transcode to make by a decision it was handed earlier rather than by
 * `format` and `maxBitRate` in a query.
 *
 * **One path and not two.** What a format parameter means, what a cue track is
 * answered with, and which stretch of an image a track is *are* this server's
 * delivery policy, and a second copy of that policy would drift from the first
 * on the first change to either. What that costs is written all over this file:
 * the seam between "which stretch" and "in which format" produced four of the
 * findings of task:2865, and every one of them was two answers to one question.
 */
export async function serveSong(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  wanted: {
    id: number;
    /**
     * What the client asked for, and *when* it is worked out.
     *
     * Deferred, so that it is read after the row is looked up rather than
     * before — which is the order `stream` used to read its query in, and the
     * order the answers belong in: a request naming an id that is not there is
     * owed "no such song", not a complaint about the format it asked for a song
     * that does not exist in. Passing the values rather than the question would
     * have changed that quietly, and a rename that claims to be an extraction
     * has no business changing an answer.
     */
    asked: () => 'raw' | TranscodeTarget | null;
    offsetMs: () => number | null;
  },
): Promise<void> {
  const { id } = wanted;

  const row = song(context.db, id);
  if (row === undefined) throw new ApiError(ERROR.notFound, `No such song: ${id}`);

  const asked = wanted.asked();
  const offsetMs = wanted.offsetMs();

  // The path is the meta layer's own, never the client's: the request chose a
  // row, and the row was written by the walk. Nothing here can be talked into
  // reading a file the scan never saw.
  const path = join(row.root_path, row.rel_path);

  // Which stretch of its file this request is about — worked out once, and from
  // the row. A cue track is a stretch of an image whether or not the client
  // knows it is one, and the client's offset moves its near end. Every branch
  // below is about *that stretch* and never about the file it lies in, which is
  // the seam three of the review's findings lived on: the format branch built
  // its plan from the image's path and the client's offset alone, so a cue track
  // asked for in another format was answered with the whole image (task:2865).
  const stretch = stretchOf(row, offsetMs);
  if (stretch.kind === 'refused') throw new ApiError(ERROR.generic, stretch.reason);
  const times = stretch.kind === 'span' ? { startMs: stretch.startMs, endMs: stretch.endMs } : null;

  // `format=raw` is the protocol's own way of saying "do not transcode": nothing
  // below is reached for, and not a byte of this answer is decoded. On a cue
  // track of an image only ffmpeg can read that is a refusal a client can act
  // on, and not the re-encode it said not to make. On a whole file the offset is
  // vacuous — there is no transcode to start late — and a client that means to
  // begin part-way into a byte copy says so with a Range header.
  if (asked === 'raw') {
    if (row.segment_start_ms !== null) {
      await serveSegment(context, row, path, request, response, { times, as: 'raw' });
      return;
    }
    await serveBytes(path, contentType(row.ext), request, response);
    return;
  }

  const target = asked;

  // A cue track is a stretch of an image, and it is answered as one. A client
  // that named no format, or the one the image already holds, gets that stretch
  // cut out of the image — by hand where its frames can be restated, by ffmpeg
  // where they cannot. One that named another format gets that format made from
  // the stretch, and never from the whole image.
  if (row.segment_start_ms !== null) {
    if (target === null || alreadyIs(target, row)) {
      await serveSegment(context, row, path, request, response, { times, as: 'stream' });
      return;
    }
    await serveReencoded(
      context,
      path,
      row.ext,
      times,
      carriedOut(planTarget({ path, target, times, tags: tagsOf(row) })),
      request,
      response,
    );
    return;
  }

  // A whole file is a file: sent as it is when a client can play it and asked
  // for nothing else, or when it already is what was asked for. An offset is
  // neither — a byte copy has no time axis to start later on — so it is built.
  if (offsetMs === null) {
    const asIs =
      target === null
        ? playable(await codecOf(path, row.ext, row.codec), row.ext)
        : alreadyIs(target, row);
    if (asIs) {
      await serveBytes(path, contentType(row.ext), request, response);
      return;
    }
  }

  await serveReencoded(
    context,
    path,
    row.ext,
    times,
    carriedOut(planWholeFile({ path, ext: row.ext, target, times, tags: tagsOf(row) })),
    request,
    response,
  );
}

/**
 * The song, as the tags a built file carries.
 *
 * **The song's artist is the file's own where the file names one, and the
 * record's otherwise** — the same rule `songChild` writes into a payload, made
 * once more here because this is the other place the answer leaves the server.
 * A compilation is what it is for: the record is credited `Various Artists`,
 * which is true of the record and false of every track on it, and a cut file
 * that says `ARTIST=Various Artists` has been told something the client was
 * not.
 *
 * Everything else is the record's, because a song has none of its own: the year
 * is the album's, the number is its place on the record, and the genre is the
 * one this file states.
 */
function tagsOf(row: SongRow): TrackTags {
  return {
    title: row.title,
    artist: row.track_artist ?? row.artist_name,
    albumArtist: row.artist_name,
    album: row.album_title,
    trackNumber: row.ordinal,
    discNumber: row.disc_number,
    date: row.album_year === null ? null : String(row.album_year),
    genre: row.genre,
  };
}

/** A plan that has to be carried out, or the refusal it turned out to be. */
function carriedOut(plan: Exclude<Plan, { kind: 'bytes' }>): Extract<Plan, { kind: 'transcode' }> {
  if (plan.kind !== 'transcode') throw new ApiError(ERROR.generic, plan.reason);
  return plan;
}

/**
 * What the client asked to be sent: a target, `raw`, or nothing.
 *
 * `format` is a *container*, and the protocol lets a client name any string. A
 * name this server cannot make is refused here rather than reaching ffmpeg,
 * where the failure would be a message no client can act on — and the refusal
 * says what *is* on offer, which is the one thing it can do about it.
 */
function askedFor(query: URLSearchParams): 'raw' | TranscodeTarget | null {
  const format = query.get('format');
  const ceiling = ceilingOf(query);

  if (format === 'raw') return 'raw';

  if (format !== null && format !== '') {
    if (!formatsOffered().includes(format)) {
      throw new ApiError(
        ERROR.generic,
        `This server cannot make ${format}; it makes ${formatsOffered().join(', ')}`,
      );
    }
    return { format, maxBitRate: ceiling };
  }

  if (ceiling === null) return null;

  // A ceiling and no format: a lossless file cannot be limited without leaving
  // lossless, so this is a request for the lossy default — but only when the
  // file is above it, which is `alreadyIs`'s to decide.
  return { format: DEFAULT_LOSSY, maxBitRate: ceiling };
}

/** The `maxBitRate` parameter: kilobits per second, and nought means no ceiling. */
function ceilingOf(query: URLSearchParams): number | null {
  const raw = query.get('maxBitRate');
  if (raw === null || raw === '') return null;

  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new ApiError(ERROR.generic, `maxBitRate is not a bitrate: ${raw}`);
  }
  return rate === 0 ? null : rate;
}

/** The `timeOffset` parameter, in milliseconds — the protocol counts in seconds. */
function offsetOf(query: URLSearchParams): number | null {
  const raw = query.get('timeOffset');
  if (raw === null || raw === '') return null;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new ApiError(ERROR.generic, `timeOffset is not an offset: ${raw}`);
  }
  return seconds * 1000;
}

export async function serveBytes(
  path: string,
  type: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const size = statSync(path).size;

  const wanted = parseRange(request.headers.range, size);
  if (wanted === 'unsatisfiable') {
    response.writeHead(416, { 'content-range': `bytes */${size}` });
    response.end();
    return;
  }

  const start = wanted === null ? 0 : wanted.start;
  const end = wanted === null ? size - 1 : wanted.end;
  const length = size === 0 ? 0 : end - start + 1;

  response.writeHead(wanted === null ? 200 : 206, {
    'content-type': type,
    'content-length': length,
    'accept-ranges': 'bytes',
    ...(wanted === null ? {} : { 'content-range': `bytes ${start}-${end}/${size}` }),
  });

  // A HEAD asks what a GET would bring, and is owed the headers and nothing
  // else. Reading the file to throw the bytes away would be the one thing the
  // method exists to avoid.
  if (request.method === 'HEAD' || length === 0) {
    response.end();
    return;
  }
  await pipeFile(path, start, end, response);
}

/**
 * A song that has to be built rather than copied, built — and then kept.
 *
 * Two things arrive here: a whole file no client plays, and a stretch of an image
 * whose frames cannot be cut by hand. What either is re-encoded *into* is what
 * was asked for — the format a client named, or the lossless default when it
 * named none. ffmpeg produces a stream, and a stream's length is not known until
 * it ends, so the answer is written to a file rather than piped: kept whole, it
 * is seekable like any other and the second listen costs nothing. Where it is
 * kept, and for how long, is `stream/recode.ts`'s to say.
 *
 * **The stretch is part of which answer this is**, and is handed to the cache
 * with it. It is not decoration: two cue tracks of one image asked for in the
 * same format are two different answers, and a key that named only the image
 * made them one (task:2865).
 *
 * ffmpeg is asked for only when there is nothing to answer with, so a re-encoded
 * song already in the cache plays on a machine that has no ffmpeg at all.
 *
 * A range cannot be honoured on the *first* play — the length is not known until
 * the file is written, and the file is written before the first byte goes out.
 * That wait is the price of the bar moving at all; it is paid once per song.
 */
async function serveReencoded(
  context: RouteContext,
  source: string,
  ext: string,
  times: { startMs: number; endMs: number } | null,
  plan: Extract<Plan, { kind: 'transcode' }>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const binary = context.config.ffmpeg;
  let produced: string;
  try {
    produced = await kept({
      dir: context.config.cacheDir,
      // The stretch is part of the key and has to be: two cue tracks of one
      // image asked for in the same format are two different answers, and a key
      // that named only the image called them one — so the first track
      // requested became the answer for every other track of that disc, and
      // stayed it (measured, task:2865).
      key: keyOf({ source, ...(times ?? {}), made: plan.made }),
      // What is kept is named by what it holds. It used to be `.flac` whatever
      // was inside, which was true while FLAC was the only thing ever produced
      // and is a file lying about itself now that a client can ask for mp3.
      extension: `.${plan.container}`,
      produce: async (target) => {
        if (!ffmpegWorks(binary)) {
          throw new Error(
            `This song is a .${ext} file no browser plays, and ffmpeg — which re-encodes one — is not installed`,
          );
        }
        await encode(binary, plan.args(target));
      },
    });
  } catch (error) {
    // A refusal a client can read beats a stream that stops: ffmpeg says why it
    // would not produce the answer, and that sentence is the whole of what
    // anyone downstream could know.
    throw new ApiError(ERROR.generic, error instanceof Error ? error.message : String(error));
  }

  await serveBytes(produced, plan.contentType, request, response);
}

/** ffmpeg, writing the file it was told to write, or the reason it did not. */
function encode(binary: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], ...HIDDEN });
    let complaint = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (complaint.length < 4096) complaint += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${complaint.trim()}`));
    });
  });
}

/**
 * A cue track: a stretch of an image, served as a track.
 *
 * Everything that could refuse happens before the first header is written,
 * because a refusal after that is not a refusal — the client has already been
 * told the answer is audio.
 */
export async function serveSegment(
  context: RouteContext,
  row: SongRow,
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  {
    times,
    as = 'stream',
  }: {
    /**
     * The stretch of the image to cut: the song's own bounds, moved by whatever
     * the client asked to skip.
     *
     * Worked out by the caller and never here. This computing it from the row
     * while the route computed it again for the plan is what left two answers to
     * one question standing — and the route's answer was the *image*, so a cue
     * track asked for in another format was answered with the whole disc
     * (task:2865).
     */
    times: { startMs: number; endMs: number } | null;
    /**
     * Who is asking, which decides whether the one branch that decodes may be
     * taken — and what the refusal says when it may not.
     *
     * Three callers and two promises. `stream` promises nothing beyond the
     * bytes, so a client that cannot read Monkey's Audio is served a FLAC
     * instead of silence. `format=raw` is the protocol's own "disable
     * transcoding", and `download` stands on the original media data "without
     * transcoding or downsampling" — and each of those refuses rather than break
     * its word. Copying a frame range is *not* a transcode — nothing is decoded
     * and nothing is resampled — which is why only this branch closes to them.
     */
    as?: 'stream' | 'raw' | 'download';
  },
): Promise<void> {
  // A stretch a caller could not bound is a refusal and not an answer, and the
  // caller is the one that knows why — `stretchOf` says it in its own words.
  if (times === null) throw new ApiError(ERROR.generic, 'This segment has no length to serve');
  const { startMs, endMs } = times;

  const plan = await planSegment({
    path,
    ext: row.ext,
    startMs,
    endMs,
    tags: tagsOf(row),
  });

  if (plan.kind === 'unavailable') throw new ApiError(ERROR.generic, plan.reason);

  if (plan.kind === 'transcode') {
    if (as !== 'stream') throw new ApiError(ERROR.generic, onlyByReencoding(row, as));
    await serveReencoded(context, path, row.ext, times, plan, request, response);
    return;
  }

  const { from, to, frames } = plan.segment;
  const size = segmentSize(plan.segment);

  // A range on a cue track is a range of the *answer*, which is a thing built
  // here rather than a stretch of a file — so it is answered by building the
  // same answer and passing over what comes before. That is what makes seeking
  // work on a track that is not a file, and it is cheap: the frames are in
  // memory and the work is the CRC of each, not a walk from the beginning of a
  // three-hundred-megabyte image.
  const wanted = parseRange(request.headers.range, size);
  if (wanted === 'unsatisfiable') {
    response.writeHead(416, { 'content-range': `bytes */${size}` });
    response.end();
    return;
  }

  const start = wanted === null ? 0 : wanted.start;
  const end = wanted === null ? size - 1 : wanted.end;
  const window = windowOf(plan.segment, start, end);

  response.writeHead(wanted === null ? 200 : 206, {
    'content-type': contentType(row.ext),
    'content-length': size === 0 ? 0 : end - start + 1,
    'accept-ranges': 'bytes',
    ...(wanted === null ? {} : { 'content-range': `bytes ${start}-${end}/${size}` }),
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  if (window.prefix.length > 0) response.write(window.prefix);
  await pipeFile(
    path,
    from,
    to - 1,
    response,
    restating(frames, from, { skip: window.skip, limit: window.limit }),
  );
}

/**
 * Why a stretch of an image only ffmpeg can read is refused to this caller.
 *
 * The sentence has to be the one *this* caller actually made. `download`
 * promises the original media data; `format=raw` is the protocol's "disable
 * transcoding". A refusal that named the other one's promise is a lie to a
 * client — which is the class of thing the whole of this file exists to avoid,
 * and one that arrived here the moment `format=raw` was routed through the
 * branch that already had a message written for download (found live, on a cue
 * track of an `.m4a` image: task:2865).
 */
function onlyByReencoding(row: SongRow, as: 'raw' | 'download'): string {
  const promise =
    as === 'raw'
      ? 'which is the one thing format=raw asked not to do. Ask for a format, or download the image.'
      : 'which is the one thing download promises not to do. Ask stream for it, or download the image.';

  return (
    `"${row.title ?? row.rel_path}" is a stretch of ${row.rel_path}, and the only way to ` +
    `produce it is to re-encode it — ${promise}`
  );
}

/**
 * One range of one file, as a stream that ends with the response.
 *
 * `through` is where a range that is not sent as the file holds it is restated —
 * a FLAC segment's frame headers, whose numbers become the track's own. The
 * substitution needs no more than one pass and no more memory than a chunk, so
 * a segment of a three-hundred-megabyte image is served as it always was.
 */
function pipeFile(
  path: string,
  start: number,
  end: number,
  response: ServerResponse,
  through?: Transform,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const file = createReadStream(path, { start, end });
    file.on('error', reject);
    // The response's own end is the other way this finishes: a client that hung
    // up mid-track is not an error worth reporting, but it must not leave the
    // file open.
    response.on('close', () => file.destroy());

    const out = through === undefined ? file : file.pipe(through);
    out.on('error', reject);
    out.pipe(response).on('finish', resolve).on('error', reject);
  });
}

/**
 * The bytes a client asked for, or that it asked for none, or that it asked for
 * something that is not there.
 *
 * A header this does not understand is treated as no request at all, which the
 * protocol allows: a server may always answer with the whole file, and a range
 * it cannot parse is better served whole than refused. The distinction matters
 * — `unsatisfiable` is a 416 the client can act on, and everything else here is
 * a 200 it can play.
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;

  const from = match[1] ?? '';
  const to = match[2] ?? '';
  if (from === '' && to === '') return null;

  // `bytes=-500` is the last five hundred bytes, not the first: a suffix range
  // measures back from the end, so both of its ends come from the file's size
  // and neither is the number that was written. Reading that number as the end
  // — the obvious thing, and the thing this did first — produced a range whose
  // end was before its start, a negative length, and a connection closed under
  // a client that had done nothing wrong.
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(from);
  if (start >= size) return 'unsatisfiable';

  // An end before the start is not a range at all. Serving the whole file is
  // the answer the protocol prescribes for one, and is what a client that wrote
  // it by accident can still play.
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? null : { start, end };
}

/** Re-exported so the route's callers read one name for the shape of a segment. */
export type { ByteSegment };
