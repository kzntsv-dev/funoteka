import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { pickCover } from '../cover/pick.ts';
import { pictureInRegion } from '../cover/picture.ts';
import type { DatabaseSync } from '../db/index.ts';
import { parseId, required } from './browse.ts';
import { ApiError, ERROR } from './envelope.ts';
import {
  album,
  albumPlacesOfArtist,
  artist,
  artistOwnFolders,
  embeddedCoverInFolder,
  fileFoldersOfAlbums,
  folder,
  picturesInFolder,
  root,
  song,
  type AlbumPlace,
  type FolderRef,
} from './meta.ts';
import type { RouteContext } from './router.ts';

/**
 * The cover a client shows beside a record.
 *
 * The protocol asks for one image by the id of whatever is on screen — an
 * album, an artist, a song, a folder — so the id is a way of *asking*, not a
 * statement about where the picture is. What this file does is turn each kind
 * of id into the folders worth looking in, in the order worth looking, and hand
 * the first picture found to the client.
 *
 * Only the folder's own pictures are considered. Descending into a subfolder
 * looks tempting — the scans of a box often sit in a `Full scans` or `Artwork`
 * directory — but those directories are where the *back*, the disc and the
 * booklet live, and a rule that reached into one would as often answer with the
 * back of the record as with its front. A folder that keeps its cover nowhere
 * answers "no cover", and the client draws its own placeholder.
 *
 * Nothing is scaled. The protocol allows a `size`, and this server answers with
 * the collection's own file whatever size was asked for: nothing in the runtime
 * can decode an image, and the file the operator scanned is a truer answer than
 * a resize made by guessing. A client that wants a thumbnail makes one.
 */

