import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { biographyOf } from '../artist/nfo.ts';
import type { DatabaseSync } from '../db/index.ts';
import { decodeText } from '../text/encoding.ts';
import { ID, artistId3, artistImageUrlOf, confinedTo, parseId, required } from './browse.ts';
import { ApiError, ERROR } from './envelope.ts';
import { artist, artistByKey, artistNfoIn, artistOwnFolders, type ArtistRow } from './meta.ts';
import type { Payload } from './router.ts';
import { virtualEntries, virtualNodes } from './virtual.ts';

/**
 * What a client is told about an artist, beyond the records they made.
 *
 * The protocol asks this in `getArtistInfo2`, whose usual sources are last.fm
 * and MusicBrainz — services this server does not talk to, by design. What it
 * answers with instead is what the collection already holds: the note the
 * operator's library keeps in the folder named for the artist, the picture
 * `getCoverArt` already serves, and the other artists that folder gathers.
 *
 * `lastFmUrl` is left out because there is nothing to put there: no file in
 * this collection carries one, and a fabricated URL is a lie a client would
 * render as a link.
 *
 * `musicBrainzId` is a different case, and this comment said otherwise until a
 * review measured it. The id **is** on disk — in the same `artist.nfo` this
 * file already reads for the biography, under `<musicbrainzartistid>`, e.g.
 * `69ee3720-a7cb-4402-b48d-a02c366f2bcf` for The Cure. It is not returned
 * because nobody has built the reader, which is a gap to fill rather than an
 * impossibility to explain away. `elementText` in `src/artist/nfo.ts` reads it
 * with the same pass that reads the biography.
 */

/** The route a picture is asked for by, which is where the URLs below point. */
const COVER_ROUTE = '/rest/getCoverArt';

/** How many related artists the protocol offers when a client does not say. */
const DEFAULT_COUNT = 20;

export function getArtistInfo2(
  db: DatabaseSync,
  query: URLSearchParams,
  origin: string,
): Payload {
  const raw = required(query, 'id');
  const parsed = parseId(raw);
  if (parsed === undefined || parsed.kind !== 'ar') {
    throw new ApiError(ERROR.notFound, `No such id: ${raw}`);
  }

  const row = artist(db, parsed.n);
  if (row === undefined) throw new ApiError(ERROR.notFound, `No such id: ${raw}`);

  // The picture is the one `getCoverArt` already serves for this artist, named
  // as a URL because a URL is what the protocol asks for. One picture offered at
  // three sizes: this collection keeps one, and a server that answered with
  // three would be promising thumbnails it has never made. It is the same URL
  // `artistImageUrl` carries — `artistImageUrlOf` is where it is built once,
  // since two builders of one address is how two answers to one question start.
  const picture = artistImageUrlOf(row.id, origin);
  const biography = biographyOfArtist(db, row.id);
  const related = relatedArtists(db, row, confinedTo(db, query), origin).slice(0, countOf(query));

  return {
    artistInfo2: {
      ...(biography === null ? {} : { biography }),
      smallImageUrl: picture,
      mediumImageUrl: picture,
      largeImageUrl: picture,
      ...(related.length === 0 ? {} : { similarArtist: related }),
    },
  };
}

/** How many related artists to offer — the client's number, or the protocol's. */
function countOf(query: URLSearchParams): number {
  const asked = Number(query.get('count'));
  return Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : DEFAULT_COUNT;
}

/**
 * The note the collection keeps about an artist, or nothing.
 *
 * It lives in the folder named for them, so the folders are asked in the order
 * `artistOwnFolders` gives: the one spelled exactly like the artist first, the
 * shelves behind it only if it holds nothing.
 *
 * A note that cannot be read is passed over rather than thrown out of. A row
 * can outlive its file — a folder moved between scans would leave one — and an
 * artist with no readable note is an artist with no note, not a failed request.
 * An earlier version of this comment named a folder in this collection as such
 * a case; a review checked and all three `artist.nfo` rows have their file.
 *
 * `biographyOf` carries the same promise and used not to keep it: it threw on a
 * numeric entity naming no XML character, and the throw left this function
 * because only the read was guarded. Both halves are guarded now.
 */
function biographyOfArtist(db: DatabaseSync, artistId: number): string | null {
  for (const where of artistOwnFolders(db, artistId)) {
    const file = artistNfoIn(db, where);
    if (file === null) continue;

    let text: string;
    try {
      text = decodeText(readFileSync(join(file.rootPath, file.relPath))).text;
    } catch {
      continue;
    }

    const biography = biographyOf(text);
    if (biography !== null) return biography;
  }

  return null;
}

/**
 * The other artists this artist's folder gathers.
 *
 * Exactly the list that folder shows as drawers, and for the same reason: where
 * a node credits more than one name, each of those names is somebody the
 * collection knows, and the folder is where they are reachable from. That is
 * what makes them the answer to "who else is here" — the question a client
 * asking for similar artists is really asking, and the only version of it this
 * library can answer from what it holds.
 *
 * An artist who owns no folder has no gathering and no related artists. That is
 * not a claim that nobody resembles them; it is that the collection has nothing
 * to say, and an empty list says it.
 *
 * The artist itself is left out. The count beside each of the others is what this
 * drawer holds, which is not always what opening that artist would give. The two
 * agree on this collection — every name a drawer gathers has all of its records
 * in that drawer — and would part for an artist filed in two places. Counting
 * each of them the way their own page does would be a query per name, on a route
 * a client calls for every artist it draws; task:2838 records the difference.
 */
function relatedArtists(
  db: DatabaseSync,
  row: ArtistRow,
  rootId: number | undefined,
  origin: string,
): Payload[] {
  const node = virtualNodes(db, rootId).find((one) => one.artistKey === row.name_key);
  if (node === undefined) return [];

  const related: Payload[] = [];
  const seen = new Set<string>([row.name_key]);

  for (const entry of virtualEntries(db, node)) {
    const credit = entry.credit;
    if (credit === null || seen.has(credit.artistKey)) continue;
    seen.add(credit.artistKey);

    const artistRow = artistByKey(db, credit.artistKey);
    if (artistRow === undefined) continue;

    related.push(artistId3({ ...artistRow, album_count: credit.records.length }, origin));
  }

  return related;
}
