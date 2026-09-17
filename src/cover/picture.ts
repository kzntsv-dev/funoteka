import { closeSync, openSync, readSync } from 'node:fs';

import { oggPicture } from '../tags/ogg.ts';
import { pictureInComment, type CommentPicture } from '../tags/vorbis-comment.ts';

/**
 * The cover a file carries when its bytes are not a range of it.
 *
 * Everything else in this project records *where* a picture is and serves that
 * range (`TagPicture`, and `db/migrations/013_cover_art.sql`), because a copy
 * would be gigabytes of something already on the disk and would go stale the
 * moment somebody edited the file's tags. A `METADATA_BLOCK_PICTURE` comment
 * breaks the premise rather than the rule: it is base64 of a picture block
 * sitting in a packet the lacing rule has scattered across pages, so there is no
 * range whose bytes are the image. What the scan writes down is therefore a
 * range *worth reading* — `TagPicture.indirect` — and this is the other half:
 * read it, and derive the picture again.
 *
 * Nothing is copied into the meta layer: what is stored is where to look, and the
 * picture is derived from those bytes again on each request. A file whose comment
 * was rewritten to the same length therefore serves the new picture without a
 * rescan. One that has grown past the recorded region serves none, because the
 * packet is cut at the old end — a stale row rather than a missing file, and the
 * next scan writes it again.
 *
 * The cost is paid where it can be afforded. A cover is asked for once per album
 * per client, and a client caches what it gets, while the scan walks everything
 * — so this runs rarely over a region of a couple of hundred kilobytes, and the
 * scan runs always over the whole file.
 */

/**
 * The largest region this will read, in bytes.
 *
 * A comment packet is a few hundred kilobytes in every real file, and the region
 * ends where that packet does. The bound is here because this runs on a request
 * rather than during a scan: a file whose comment packet ran for a gigabyte
 * would otherwise have a client ask the server to allocate a gigabyte, and the
 * answer for such a file is that it has no cover this will serve — which draws
 * the client's placeholder, exactly as a record with no art does.
 *
 * Sized against what the scan can actually record rather than picked round. The
 * region runs from the start of the file to the end of the page the comment
 * finishes on, and the reader assembles no packet beyond
 * `MAX_HEADER_PACKET_BYTES` (16 MiB, `src/tags/ogg.ts`). The identification
 * packet sharing those pages is tens of bytes, so the worst region a scan can
 * write is a shade over 16 MiB once page headers are counted. This bound is
 * larger than that on purpose: refusing a row the scan wrote is the safe
 * direction, but a bound that disagrees with its own writer is a defect waiting
 * to be reported as one.
 */
const MAX_REGION_BYTES = 64 * 1024 * 1024;

/**
 * Read `[offset, offset + length)` of a file, or null when it cannot be read.
 *
 * Read in a loop because a single `readSync` is allowed to return less than was
 * asked for, and a partial region would be parsed as a truncated file rather
 * than reported as an unreadable one.
 */
function readRegion(path: string, offset: number, length: number): Buffer | null {
  if (offset < 0 || length <= 0 || length > MAX_REGION_BYTES) return null;

  // `openSync` is inside the `try`. A file that has gone is one of the cases this
  // answers `null` for, and opening it outside made that promise unreachable: the
  // error escaped and the route answered `Internal error` instead of saying the
  // picture could not be read.
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const got = readSync(fd, buffer, filled, length - filled, offset + filled);
      if (got <= 0) break;
      filled += got;
    }
    return buffer.subarray(0, filled);
  } catch {
    // A file that has gone, or one this process may not open. A cover is not
    // worth an exception: the client is told there is none.
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The picture in that region, or null when there is not one.
 *
 * Which reader to ask is decided by the container, and the container is a
 * verdict the scan already reached and wrote down (`file.tags_container`) rather
 * than something to work out again from four magic bytes — the same reason the
 * probe's answer is stored rather than re-derived at serving time.
 *
 * Two containers can be indirect and both do the same thing by different roads.
 * An Ogg region is pages, and the picture has to be reassembled out of the
 * comment packet they carry. A FLAC region is the comment block itself, already
 * contiguous, and is read directly. Nothing else in this project has a picture
 * that is not a range: MP4 `covr` and ID3v2 `APIC` both name the image's own
 * bytes, which is why neither appears here.
 */
export function pictureInRegion(
  path: string,
  container: string | null,
  offset: number,
  length: number,
): CommentPicture | null {
  const region = readRegion(path, offset, length);
  if (region === null) return null;

  if (container === 'ogg') return oggPicture(region);
  if (container === 'flac') return pictureInComment(region, 0, region.length);
  return null;
}