/** What an image file is, so the client knows what it is about to receive. */
const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export function imageContentType(ext: string): string {
  return IMAGE_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * The folders an id asks about, best first.
 *
 * Several, because the meta layer's answer is not always one folder: a song on
 * no album still has the folder it sits in, and an album whose row names a file
 * rather than a directory — what a loose download becomes — keeps its pictures
 * in the folder that file is in. An artist is the one case where the list is
 * genuinely long: it has no art of its own, so every one of its records offers
 * what it has.
 *
 * The order is the caller's own and is kept, but it is not what decides first:
 * these folders are a *set* to be ranked once, so the record that happens to
 * come first does not answer for the artist — a record whose picture is named
 * `front` does, wherever in the list it sits. The order decides only the case
 * no name decides, and `foldersOfAlbums` preserves it for exactly that; a
 * comment here once said the caller must not read the list as ordered at all,
 * which the ranking below contradicts.
 */
function candidateFolders(db: DatabaseSync, id: string): FolderRef[] {
  const parsed = parseId(id);
  if (parsed === undefined) return [];

  switch (parsed.kind) {
    case 'al': {
      const row = album(db, parsed.n);
      return row === undefined ? [] : foldersOfAlbums(db, [row]);
    }

    case 'tr': {
      const row = song(db, parsed.n);
      if (row === undefined) return [];
      const own: FolderRef = { rootId: row.root_id, relPath: row.folder_rel_path };
      if (row.album_id === null) return [own];

      const record = album(db, row.album_id);
      return record === undefined
        ? [own]
        : distinct([{ rootId: record.root_id, relPath: record.rel_path }, own]);
    }

    case 'ar': {
      const row = artist(db, parsed.n);
      if (row === undefined) return [];
      // Through the same expansion an album gets, and for the same reason: a
      // record whose row names a *file* — a flat rip, a `.ape` beside its cue —
      // keeps its pictures in the folder that file is in, and an artist asking
      // for art is asking about its records either way.
      //
      // Asked for the artist's records *together*, because the answer is a set:
      // the folders of thirty records are one join, where asking each record on
      // its own read that record's whole song list to learn the same thing. And
      // asked for their *places* rather than for the records, because a cover is
      // not about what a record holds — the genre and the running time this
      // route never reads are built for every album in the collection before the
      // artist's are picked out.
      return foldersOfAlbums(db, albumPlacesOfArtist(db, row.id));
    }

    case 'fd': {
      const row = folder(db, parsed.n);
      return row === undefined ? [] : [{ rootId: row.root_id, relPath: row.rel_path }];
    }

    case 'ro': {
      const row = root(db, parsed.n);
      // A root is a folder like any other — `''` is the row that stands for it
      // (`db/migrations/001_init.sql`) — so the pictures an operator dropped in
      // their download folder are reachable the same way a record's are.
      return row === undefined ? [] : [{ rootId: row.id, relPath: '' }];
    }
  }
}

/**
 * The folders several records' pictures could be in, best first.
 *
 * The album's row is its folder by the identity rule, and the songs are where
 * that stops being true: a flat rip whose every file became its own album names
 * the file, not a directory (`.ape` beside its cue is the shape this collection
 * has). Both are offered per record, the row's own first, so that a record keyed
 * on a file still finds the folder the file sits in.
 *
 * The records are taken as many at once rather than one at a time, and the
 * caller's own order is what the result is in — a record's row, then its files,
 * then the next record's. That order is the tie-break when no picture's name
 * says which side it is, so it is preserved rather than sorted.
 */
function foldersOfAlbums(db: DatabaseSync, records: readonly AlbumPlace[]): FolderRef[] {
  const files = fileFoldersOfAlbums(
    db,
    records.map((row) => row.id),
  );
  return distinct(
    records.flatMap((row) => [
      { rootId: row.root_id, relPath: row.rel_path },
      ...(files.get(row.id) ?? []),
    ]),
  );
}

function distinct(folders: FolderRef[]): FolderRef[] {
  const seen = new Set<string>();
  return folders.filter(({ rootId, relPath }) => {
    const key = `${rootId}\u0000${relPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Where a cover's bytes are, and what they are.
 *
 * Two kinds, and the difference is only where to read: a picture sitting beside
 * the record is a file of its own, and one the record carries is a range of an
 * audio file. Both are served as bytes; neither is copied into the meta layer.
 */
export type Cover =
  | { kind: 'file'; rootPath: string; relPath: string; ext: string }
  | { kind: 'embedded'; rootPath: string; relPath: string; mime: string; offset: number; length: number }
  | {
      kind: 'indirect';
      rootPath: string;
      relPath: string;
      container: string | null;
      offset: number;
      length: number;
    };

/** A picture sitting on disk, as the cover to serve. */
function fileCover(picture: { root_path: string; rel_path: string; ext: string }): Cover {
  return { kind: 'file', rootPath: picture.root_path, relPath: picture.rel_path, ext: picture.ext };
}

/**
 * The picture a single folder holds, or nothing when it holds none.
 *
 * One folder's own pictures ranked on their own — the reader `resolve` uses for
 * its first question, which asks a folder named for the artist before it asks
 * anything of the artist's records.
 */
function coverInFolder(db: DatabaseSync, { rootId, relPath }: FolderRef): Cover | undefined {
  const chosen = pickCover(picturesInFolder(db, rootId, relPath));
  return chosen === undefined ? undefined : fileCover(chosen);
}

/**
 * The cover to serve for an id, or nothing when there is none to serve.
 *
 * The pictures of every folder an id names are ranked as one set, so a record
 * whose own folder is bare still finds its songs' folder, and a front cover one
 * level down still beats a scan or an information sheet at the top. The choice
 * among them is `pickCover`'s, and the folder order is what decides when no name
 * says anything.
 *
 * The picture beside a record wins over the one inside it, and that is a
 * judgement rather than a rule of the format: a file an operator put in the
 * folder was put there to be the cover, while what a file carries is often
 * whatever the encoder happened to embed — a thumbnail, or the sleeve of a
 * different pressing the tracks were copied from.
 */
interface Resolved {
  picture: Cover | undefined;
  /**
   * The folders walked, so a refusal can say where it looked. Riding back with
   * the answer is the point of it: the 404 path used to walk the same ground a
   * second time to write its message, which made a refusal twice the work of a
   * success.
   *
   * Read only when there is no picture. The artist's own folder answers before
   * the walk begins and reports the one folder that held the picture rather than
   * every folder it might have asked — and that branch cannot refuse, so nothing
   * reads the difference.
   */
  folders: FolderRef[];
}

function resolve(db: DatabaseSync, id: string): Resolved {
  // An artist's own folder answers for the artist, and only for the artist.
  //
  // It is asked apart from the ranking below rather than put at the front of
  // its list, because "first among equals" would not decide anything: a folder
  // named for the artist holds a `folder.jpg`, a record's folder holds a
  // `front.jpg`, and `front` outranks `folder` — so an album cover would still
  // have won the tie it was never party to. A picture of the artist is a fact
  // about the artist, and where the collection states one it is the answer.
  const asked = parseId(id);
  if (asked !== undefined && asked.kind === 'ar') {
    for (const where of artistOwnFolders(db, asked.n)) {
      const own = coverInFolder(db, where);
      if (own !== undefined) return { picture: own, folders: [where] };
    }
  }

  const folders = candidateFolders(db, id);

  // Every folder's pictures as one set, ranked once — not "the first folder
  // holding anything answers".
  //
  // A box keeps its front cover inside each disc and its paperwork in the box
  // folder, and the folder that answers first is the box's: `Кинохроники` has an
  // `info.png` at the top and `front.jpg` one level down, so the sheet about the
  // release was served as its cover. Ranking across the folders lets a name that
  // says `front` win wherever it is, and the folder order still decides when no
  // name says anything — `pickCover` falls back to the first picture it was
  // given, and the record's own folder is first in the list.
  const pictures = folders.flatMap(({ rootId, relPath }) =>
    picturesInFolder(db, rootId, relPath),
  );
  const chosen = pickCover(pictures);
  if (chosen !== undefined) {
    return { picture: fileCover(chosen), folders };
  }

  for (const { rootId, relPath } of folders) {
    const embedded = embeddedCoverInFolder(db, rootId, relPath);
    if (embedded === undefined) continue;

    // Two kinds of place, and the row says which. A picture the file carries as
    // its own bytes is a range a client can be sent; one it carries base64'd
    // inside a comment is a range that has to be read and parsed first — see
    // `src/cover/picture.ts`.
    const picture: Cover =
      embedded.kind === 'indirect'
        ? {
            kind: 'indirect',
            rootPath: embedded.root_path,
            relPath: embedded.rel_path,
            container: embedded.container,
            offset: embedded.offset,
            length: embedded.length,
          }
        : {
            kind: 'embedded',
            rootPath: embedded.root_path,
            relPath: embedded.rel_path,
            mime: embedded.mime,
            offset: embedded.offset,
            length: embedded.length,
          };
    return { picture, folders };
  }

  return { picture: undefined, folders };
}

/**
 * The route.
 *
 * Bytes, not an envelope, so it is a `BinaryRoute` like `stream` — but with one
 * difference that matters: it knows the whole answer before the first header is
 * written. An image is a file, and a file's size is known. So a refusal is
 * always still a refusal the client can read, and the response is never a
 * connection that ends without saying why.
 */
export async function coverArt(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const id = required(context.query, 'id');
  const { picture, folders } = resolve(context.db, id);

  if (picture === undefined) {
    // The folder is named when one was looked in, because "this record has no
    // cover" and "there is no such record" are different things to go and fix,
    // and the message is the only place a caller learns which happened. The
    // folders come from the lookup that just failed rather than a second walk of
    // the same ground.
    const where = folders.map((f) => f.relPath || '/');
    throw new ApiError(
      ERROR.notFound,
      where.length === 0
        ? `No such id: ${id}`
        : `No cover art for ${id}: ${where.join(', ')} holds no picture`,
    );
  }

  const path = join(picture.rootPath, picture.relPath);

  // The kind of place that is not a range. Its bytes have to be derived before
  // anything can be promised about them — including whether there are any — so
  // this is the one branch that is not a `readStream` over a slice.
  if (picture.kind === 'indirect') {
    const derived = pictureInRegion(path, picture.container, picture.offset, picture.length);

    if (derived === null) {
      // The row said a picture was there and it could not be derived: the file
      // has changed since the scan, or its comment is damaged. Saying so is the
      // same answer as having none, because that is what the client gets — but
      // the message names the file, which is where to go and look.
      throw new ApiError(
        ERROR.notFound,
        `No cover art for ${id}: the picture inside ${picture.relPath} could not be read`,
      );
    }

    response.writeHead(200, {
      'content-type': derived.mime,
      'content-length': derived.data.length,
    });

    if (request.method === 'HEAD' || derived.data.length === 0) {
      response.end();
      return;
    }

    // Already in memory, so it goes out as it is: a stream over a buffer is a
    // second copy of a picture that was just decoded into the first.
    response.end(derived.data);
    return;
  }

  // Where in that file the bytes are: the whole of it for a picture sitting
  // beside the record, and a named range of it for one the record carries.
  const [from, to, mime] =
    picture.kind === 'file'
      ? [0, statSync(path).size - 1, imageContentType(picture.ext)]
      : [picture.offset, picture.offset + picture.length - 1, picture.mime];

  const length = to - from + 1;
  response.writeHead(200, { 'content-type': mime, 'content-length': length });

  // A HEAD asks what a GET would bring. Reading the file to throw the bytes
  // away is the one thing the method exists to avoid.
  if (request.method === 'HEAD' || length <= 0) {
    response.end();
    return;
  }

  await pipeRange(path, from, to, response);
}

/**
 * The picture, as a stream that ends with the response.
 *
 * Bounded by the last byte the header already promised, and that bound is not
 * decoration: `createReadStream(path)` alone reads until the file says it is
 * over, so a picture replaced between the `statSync` above and this read would
 * put more bytes on the wire than `Content-Length` declared and leave the
 * connection out of step for whatever the client sent next. Measured on this
 * repository: with the unbounded form the connection stayed open for three
 * seconds after the last byte, which is how the difference was noticed at all —
 * it looked exactly like a slow server.
 */
function pipeRange(path: string, from: number, to: number, response: ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const file = createReadStream(path, { start: from, end: to });
    file.on('error', reject);
    response.on('close', () => file.destroy());
    file.pipe(response).on('finish', resolve).on('error', reject);
  });
}
