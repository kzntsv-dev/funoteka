import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { stretchOf } from '../stream/segment.ts';

import { contentType, trackId } from './browse.ts';
import { ApiError, ERROR } from './envelope.ts';
import { song } from './meta.ts';
import type { RouteContext } from './router.ts';
import { serveBytes, serveSegment } from './stream.ts';

/**
 * The file itself, for a client that means to keep it.
 *
 * `stream`'s plainer sibling, and the difference is the whole of what this
 * method is for: `stream` answers with something a client can *play* — a cue
 * track cut out of an image, a re-encode of a format the client cannot read —
 * and `download` answers with the original media data, "without transcoding or
 * downsampling", which is what a client needs to put a record on a phone for a
 * train. So there is one path here and no plan: the file the row names, sent as
 * it is.
 *
 * **A song cut from a cue image is sent as its own frames, not as the image.**
 * The first version of this handed back the whole file, on the reasoning that
 * anything else would be "cutting" what the method promises to deliver whole —
 * and that reasoning was wrong, in the way that matters: the saved file played
 * from the top of the disc, so a client that asked for track nine got the wrong
 * song in 510 MB, for 1 789 of this collection's 4 969 tracks (task:2864).
 *
 * Copying a frame range is not a transcode. Nothing is decoded, nothing is
 * resampled, and `stream/segment.ts` calls that path lossless for the same
 * reason `stream` uses it. What this method refuses is ffmpeg — so for the few
 * images whose frames cannot be restated (ape, MP4) the segment is refused with
 * a reason rather than served as something else, and the sender is told to ask
 * `stream` or to take the image deliberately.
 *
 * The bytes and the ranging are `stream.ts`'s — `serveBytes` and `serveSegment`
 * are the same functions the stream route uses, so seeking a download works for
 * the same reason seeking a stream does and cannot drift away from it.
 */
export async function download(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const id = trackId(context.query);
  const row = song(context.db, id);
  if (row === undefined) throw new ApiError(ERROR.notFound, `No such song: ${id}`);

  // The path is the meta layer's own, never the client's — the rule `stream.ts`
  // states, and the reason neither of these can be talked into reading a file
  // the scan never saw.
  const path = join(row.root_path, row.rel_path);

  // Asked here rather than left to `serveBytes`, which would find it out by
  // throwing from `statSync`. The difference is the header below: a refusal is
  // rendered into the same response, and an `attachment` beside "Internal
  // error" is a client saving a refusal under a track's name.
  if (!existsSync(path)) {
    throw new ApiError(ERROR.notFound, `No such file on disk: ${row.rel_path}`);
  }

  // Set before `serveBytes` writes the head, which keeps what was set here:
  // this is the method a client saves with, and a name is what makes a saved
  // file recognisable.
  // A whole file is saved under its own name; a stretch of one is saved under
  // the song's, because that is what it is — `Tool - Undertow.flac` is a file
  // somebody can find again, and `Tool - Undertow [61422-33010-2].flac` is a
  // 510 MB disc they did not ask for.
  response.setHeader(
    'content-disposition',
    attachmentOf(
      row.segment_start_ms === null
        ? basename(path)
        : `${row.title ?? basename(path)}.${row.ext}`,
    ),
  );

  if (row.segment_start_ms !== null) {
    // A song cut from an image is a stretch of it, and the stretch is what this
    // method is asked for. `serveSegment` copies the frames — nothing is decoded
    // and nothing is resampled, so it is the original data and not a transcode
    // — and the one branch it is not allowed here is ffmpeg's, which would make
    // the answer a different file from the one on disk.
    // The stretch is the song's own, and there is no offset here to move it:
    // download has no `timeOffset`, and the file a client asked to keep is the
    // track, not a later part of it.
    const stretch = stretchOf(row, null);
    if (stretch.kind !== 'span') {
      throw new ApiError(
        ERROR.generic,
        stretch.kind === 'refused' ? stretch.reason : 'This song is not a stretch of its file',
      );
    }
    await serveSegment(context, row, path, request, response, {
      times: stretch,
      as: 'download',
    });
    return;
  }

  await serveBytes(path, contentType(row.ext), request, response);
}

/**
 * A `Content-Disposition` a header can actually carry.
 *
 * **Two filenames, and the second is not decoration.** A header value is
 * latin-1, and this collection's names are not: a folder called `Кино` would
 * make `setHeader` throw and take the whole request down with it. So the plain
 * `filename` is the name with everything outside ASCII replaced, and
 * `filename*` carries the real one percent-encoded, which is what RFC 5987
 * added and what every client that matters reads. A client that understands
 * only the first gets a file it can still recognise; one that reads the second
 * gets the name the file has.
 */
function attachmentOf(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_');
  return `attachment; filename="${safe}"; filename*=UTF-8''${extValue(name)}`;
}

/**
 * A string as RFC 5987's `ext-value`, which `encodeURIComponent` is not.
 *
 * The standard's `attr-char` leaves out `'`, `(`, `)`, `*` and `!` — and
 * `encodeURIComponent` escapes none of the first four. `'` is the one that
 * bites: it is the quote around the charset in `UTF-8''`, so a name like
 * `Guns N' Roses (Live).flac` emitted an encoding whose own separator appears
 * inside it, and a strict client drops the whole parameter and falls back to
 * the ASCII stand-in.
 */
function extValue(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
