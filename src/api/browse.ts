import { discSubtitle, folderNote, unsaidNote } from '../classify/folder-name.ts';
import type { DatabaseSync } from '../db/index.ts';
import { ApiError, ERROR } from './envelope.ts';
import {
  LIBRARY,
  virtualEntries,
  virtualNodes,
  libraryRecords,
  virtualRecordCounts,
  virtualRecords,
  type VirtualEntry,
  type VirtualNode,
} from './virtual.ts';
import {
  album,
  albumList,
  albumListByGenre,
  albumListByYear,
  albumsOfArtist,
  artist,
  artists,
  childFolders,
  discsOfAlbum,
  folder,
  randomSongs,
  root,
  roots,
  song,
  songsInFolder,
  songsOfAlbum,
  type AlbumOrder,
  type AlbumRow,
  type ArtistRow,
  type FolderRow,
  type RootRow,
  type SongRow,
} from './meta.ts';
import type { Visibility } from './visibility.ts';

/**
 * The library, in the protocol's shapes.
 *
 * Everything here is a translation and nothing here is a decision about the
 * collection: which albums exist, what they are called and what is on them was
 * settled by the scanner, and this file's whole job is to say it the way a
 * Subsonic client expects to hear it.
 *
 * The one thing it does decide is how a row is named to a client, and that is
 * deliberately opaque. Subsonic ids are never parsed by the client that holds
 * one — it only hands them back — so the id is free to be the meta layer's own
 * key, and a type prefix is what keeps two tables' ids from colliding in a
 * client's cache.
 */

type Payload = Record<string, unknown>;

export const ID = {
  artist: (id: number): string => `ar-${id}`,
  album: (id: number): string => `al-${id}`,
  track: (id: number): string => `tr-${id}`,
  folder: (id: number): string => `fd-${id}`,
  root: (id: number): string => `ro-${id}`,
  /**
   * The virtual nodes and the top above them.
   *
   * The payload is a fold key — an artist's name, folded — so this is the one
   * id kind that is not a number, and it is read before `parseId` rather than
   * by it. Keys carry no `:`: `foldName` keeps letters, digits and combining
   * marks and turns everything else into a space.
   */
  virtualPrefix: 'vn:',
  virtual: (key: string): string => `vn:${key}`,
  /** The virtual top itself, which is the prefix with no key after it. */
  library: 'vn:',
  /** The protocol's own name for the top of the tree. */
  top: '-1',
  /**
   * A playlist, which is not part of the tree at all.
   *
   * Named here because it is an id this API hands a client and takes back, so
   * it is spelled the way every other one is — while `KINDS` below stays the
   * tree's own set: `parseId` refusing `pl:` is what makes `getSong` answer
   * "no such id" about a playlist, which is true.
   */
  playlist: (id: number): string => `pl-${id}`,
} as const;

type IdKind = 'ar' | 'al' | 'tr' | 'fd' | 'ro';

const KINDS: ReadonlySet<string> = new Set(['ar', 'al', 'tr', 'fd', 'ro']);

/**
 * The row an id names, or nothing.
 *
 * A wrong kind is the same as no row at all: a client that asked for `al:`+a
 * track id is not asking a question the server can answer, and saying "not
 * found" is truer than answering about a track.
 */
export function parseId(raw: string): { kind: IdKind; n: number } | undefined {
  // **Both separators are read, and only one is written.** The hyphen is what
  // this API hands out; the colon is what it handed out before, and a client
  // holding one of those reads the same row it always did rather than a
  // not-found.
  //
  // The change is not cosmetic. The specification says an id is an opaque
  // string, and a client is entitled to assume otherwise — one does: Castafiore
  // builds its stream URL only when the id matches `[a-zA-Z0-9-]`, and answers
  // with **the id itself** when it does not, so `tr:112384` became the URL the
  // player was told to fetch and nothing ever reached this server (task:2896).
  // The kind is still named with a hyphen; it just stops being a character that
  // a client may read as something else.
  const at = raw.search(/[-:]/);
  if (at === -1) return undefined;

  const kind = raw.slice(0, at);
  if (!KINDS.has(kind)) return undefined;

  const n = Number(raw.slice(at + 1));
  return Number.isInteger(n) ? { kind: kind as IdKind, n } : undefined;
}

function idOf(query: URLSearchParams, kind: IdKind): number {
  const raw = required(query, 'id');
  const parsed = parseId(raw);
  if (parsed === undefined || parsed.kind !== kind) {
    throw new ApiError(ERROR.notFound, `No such id: ${raw}`);
  }
  return parsed.n;
}

/** The track an `id` names, for the one method that asks for a track by itself. */
export function trackId(query: URLSearchParams): number {
  return idOf(query, 'tr');
}

export function required(query: URLSearchParams, name: string): string {
  const value = query.get(name);
  if (value === null || value === '') {
    throw new ApiError(ERROR.missingParameter, `Required parameter is missing: ${name}`);
  }
  return value;
}

// Shaping --------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  // Not `audio/opus`. A `.opus` file is an Ogg stream carrying Opus, and RFC
  // 7845 §9 is explicit: "The RECOMMENDED mime-type for Ogg Opus files is
  // `audio/ogg`", with the `codecs` parameter (RFC 6381) as the way to say more
  // — `audio/ogg; codecs=opus`. `audio/opus` is RFC 7587's, and that one is the
  // RTP payload format, not a file in a container. Xiph's own table keeps
  // `.opus` under `audio/ogg` and reserves `audio/opus` for "Opus without
  // container", which is not a thing this server stores.
  //
  // It was `audio/opus`, and this server contradicted itself about it: its own
  // transcoding target for opus (`TARGETS` in `stream/segment.ts`) has said
  // `audio/ogg` all along. Found by being asked whether Opus was supported at
  // all, and then looking at what the two halves of the same answer said
  // (task:2920).
  opus: 'audio/ogg',
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
};

/** What a file of this kind is, so a client knows what it is about to receive. */
export function contentType(ext: string): string {
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * The protocol counts in whole seconds; the meta layer measured milliseconds.
 *
 * Read by everything that shows a length — an album, a song, and a playlist,
 * which is the sum of its songs' — so the rounding is stated once.
 */
export function seconds(ms: number | null): number {
  return ms === null ? 0 : Math.round(ms / 1000);
}

/**
 * The last folder of a path, whichever separator it is written with.
 *
 * Both, because the two arrive in the same answer: a folder's path is relative
 * and always uses forward slashes, while a root's is the absolute path the
 * operator configured and on Windows that is written with backslashes. Reading
 * only one of them named a root by its entire path.
 */
function lastSegment(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || path;
}

/** Where the file is, in the one spelling a path has on the wire. */
function pathOf(rootPath: string, relPath: string): string {
  return `${rootPath.replace(/\\/g, '/')}/${relPath}`;
}

/**
 * Where the *song* is, which for a song cut out of an image is not the same
 * question as where the file is.
 *
 * Every song of a cue-split record is cut from the one image, so all of them
 * named the image and a client with an offline cache read them as one song:
 * Symfonium's rule, in its author's words, is *"songs with the same file are
 * supposed to be the same song so they are not downloaded multiple times"* —
 * and it played the first track of a twelve-track record twelve times
 * (issue:100). The path is what it keys on, so the path has to be the song's.
 *
 * The image's own path stays in it, because that is the file the bytes come
 * from and the one place a person can find them; the cut number is what makes
 * it this song's. The number is the track's `ordinal`, which the schema keys
 * `UNIQUE (album_id, ordinal)` on and no rescan moves, so two songs of one
 * image can never be handed the same path — and the extension stays last,
 * because a client reading it to decide what the file is reads the end.
 *
 * A whole file is its own answer, unchanged.
 */
function songPathOf(row: SongRow): string {
  const path = pathOf(row.root_path, row.rel_path);
  if (row.segment_start_ms === null) return path;

  const dot = path.lastIndexOf('.');
  const cut = dot > Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) ? dot : path.length;

  return `${path.slice(0, cut)} (track ${row.ordinal})${path.slice(cut)}`;
}

/**
 * What a song with no name is called on the wire.
 *
 * The meta layer keeps null there on purpose — a cue that says `(empty)` has
 * stated that this division of the disc has no name, and the projection leaves
 * it unnamed rather than dressing the hole up (with an issue filed saying how
 * many it left). The protocol has no way to say "no name", and a client does not
 * read an empty title as an absence: Symfonium fails a whole sync over one song
 * without a title. So the API says the same word the dump says, and a track the
 * collection never named is shown as one.
 */
const UNNAMED = '(untitled)';

/**
 * The id `getCoverArt` is asked with, for a song.
 *
 * A song's art is its record's, and a song on no record answers for itself. It
 * is read for every listing that shows a song — the folder, the album, the
 * search.
 *
 * Named apart from `coverOf` below, which answers the same question about a
 * *node* of the tree: two kinds of subject, and an id that says which.
 */
function songCoverOf(row: SongRow): string {
  return row.album_id === null ? ID.track(row.id) : ID.album(row.album_id);
}

/**
 * The `Child` a song is, with the parent it sits under.
 *
 * The parent is the record, or the top of the tree for a song whose file sits in
 * no record at all. Written once because every listing that answers with songs
 * needs it — the starred listings, the history's now-playing and queue, the
 * bookmarks — and the expression it hides is the one that has to agree with
 * `ID.album` everywhere or a client is drawn a parent it cannot ask about.
 */
export function childOf(row: SongRow): Payload {
  return songChild(row, row.album_id === null ? ID.top : ID.album(row.album_id));
}

/** 1, per the specification's `ITUNESADVISORY` line. */
const EXPLICIT_ITUNES: readonly number[] = [1];

/** 1 or 4, per its `rtng` line — where 4 is explicit and in the other tag means nothing. */
const EXPLICIT_RTNG: readonly number[] = [1, 4];

/** The rating one numbering names: `explicit` is what it lists, `clean` is 2. */
function ratingOf(value: number, explicit: readonly number[]): string {
  if (!Number.isInteger(value)) return '';
  if (explicit.includes(value)) return 'explicit';
  return value === 2 ? 'clean' : '';
}

/**
 * What the tags say about a song's content rating, in the protocol's words.
 *
 * Two tags and **two numberings**, and the specification names both: "For songs
 * extracted from tags ITUNESADVISORY: 1 = explicit, 2 = clean, MP4 rtng: 1 or 4
 * = explicit, 2 = clean". They are not one numbering — `4` is explicit in one
 * and means nothing in the other — so which tag a value came from is part of
 * what it says, and the two arrive here separately for that reason.
 *
 * `""` when neither says anything, which is the protocol's own third value for
 * this field and not an absence: it is the answer a client is owed for a
 * collection nobody has rated, and this one is exactly that — not one
 * `itunesadvisory` and not one `rtng` in any of its `file_tag` rows, measured.
 */
export function explicitStatusOf(itunes: string | null, mp4: string | null): string {
  if (itunes !== null) return ratingOf(Number(itunes), EXPLICIT_ITUNES);
  if (mp4 !== null) return ratingOf(Number(mp4), EXPLICIT_RTNG);
  return '';
}

/**
 * The `size` field of a `Child`, which is the length of the *song*.
 *
 * For a whole file the song and the file are the same thing, and this is the
 * file's own length. For a song cut out of an image they are not, and this used
 * to answer with the image's: 465 MB for a six-minute song, where 1789 of this
 * collection's tracks are cut from images. A client that sizes a download, or
 * decides by size whether it will stream something at all, was being told a
 * number two orders of magnitude wrong — the operator found it bringing clients
 * up against the server.
 *
 * **The exact length of a cut is a number nothing holds.** It comes out of
 * walking the image's frames, which no listing may do — that walk is the one
 * `task:2897` had to take off the request thread, and doing it per song in an
 * album listing would be a thousand times worse. What the row *does* hold is
 * enough to estimate it: the file's bitrate, which is the encoding the track is
 * cut from and so the same bytes per second, and the track's own length.
 * Measured against real cuts of this collection — Whole Lotta Love out of a
 * 510 MB image, and `tr-858` out of the 486 MB Breakstorm image — the estimate
 * lands **68 334 081 against 68 863 475 bytes (0.8% low)** and **42 637 432
 * against 37 735 326 bytes (13% high)**, the difference being the header the
 * cut rebuilds, the frame headers it adds, and how far the track's own frames
 * sit from the image's average bitrate. So it is an estimate with a spread of
 * roughly this shape, not a length, and clients are told one deliberately: a
 * client that preloads by size is owed *a* budget, and the exact total is on
 * the answer itself (`Content-Range` of `stream`), which is where a player
 * that needs the number reads it. Dropping the field instead was the other
 * option (issue:100, п.3) and was turned down — `size` absent surprises more
 * clients than `size` 13% high, and `Req. No` only means a client may not
 * insist.
 *
 * Where the bitrate was never measured there is no estimate to make, and the
 * field is left out rather than filled with the image's size again: `size` is
 * `Req. No`, and a wrong number is worse than none — the rule the rest of this
 * API already follows for a bitrate nobody measured.
 */
function sizeOf(row: SongRow): Payload {
  if (row.segment_start_ms === null) return { size: row.size };
  if (row.bitrate === null || row.duration_ms === null) return {};

  return { size: Math.round((row.bitrate * row.duration_ms) / 8000) };
}

/**
 * A gain, as a file writes it — `-7.66 dB` — or nothing.
 *
 * The unit is in the string and not in the number, and it is always decibels:
 * the tag names the unit because a tag is a line of text a person may read.
 * OpenSubsonic's field is a number in dB, so the suffix is dropped rather than
 * carried — and a value this cannot read is *nothing*, not nought, because a
 * gain of zero means "leave the loudness alone" and that is a real thing to say.
 */
function decibels(value: string | null): number | undefined {
  if (value === null) return undefined;
  const written = value.trim().replace(/\s*dB$/i, '').trim();
  // **The emptiness check is the whole of the rule above.** `Number('')` is `0`,
  // and `0` is finite — so a tag holding nothing but its unit (`' dB'`) would
  // have arrived as "leave the loudness alone", which is the one answer this
  // function exists to avoid giving (found by the review umbrella, task:2926).
  if (written === '') return undefined;
  const parsed = Number(written);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A peak, which a file writes bare — `0.388123` — and the specification
 * requires not to be negative.
 *
 * A negative peak is not a quiet song, it is a value that cannot be one; it is
 * left out rather than sent, since a client that scaled by it would invert the
 * audio.
 */
function peak(value: string | null): number | undefined {
  if (value === null) return undefined;
  const written = value.trim();
  // Same trap as `decibels`: `Number('')` is `0`, and a peak of nought is a
  // value a client would scale by rather than an absence.
  if (written === '') return undefined;
  const parsed = Number(written);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The song's ReplayGain data, in the shape OpenSubsonic gives it.
 *
 * **Always an object, even when it is empty.** The specification's own note
 * settles the apparent contradiction in its schema — "If the data is not present
 * the field must be omitted in the answer. (But the `replayGain` field on
 * [`Child`] must always be present)" — so what is left out is a *property*, and
 * the field a client checks for is always there.
 *
 * `baseGain` is not here because nothing reads one: it is Opus's output gain,
 * and `tags/ogg.ts` takes the pre-skip out of `OpusHead` and stops before it.
 * `fallbackGain` is a client's or an operator's setting, and this server has no
 * opinion to state as one.
 *
 * **This is why the tags stopped being invisible.** They were read, stored, and
 * never handed to anybody: 74 files of this collection carry a track gain, and
 * the ReplayGain presets in Symfonium had nothing behind them (task:2921).
 */
export function replayGainOf(row: SongRow): Payload {
  const trackGain = decibels(row.rg_track_gain);
  const albumGain = decibels(row.rg_album_gain);
  const trackPeak = peak(row.rg_track_peak);
  const albumPeak = peak(row.rg_album_peak);

  return {
    ...(trackGain === undefined ? {} : { trackGain }),
    ...(albumGain === undefined ? {} : { albumGain }),
    ...(trackPeak === undefined ? {} : { trackPeak }),
    ...(albumPeak === undefined ? {} : { albumPeak }),
  };
}

export function songChild(row: SongRow, parent: string): Payload {
  return {
    id: ID.track(row.id),
    parent,
    isDir: false,
    title: row.title ?? UNNAMED,
    // The id to ask `getCoverArt` for — see `songCoverOf`. A client that is not
    // told which id to ask with draws a placeholder, which is how the whole
    // library looked until this was here.
    coverArt: songCoverOf(row),
    album: row.album_title ?? '',
    // The song's own artist — its file's tag — and the record's only when the
    // file states none.
    //
    // This was the other way round, and the argument for it was that preferring
    // the file's "would replace a band with whoever guested on one track". True,
    // and the answer is the field below: a band is named in `albumArtist`, which
    // is the record's own field in this protocol. The order that was here made
    // `artist` answer for the *record*, and it was wrong for 1492 songs in 113
    // records — every compilation and every split. Measured on `al:128`:
    // `Round Midnight` is by Duran Y Garcia and the answer was `Various
    // Artists`; on a split both halves were named after whichever act the
    // record was filed under (task:2850).
    artist: row.track_artist ?? row.artist_name ?? '',
    // The record's artist, which is what a client draws beside the album rather
    // than beside the track. Sent even when it equals `artist`, because that is
    // the ordinary case and a client that wants the record's name should not
    // have to guess whether its absence means anything.
    ...(row.artist_name === null ? {} : { albumArtist: row.artist_name }),
    // The song's own genre, which is its file's — see `SongRow.genre`. Absent
    // rather than empty when the file states none: a client that is handed
    // `genre: ""` has a genre whose name is nothing, and one that is handed no
    // genre at all has a song whose genre nobody wrote.
    ...(row.genre === null ? {} : { genre: row.genre }),
    // Always sent, unlike the genre above, because the protocol gives this field
    // a third value and it is the empty string: a client is owed "nobody rated
    // this" rather than a field whose absence it has to interpret.
    explicitStatus: explicitStatusOf(row.advisory_itunes, row.advisory_mp4),
    track: row.ordinal,
    ...(row.album_id === null ? {} : { albumId: ID.album(row.album_id) }),
    ...(row.artist_id === null ? {} : { artistId: ID.artist(row.artist_id) }),
    ...(row.disc_number === null ? {} : { discNumber: row.disc_number }),
    // The record's year, not the song's: a song is as old as the record it is
    // on, and the meta layer keeps no date per track.
    ...(row.album_year === null ? {} : { year: row.album_year }),
    // The size of the *song*, which for a song cut out of an image is that
    // song's share of it rather than the image. See `sizeOf`.
    ...sizeOf(row),
    // What the file actually is, which the protocol puts on every `Child` and
    // this server left out entirely: a client deciding whether it can play
    // something needs more than the codec's name, and `stream`'s own
    // `maxBitRate` cannot obey a ceiling without knowing what the file is at.
    // `bitRate` is kilobits per second, which is the protocol's unit, while the
    // probe measures bits — the same division `seconds` does for a duration.
    ...(row.bitrate === null ? {} : { bitRate: Math.round(row.bitrate / 1000) }),
    ...(row.sample_rate === null ? {} : { samplingRate: row.sample_rate }),
    ...(row.channels === null ? {} : { channelCount: row.channels }),
    duration: seconds(row.duration_ms),
    suffix: row.ext,
    contentType: contentType(row.ext),
    path: songPathOf(row),
    isVideo: false,
    type: 'music',
    // The listener's own marks on this song, absent when there are none.
    //
    // `starred` has no empty form — it is a date or it is nothing — and
    // `userRating: 0` is the protocol's own way of saying *there is no rating*
    // (`setRating` takes nought for exactly that). So a client handed a zero
    // would be drawn a rating nobody gave, and the two fields are left out
    // rather than sent empty.
    ...(row.starred_at === null ? {} : { starred: row.starred_at }),
    ...(row.rating === null ? {} : { userRating: row.rating }),
    // And what the listener's plays add up to. `playCount` is a count and is
    // sent as one: nought is a fact about a song nobody has played rather than
    // the absence of a fact, which is the difference between this and
    // `userRating` above — nought there is the protocol's spelling of "no
    // rating", and here it is the count. `played` is a date or it is nothing, so
    // it is left out rather than sent empty, the rule `starred` follows.
    playCount: row.play_count ?? 0,
    // What the file says its loudness is, so a client that normalises has
    // something to normalise by — always present, sometimes empty (task:2921).
    replayGain: replayGainOf(row),
    ...(row.played_at === null ? {} : { played: row.played_at }),
  };
}

/**
 * The name a record is shown by in the folder tree: the year it came out, then
 * its title.
 *
 * The tree is the only list that draws no `year` field, so its name is the only
 * place the year can be said. Everywhere else that field is on screen beside
 * the name, and a name carrying one says the same thing twice — see
 * `listedName` for those lists. The operator reported the duplicate in the
 * albums view and confirmed the other three draw the year themselves, which is
 * what moved the boundary to here.
 *
 * A record with no year says nothing rather than leading with a placeholder.
 * The year stays in the protocol's own field as well, and there it is not a
 * spare: for every list that is handed `listedName` instead, that field is the
 * only place the year is read from at all.
 *
 * The note the folder states goes in too, and in **the brackets the folder wrote
 * it in** — `1990 - Entreat [1991 issue AU Warner 903174106-2]` is what the
 * folder says, and square brackets are how this collection writes a pressing.
 * Outside the tree the same note is stated in round ones; that is `albumId3`,
 * which has done this since `a826eb0`. The tree was the reader left without it,
 * and a record whose title a tag or a cue wrote lost its pressing there
 * entirely — 180 of the 244 records whose folder states a note (task:2783).
 */
function named(row: AlbumRow): string {
  const title = row.title ?? '';
  // Said once — and `unsaidNote` is the only place that decides, because the
  // album list has to decide it the same way. A record its own folder named
  // carries the note inside its title already, and carries it in *round*
  // brackets with the pressing's year off, which is not how the folder wrote it.
  const folder = lastSegment(row.rel_path);
  const unsaid = unsaidNote(title, folder);
  const written = folderNote(folder);
  const withNote = unsaid === null || written === null ? title : `${title} ${written}`;
  return row.year === null ? withNote : `${row.year} - ${withNote}`;
}

/**
 * The name a record is shown by outside the folder tree: its title alone.
 *
 * Every list but the tree renders the protocol's `year` field, so the name does
 * not repeat it. That is the albums view, the artist page, the album page and
 * search — the operator found the year twice in the first and confirmed the
 * other three draw it themselves, which is what put the boundary at the tree.
 *
 * The year is still in the protocol's own field beside the name, and the
 * record's title is untouched either way.
 */
function listedName(row: AlbumRow): string {
  return row.title ?? '';
}

/** An album where the protocol asks for `AlbumID3` — by artist, or in a list. */
export function albumId3(row: AlbumRow): Payload {
  // What the name still has to say, asked once for every reader of a record's
  // name — see `unsaidNote`, which is where the comparison lives and why it is
  // of the note's words rather than of the folder's brackets.
  //
  // It used to be asked here alone, and asked of the brackets: `carried` was
  // `parseFolderName(title).format`, which cannot read a round bracket that does
  // not look like a format — so 18 records whose title carries a catalogue
  // number `recordTitle` had written came back as saying it, were told it again,
  // and read `Eponymous (EU Polydor 981 463-0) (EU Polydor 981 463-0)` in the
  // album list (task:2845).
  const unsaid = unsaidNote(row.title ?? '', lastSegment(row.rel_path));

  // The note goes in the name as well, and this is the half that was missing.
  // A record its own folder named keeps the note there already — `recordTitle`
  // reads the folder — but one a *tag* or a cue named had its title replaced, and
  // the note survived only as `version`, a field the client this library is read
  // in does not render. Measured: of 132 records whose folder states a note, 78
  // names did not carry it, and fourteen of one artist's records read identically
  // to a client because of it (task:2813, task:2814).
  //
  // `version` is still sent beside it. A client that renders the field is not made
  // worse by the name saying it too, and the alternative — the note in one place
  // only — is what produced this defect.
  const named = listedName(row);
  const name = unsaid === null ? named : `${named} (${unsaid})`;

  return {
    id: ID.album(row.id),
    name,
    // The record is what `getCoverArt` is asked about, and it answers with the
    // folder's picture — see `api/cover.ts` for which picture that is.
    coverArt: ID.album(row.id),
    artist: row.artist_name ?? '',
    ...(row.artist_id === null ? {} : { artistId: ID.artist(row.artist_id) }),
    songCount: row.song_count,
    duration: seconds(row.duration_ms),
    // A disc of a box carries the release's title like its siblings do, so this
    // number is the only thing on the answer that tells the two apart.
    ...(row.disc_number === null ? {} : { discNumber: row.disc_number }),
    // Which edition of the record this is, when its folder says something its
    // name does not.
    //
    // The protocol keeps `version` for exactly this — "Remastered, Anniversary
    // Box Set" — and this is where the note lives **only when no name carries
    // it**: a note nobody is shown is not worth taking out of a name, and the
    // client this library is read in does not render the field at all. So a
    // record named by its folder keeps the note in the name (`recordTitle`) and
    // is told once; what reaches this line is a record some *other* stage named
    // — a tag or a cue that wrote its own title, note already dropped.
    //
    // Read off the record's folder rather than stored, because it is the folder
    // that says it — the same string `recordTitle` reads its name from.
    //
    // Not said twice, and the answer is the same `unsaid` the name was built
    // from — so the field and the name cannot disagree about whether the record
    // has been told. The note's own year goes the way the name's did:
    // `2019, Maschina Records, MASHCD-099` dates the pressing, not the record.
    //
    // Two notes that differ are both shown, and that is not a repetition: a folder
    // stating `MKK891CD` beside a tag stating `MKM891CD` is two sources saying
    // different things, and dropping either would hide the disagreement.
    // Suppressing a differing note is not the act this line performs; suppressing
    // a repeated one is.
    ...(unsaid === null ? {} : { version: unsaid }),
    // A record with no year says nothing rather than saying 0: the protocol's
    // clients show the field when it is there, and a zero would be a year.
    ...(row.year === null ? {} : { year: row.year }),
    // Likewise, and for a stronger reason: a record whose files state no genre
    // has no genre, and `genre: ""` would name one.
    ...(row.genre === null ? {} : { genre: row.genre }),
    // The listener's marks, on the record rather than on any of its songs — see
    // `songChild` for why they are absent rather than empty.
    ...(row.starred_at === null ? {} : { starred: row.starred_at }),
    ...(row.rating === null ? {} : { userRating: row.rating }),
  };
}

/** An album where the protocol asks for a `Child` — in a directory listing. */
export function albumChild(row: AlbumRow, parent: string): Payload {
  return {
    id: ID.album(row.id),
    parent,
    isDir: true,
    title: named(row),
    artist: row.artist_name ?? '',
    coverArt: ID.album(row.id),
    songCount: row.song_count,
    duration: seconds(row.duration_ms),
    ...(row.disc_number === null ? {} : { discNumber: row.disc_number }),
    ...(row.year === null ? {} : { year: row.year }),
    ...(row.genre === null ? {} : { genre: row.genre }),
    // The listener's marks. A record is shown as a `Child` in the folder tree,
    // in an artist's page and in the v1 starred listing, and one carried only
    // by the ID3 shape would be a star that disappears when a client browses
    // the other way.
    ...(row.starred_at === null ? {} : { starred: row.starred_at }),
    ...(row.rating === null ? {} : { userRating: row.rating }),
  };
}

/**
 * Where a client fetches an artist's picture.
 *
 * The OpenSubsonic field `artistImageUrl` asks for "an url to an external image
 * source". This server has no external provider, and the picture it has is the
 * one `getCoverArt` already answers with for the artist's id — so that is what
 * the field names, as a URL because a URL is what the field is. Built from the
 * authority the request arrived by rather than from the config: a deployed
 * server binds `0.0.0.0`, which is not an address anyone can call back.
 *
 * One field is offered whether or not there is a picture to fetch, which is what
 * `coverArt` beside it has always done — ten of this collection's forty-eight
 * artists have no picture in any of their folders, and the client is the one
 * that finds that out by asking.
 */
export function artistImageUrlOf(id: number, origin: string): string {
  return `${origin}/rest/getCoverArt?id=${encodeURIComponent(ID.artist(id))}`;
}

export function artistId3(row: ArtistRow, origin: string): Payload {
  return {
    id: ID.artist(row.id),
    name: row.name,
    albumCount: row.album_count,
    ...(row.starred_at === null ? {} : { starred: row.starred_at }),
    ...(row.rating === null ? {} : { userRating: row.rating }),
    // An artist has no picture of its own, and `getCoverArt` answers for one
    // with the best picture among all its records — a client showing an artist
    // in a list wants a picture, and which record supplied it is not its
    // business. See `api/cover.ts`.
    coverArt: ID.artist(row.id),
    // And the same picture again as a URL, under the field OpenSubsonic added
    // for clients that want an artist image rather than a cover: one is an id
    // to ask with, the other is an address to load. Reported missing from the
    // operator's Symfonium, which reads this field and finds nothing there.
    artistImageUrl: artistImageUrlOf(row.id, origin),
    // What this artist is in the library — `albumartist`, `artist`. A client
    // buckets its views by this field, and one of them came up empty for want of
    // it; see `rolesOf` for which roles this server will and will not claim.
    ...(row.roles.length === 0 ? {} : { roles: row.roles }),
  };
}

/**
 * One entry of a virtual node: a shelf the collector filed, or a record.
 *
 * A record's entry leads with its year, and the entry alone — the record keeps
 * the name the scanner settled on and `getAlbum` still answers with it. What a
 * client is shown here is the shape the operator asked for, `Год - Альбом`, and
 * a client drawing a list of entries is not obliged to render the year field
 * beside it.
 */
export function entryChild(entry: VirtualEntry, parent: string, nodeKey: string): Payload {
  if (entry.record !== null) return albumChild(entry.record, parent);

  // A drawer of one credited artist's records. Its id is the node's key and the
  // artist's, because `vn:кино` already names the node itself and a node whose
  // own name is credited to itself would otherwise collide with its drawer.
  // Fold keys carry no `|` — `foldName` turns every separator into a space.
  //
  // The picture is the credit's *artist id*, not the drawer's own — the same id
  // `getArtistInfo2` hands a client as a related artist, so one person is shown
  // the same picture wherever the server names them. A drawer with no picture at
  // all was the one place that differed, and a client cannot tell an artist the
  // server has nothing for from one it simply forgot (task:2847).
  if (entry.credit !== null) {
    return {
      id: ID.virtual(`${nodeKey}|${entry.credit.artistKey}`),
      parent,
      isDir: true,
      title: entry.credit.name,
      coverArt: ID.artist(entry.credit.artistId),
    };
  }

  const folder = entry.folder;
  if (folder === null) throw new ApiError(ERROR.generic, 'An entry that is none of the three');
  return folderChild(folder, parent);
}

export function folderChild(row: FolderRow, parent: string): Payload {
  return { id: ID.folder(row.id), parent, isDir: true, title: lastSegment(row.rel_path) };
}

/** The virtual top, which a client sees beside the roots it was told to scan. */
export function libraryChild(): Payload {
  return { id: ID.library, parent: ID.top, isDir: true, title: LIBRARY };
}

/**
 * A node of the virtual top.
 *
 * An artist's node and a folder that is nobody's are the same shape to a client
 * — a directory it can open — but they are not the same id. The artist's is a
 * `vn:` key, because what it holds is gathered from folders that may sit in
 * several roots and no one folder stands for it. A series or a shelf keeps its
 * own `fd:` and opens exactly as it always did.
 */
export function virtualChild(node: VirtualNode, parent: string): Payload {
  return {
    id: node.artistKey === null ? ID.folder(node.folderId) : ID.virtual(node.artistKey),
    parent,
    isDir: true,
    title: node.name,
  };
}

export function rootChild(row: RootRow): Payload {
  return {
    id: ID.root(row.id),
    parent: ID.top,
    isDir: true,
    title: row.alias ?? lastSegment(row.path),
  };
}

// Routes ---------------------------------------------------------------------

/**
 * The articles the server moved to file an artist — `The Cure` under C.
 *
 * Sent with the answer because the client is the one arranging what it was
 * given: a client that did not know the server had ignored `The` would file
 * everything else on its own rules and the two would disagree. Only `The`, and
 * only because that is what the meta layer actually drops (`src/artist/name.ts`).
 */
const IGNORED_ARTICLES = 'The';

/**
 * The root a client confined its request to, or nothing when it confined none.
 *
 * The id is the one `getMusicFolders` gave out, and a client is emphatic about
 * using the ids it was given rather than inventing them — which is why an id
 * naming no root is refused rather than ignored: answering with the whole
 * library would answer a question about some other music.
 *
 * Every browsing endpoint takes this. Feishin offers the choice and passes it on
 * `getIndexes`, `getArtists`, `getAlbumList2`, `getMusicDirectory` and
 * `search3`, and a server that ignored it answered "everything" to a question
 * about one folder — which is what the operator found when they picked one.
 */
export function confinedTo(db: DatabaseSync, query: URLSearchParams): number | undefined {
  const raw = query.get('musicFolderId');
  if (raw === null || raw === '') return undefined;

  // The library is one of the choices this server offers, and choosing it means
  // the whole library, which is what confining nothing means. A client is
  // emphatic about using the ids it was given, and refusing one of ours is the
  // defect rather than the request: the operator picked `Музыка` in the client
  // and the server answered `No such music folder: vn:`.
  //
  // It is `getIndexes` that offers it, as the `child` the tree opens on — not
  // `getMusicFolders`, which answers with the roots and nothing else. An
  // earlier version of this comment said the opposite, and the function below
  // it said so too.
  if (raw === ID.library) return undefined;

  const parsed = parseId(raw);
  if (parsed === undefined || parsed.kind !== 'ro') {
    throw new ApiError(ERROR.notFound, `No such music folder: ${raw}`);
  }
  if (root(db, parsed.n) === undefined) {
    throw new ApiError(ERROR.notFound, `No such music folder: ${raw}`);
  }
  return parsed.n;
}

/** The letter an artist is browsed under. Anything that is not a word lands on `#`. */
function indexLetter(sortName: string): string {
  const first = [...sortName][0];
  return first !== undefined && /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : '#';
}

export function getIndexes(
  db: DatabaseSync,
  query: URLSearchParams,
  visibility: Visibility = 'records',
): Payload {
  const rootId = confinedTo(db, query);
  return {
    indexes: {
      ignoredArticles: IGNORED_ARTICLES,
      index: folderIndex(db, rootId, visibility),
      // The library, then the roots as they were configured. A client that
      // builds its folder tree from here — and this one does — saw only the
      // roots, so the virtual top was reachable through `getMusicDirectory(-1)`
      // and nowhere it looked. `getMusicFolders` below answers the same list,
      // because the two are read as one question.
      child: [
        libraryChild(),
        ...roots(db)
          .filter((row) => rootId === undefined || row.id === rootId)
          .map(rootChild),
      ],
    },
  };
}

/**
 * The music folders, which for this server are the roots it was told to scan.
 *
 * A client with more than one library to connect to — a phone that switches
 * between servers, a household with two collections — asks this before it asks
 * anything else, and it is emphatic about one thing: it uses the ids it is given
 * and does not invent them. So an id that is not offered here is an id that
 * cannot be sent back, and a server that answers this with nothing has no way to
 * be told which library is meant.
 *
 * The id is the same one `getIndexes` gives the same root, because they are the
 * same folder seen from two ends: one lists it to browse into, this one lists it
 * to choose between.
 */
/**
 * The folders on disk a client may choose between.
 *
 * The roots the scanner was given, and nothing else. The library is a *view* of
 * the collection rather than a folder in it, and offering it here is a claim
 * about the disk that is not true — the operator picked it and said so: "такой
 * папки же у нас нет". `getIndexes` still offers it, because that is a question
 * about what to browse, and `confinedTo` accepts it, because an id this server
 * has handed out is one it must not then refuse.
 */
export function getMusicFolders(db: DatabaseSync): Payload {
  return {
    musicFolders: {
      musicFolder: roots(db).map((row) => ({
        id: ID.root(row.id),
        name: row.alias ?? lastSegment(row.path),
      })),
    },
  };
}

/**
 * The artists, in the protocol's ID3 shape.
 *
 * `getIndexes` and this are the same list read two ways — the protocol grew
 * `getArtists` when it moved from browsing folders to browsing tags — and a
 * client is free to prefer either. The difference is that this one carries no
 * folders: an artist is an artist, and the directory a record sits in is not a
 * thing this server asks clients to care about.
 */
export function getArtists(
  db: DatabaseSync,
  query: URLSearchParams,
  visibility: Visibility,
  origin: string,
): Payload {
  const rootId = confinedTo(db, query);
  return {
    artists: {
      ignoredArticles: IGNORED_ARTICLES,
      index: indexGroups(db, rootId, visibility, origin),
    },
  };
}

/**
 * The library's top, grouped by the letter it files under.
 *
 * This is `getIndexes`'s `index`, and the client this library is read in draws
 * its *Folders* view from exactly this field — a table of whatever is here,
 * seventeen rows of artists, with TITLE/ALBUM/GENRE/YEAR columns. It never
 * walks `getMusicDirectory`, so anything not in this list cannot be reached in
 * that view at all, and the operator's series — `VA - Saint-Germain-des-Pres
 * Cafe (2001-2015) [AAC]`, `Серия «Подлинная история отечественной легкой
 * музыки»` — were unreachable however the tree was shaped.
 *
 * So the whole top is offered here, series and folders included, and not only
 * the artists. `getArtists` below keeps answering with artists alone: the two
 * are different questions, and a client that wants the tag-based artist list
 * asks the other one.
 *
 * An artist keeps its `ar:` id, so a client that follows it lands on the artist
 * page it always did; a series keeps its `fd:` and opens as a folder.
 */
function folderIndex(
  db: DatabaseSync,
  rootId?: number,
  visibility: Visibility = 'records',
): Payload[] {
  const groups = new Map<string, Payload[]>();
  const nodes = virtualNodes(db, rootId, visibility);

  for (const node of nodes) {
    const letter = indexLetter(node.sort);
    // The id is the node's own, the one `getMusicDirectory(vn:)` answers to,
    // and the count is of what that answer holds. An `ar:` here would promise
    // the artist page's count and open the artist page — `Cock E.S.P.` holds
    // twenty-four records in its folder and thirteen carry its credit, and a
    // row saying one number and opening the other is the defect this project
    // keeps finding. The artist is still whose *name* it is; only the count and
    // the drill-down come from the folder.
    const id = node.artistKey === null ? ID.folder(node.folderId) : ID.virtual(node.artistKey);
    const entry: Payload = {
      id,
      name: node.name,
      // Counted, not gathered. The number is the whole of what this row shows,
      // and reading the records to take their length cost most of a second
      // across twenty-five nodes, at roughly thirty milliseconds each — the
      // count is asked of a query that does not have to build the records to
      // answer, and the node carries it (`VirtualNode.records`).
      albumCount: node.records,
      // The artist's own picture where there is an artist; a folder's otherwise,
      // which `getCoverArt` answers for the same way.
      coverArt: node.artistId === null ? id : ID.artist(node.artistId),
    };

    const bucket = groups.get(letter);
    if (bucket === undefined) groups.set(letter, [entry]);
    else bucket.push(entry);
  }

  return [...groups].map(([name, artist]) => ({ name, artist }));
}

/** The artists grouped by the letter they are filed under, in the order built. */
function indexGroups(
  db: DatabaseSync,
  rootId: number | undefined,
  visibility: Visibility,
  origin: string,
): Payload[] {
  const groups = new Map<string, Payload[]>();
  const held = nodeCounts(db, rootId, visibility);
  for (const row of artists(db, rootId, visibility)) {
    const owned = held.get(row.name_key);
    const letter = indexLetter(row.sort_key ?? row.name);
    // Where the artist owns a folder, the folder's number is the one shown, for
    // the reason `folderIndex` gives above: the row is a promise about the page
    // behind it, and this is the page `getArtist` will answer with. The two read
    // the same field, so leaving this to the tag's count parted them on 7 of the
    // collection's 21 artists — and all seven the same way round, because the
    // direction is not a coin toss: a folder can hold more than its own artist's
    // records and never fewer. `Кино` read as 31 and opened to 36, its folder
    // holding five records of Виктор Цой, and every other one undercounted too.
    //
    // The other direction is real, and lives in the fixture rather than in the
    // collection: a record credited to one artist and filed on another's shelf.
    // It is where the test below gets its second half, and the only place this
    // was ever observed — worth saying, because a comment that hands the reader
    // a live example it cannot find is the defect this file keeps collecting.
    const entry = artistId3(owned === undefined ? row : { ...row, album_count: owned }, origin);
    const bucket = groups.get(letter);
    if (bucket === undefined) groups.set(letter, [entry]);
    else bucket.push(entry);
  }
  return [...groups].map(([name, artist]) => ({ name, artist }));
}

/**
 * What each artist's node holds, by the artist's `name_key`.
 *
 * Only artists the folders named appear. One the tree has no node for is
 * answered for by their credit, which `artists` has already counted, and
 * `getArtist` falls back to the same count — the two have to part ways nowhere.
 * Four of the collection's twenty-one take that branch, so it is not a corner,
 * and the test below pins one of them rather than trusting that the two counts
 * agree by construction.
 *
 * The first node wins a key, mirroring `nodeOf`, which finds the first node of a
 * key as well — so a count and the page behind it cannot pick a different node
 * for the same artist.
 *
 * Counted rather than gathered: `virtualRecordCounts` asks the question of a
 * query that does not have to build the records to answer — the shape that took
 * `getIndexes` off `virtualRecords` and out of the hundreds of milliseconds
 * ([[task:2825]]). What it costs here is that same walk, once per call instead of
 * once per artist, and it is the walk `getIndexes` already pays on every client
 * sync.
 */
function nodeCounts(
  db: DatabaseSync,
  rootId?: number,
  visibility: Visibility = 'records',
): Map<string, number> {
  const byKey = new Map<string, number>();
  for (const node of virtualNodes(db, rootId, visibility)) {
    if (node.artistKey === null || byKey.has(node.artistKey)) continue;
    byKey.set(node.artistKey, node.records);
  }
  return byKey;
}

/**
 * What an id is, and what is on it — in the protocol's `ArtistID3` shape.
 *
 * Three kinds of id reach here and all three answer the same question. An `ar:`
 * is an artist by tag; a `vn:` is a node of the library and an `fd:` a folder
 * that belongs to no artist. A client that read its ids out of `getIndexes`
 * will ask about the last two, and refusing them refuses an id this server
 * handed out — which is the defect the operator hit twice in one day.
 *
 * Where an artist owns a folder, the folder answers: see `nodeOf`.
 */
export function getArtist(
  db: DatabaseSync,
  query: URLSearchParams,
  visibility: Visibility,
  origin: string,
): Payload {
  const raw = required(query, 'id');
  const rootId = confinedTo(db, query);

  if (raw.startsWith(ID.virtualPrefix)) {
    const key = raw.slice(ID.virtualPrefix.length);

    if (key === '') {
      return {
        artist: described(ID.library, LIBRARY, ID.library, libraryRecords(db, rootId, visibility)),
      };
    }

    const node = nodeOf(db, key, rootId, visibility);
    if (node === undefined) throw new ApiError(ERROR.notFound, `No such id: ${raw}`);
    const id = ID.virtual(key);
    return {
      artist: described(id, node.name, coverOf(node), virtualRecords(db, node, visibility)),
    };
  }

  const parsed = parseId(raw);
  if (parsed === undefined) throw new ApiError(ERROR.notFound, `No such id: ${raw}`);

  if (parsed.kind === 'fd') {
    const node = virtualNodes(db, rootId, visibility).find(
      (one) => one.artistKey === null && one.folderId === parsed.n,
    );
    if (node === undefined) throw new ApiError(ERROR.notFound, `No such id: ${raw}`);
    return { artist: described(raw, node.name, raw, virtualRecords(db, node, visibility)) };
  }

  if (parsed.kind !== 'ar') throw new ApiError(ERROR.notFound, `No such id: ${raw}`);

  const row = artist(db, parsed.n);
  if (row === undefined) throw new ApiError(ERROR.notFound, `No such id: ${raw}`);

  const node = nodeOf(db, row.name_key, rootId, visibility);
  const records =
    node === undefined
      ? albumsOfArtist(db, row.id, rootId, visibility)
      : virtualRecords(db, node, visibility);
  return {
    artist: {
      ...artistId3({ ...row, album_count: records.length }, origin),
      album: records.map(albumId3),
    },
  };
}

/** The node a library key names, when the library holds one. */
function nodeOf(
  db: DatabaseSync,
  key: string,
  rootId?: number,
  visibility: Visibility = 'records',
): VirtualNode | undefined {
  return virtualNodes(db, rootId, visibility).find((one) => one.artistKey === key);
}

/** The picture an artist's own id answers for; a folder's answers for itself. */
function coverOf(node: VirtualNode): string {
  return node.artistId === null ? ID.folder(node.folderId) : ID.artist(node.artistId);
}

function described(id: string, name: string, coverArt: string, records: AlbumRow[]): Payload {
  return { id, name, albumCount: records.length, coverArt, album: records.map(albumId3) };
}

export function getAlbum(db: DatabaseSync, query: URLSearchParams): Payload {
  const id = idOf(query, 'al');
  const row = album(db, id);
  if (row === undefined) throw new ApiError(ERROR.notFound, `No such album: ${id}`);

  // The record's own id, not the one that was asked with: a box answers the same
  // whether it was opened by its first disc or its second, and a `parent` that
  // echoed the question would make the two answers differ in a field nothing
  // asked about.
  const record = ID.album(row.id);

  // What each disc of the record calls itself, for the protocol's `discTitles`:
  // `CD2 ● Ранний вариант` is a disc that is more than its number. Only discs
  // whose name says something are reported — the field exists so a client can
  // label a disc, and a label of nothing is not one.
  //
  // Answered here and not in a listing: a list shows records, not their discs,
  // and asking per row is the query-per-result shape that made a search page
  // take two seconds.
  const discTitles = discsOfAlbum(db, id)
    .flatMap((disc) => {
      const title = discSubtitle(disc.title ?? '');
      // A disc whose name repeats the record's says nothing about the disc.
      return title === null || title === row.title ? [] : [{ disc: disc.disc, title }];
    });

  return {
    album: {
      ...albumId3(row),
      ...(discTitles.length === 0 ? {} : { discTitles }),
      song: songsOfAlbum(db, id).map((s) => songChild(s, record)),
    },
  };
}

export function getSong(db: DatabaseSync, query: URLSearchParams): Payload {
  const id = idOf(query, 'tr');
  const row = song(db, id);
  if (row === undefined) throw new ApiError(ERROR.notFound, `No such song: ${id}`);

  return { song: childOf(row) };
}

/**
 * Something to open the app on.
 *
 * The one listing here whose answer is not the same twice, and the filters are
 * the point of it: a client drawing a "shuffle everything" or a "shuffle this
 * genre" screen asks for exactly this. The folder is the protocol's own filter
 * and is honoured the way every other listing honours it — through `confinedTo`,
 * which refuses a folder this server never handed out.
 *
 * The draw itself is `meta.ts`'s, where the cost of it is stated.
 */
export function getRandomSongs(
  db: DatabaseSync,
  query: URLSearchParams,
  visibility: Visibility = 'records',
): Payload {
  const songs = randomSongs(db, {
    size: drawSize(query),
    // `|| undefined` and not `?? undefined`: an empty `genre=` is a client that
    // named no genre, which is the same as not naming the parameter — the rule
    // `drawSize`, `yearIn` and `confinedTo` in this same call all follow, and
    // `getSongsByGenre` refuses outright. `??` would pass `''` through and draw
    // from `file_tag` rows whose value is nothing, which is not a genre.
    genre: query.get('genre') || undefined,
    fromYear: yearIn(query, 'fromYear'),
    toYear: yearIn(query, 'toYear'),
    rootId: confinedTo(db, query),
    visibility,
  });

  return { randomSongs: { song: songs.map(childOf) } };
}

/**
 * How many songs to draw: the protocol's default of ten, and its ceiling of five
 * hundred.
 *
 * The ceiling is applied rather than refused — a client that asked for a
 * thousand asked for "more than you have", which is a request this server can
 * honour, and a refusal would break it over its own arithmetic.
 */
function drawSize(query: URLSearchParams): number {
  const raw = query.get('size');
  if (raw === null || raw === '') return 10;

  const size = Number(raw);
  if (!Number.isInteger(size) || size < 1) {
    throw new ApiError(ERROR.generic, `size is not a count: ${raw}`);
  }
  return Math.min(size, 500);
}

/** A year the client named, or nothing when it named none. */
function yearIn(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw === '') return undefined;

  const year = Number(raw);
  if (!Number.isInteger(year)) throw new ApiError(ERROR.generic, `${name} is not a year: ${raw}`);
  return year;
}

/** The listings this server can answer, which are the meta layer's own orderings. */
const ORDERABLE: ReadonlySet<string> = new Set([
  'alphabeticalByName',
  'alphabeticalByArtist',
  'newest',
  'random',
  // The listener's own: what they starred, what they rated, what they played and
  // what they played most. Refused until v1.2's marks and history made them
  // answerable — see `AlbumOrder`.
  'starred',
  'highest',
  'recent',
  'frequent',
]);

const DEFAULT_PAGE = 10;

/** The protocol's own ceiling on a page, so a client cannot ask for everything at once. */
const MAX_PAGE = 500;

function numeric(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ApiError(ERROR.generic, `${name} is not a whole number: ${raw}`);
  }
  return value;
}

/**
 * A whole number the client has to send, refused rather than defaulted.
 *
 * `numeric` above answers a fallback, which is right for a page — a client that
 * says nothing about `size` wants the default page. It is wrong for a bound: a
 * range with a silently invented end is not the range the client asked for, so
 * its absence is an error and says which parameter is missing, as a missing
 * `genre` does.
 */
function requiredNumber(query: URLSearchParams, name: string): number {
  const raw = query.get(name);
  if (raw === null || raw === '') {
    throw new ApiError(ERROR.generic, `Required parameter is missing: ${name}`);
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ApiError(ERROR.generic, `${name} is not a whole number: ${raw}`);
  }
  return value;
}

export function getAlbumList2(
  db: DatabaseSync,
  query: URLSearchParams,
  visibility: Visibility = 'records',
): Payload {
  const type = required(query, 'type');
  const rootId = confinedTo(db, query);

  // `byGenre` is the protocol's own name for it, and it is not an ordering —
  // it is a filter, and the genre it filters by is a required argument. Handled
  // before the orderings because it shares nothing with them but its shape.
  if (type === 'byGenre') {
    const genre = required(query, 'genre');
    const size = Math.min(Math.max(numeric(query, 'size', DEFAULT_PAGE), 1), MAX_PAGE);
    const offset = Math.max(numeric(query, 'offset', 0), 0);
    return {
      albumList2: {
        album: albumListByGenre(db, genre, size, offset, rootId, visibility).map(albumId3),
      },
    };
  }

  // `byYear` is the other filter, and its bounds are required for the reason the
  // genre beside it is: a decade is what the client asked for, and answering with
  // the whole collection would answer a different question.
  if (type === 'byYear') {
    const fromYear = requiredNumber(query, 'fromYear');
    const toYear = requiredNumber(query, 'toYear');
    const size = Math.min(Math.max(numeric(query, 'size', DEFAULT_PAGE), 1), MAX_PAGE);
    const offset = Math.max(numeric(query, 'offset', 0), 0);
    return {
      albumList2: {
        album: albumListByYear(db, fromYear, toYear, size, offset, rootId, visibility).map(albumId3),
      },
    };
  }

  if (!ORDERABLE.has(type)) {
    // Not an empty list. Nothing in the meta layer records a star or a play
    // count, and an empty answer would claim the collection holds none of them —
    // a different thing from "this server cannot say".
    throw new ApiError(ERROR.generic, `getAlbumList2 cannot list by ${type}`);
  }

  const size = Math.min(Math.max(numeric(query, 'size', DEFAULT_PAGE), 1), MAX_PAGE);
  const offset = Math.max(numeric(query, 'offset', 0), 0);

  return {
    albumList2: {
      album: albumList(db, type as AlbumOrder, size, offset, rootId, visibility).map(albumId3),
    },
  };
}

function directory(id: string, name: string, child: Payload[]): Payload {
  return { directory: { id, name, child } };
}

/**
 * A directory and what is under it.
 *
 * `-1` is the protocol's way of asking for the top of the tree, which for this
 * server is the roots it was told to scan. Below that, a folder's children are
 * its subfolders and the songs of any album sitting in it — one rule, so that a
 * category of folders, a box, a disc and a plain album all browse the same way
 * and none of them needs a special case.
 */
export function getMusicDirectory(
  db: DatabaseSync,
  query: URLSearchParams,
  visibility: Visibility = 'records',
): Payload {
  const raw = required(query, 'id');
  const rootId = confinedTo(db, query);

  // Two entries, and both are reachable on purpose. The library is what the
  // collection *is* — its artists, with the shelves they were filed on folded
  // in. The roots below it are what is on the disk, kept as [[wiki:3498]] §5
  // asks, so a client that wants the filesystem is not told to configure
  // anything to get it.
  if (raw === ID.top) {
    return directory(ID.top, '', [
      libraryChild(),
      ...roots(db)
        .filter((row) => rootId === undefined || row.id === rootId)
        .map(rootChild),
    ]);
  }

  // Read before `parseId`, which would take the key for a number: this is the
  // one id kind whose payload is a string.
  if (raw.startsWith(ID.virtualPrefix)) {
    const key = raw.slice(ID.virtualPrefix.length);
    if (key === '') {
      return directory(
        ID.library,
        LIBRARY,
        virtualNodes(db, rootId, visibility).map((node) => virtualChild(node, ID.library)),
      );
    }

    const bar = key.indexOf('|');
    const nodeKey = bar === -1 ? key : key.slice(0, bar);
    const creditKey = bar === -1 ? null : key.slice(bar + 1);

    const node = virtualNodes(db, rootId, visibility).find((one) => one.artistKey === nodeKey);
    if (node === undefined) throw new ApiError(ERROR.notFound, `No such id: ${raw}`);

    if (creditKey !== null) {
      const credit = virtualEntries(db, node, visibility)
        .flatMap((entry) => (entry.credit === null ? [] : [entry.credit]))
        .find((one) => one.artistKey === creditKey);
      if (credit === undefined) throw new ApiError(ERROR.notFound, `No such id: ${raw}`);

      const drawer = ID.virtual(`${nodeKey}|${creditKey}`);
      return directory(drawer, credit.name, credit.records.map((row) => albumChild(row, drawer)));
    }

    const id = ID.virtual(nodeKey);
    return directory(
      id,
      node.name,
      virtualEntries(db, node, visibility).map((entry) => entryChild(entry, id, nodeKey)),
    );
  }

  const parsed = parseId(raw);
  if (parsed === undefined) throw new ApiError(ERROR.notFound, `No such id: ${raw}`);

  if (parsed.kind === 'ro') {
    const row = root(db, parsed.n);
    if (row === undefined) throw new ApiError(ERROR.notFound, `No such root: ${raw}`);
    const id = ID.root(row.id);
    return directory(
      id,
      row.alias ?? lastSegment(row.path),
      childFolders(db, row.id, '').map((f) => folderChild(f, id)),
    );
  }

  if (parsed.kind === 'fd') {
    const row = folder(db, parsed.n);
    if (row === undefined) throw new ApiError(ERROR.notFound, `No such folder: ${raw}`);
    const id = ID.folder(row.id);
    return directory(id, lastSegment(row.rel_path), [
      ...childFolders(db, row.root_id, row.rel_path).map((f) => folderChild(f, id)),
      ...songsInFolder(db, row.root_id, row.rel_path).map((s) => songChild(s, id)),
    ]);
  }

  if (parsed.kind === 'al') {
    const row = album(db, parsed.n);
    if (row === undefined) throw new ApiError(ERROR.notFound, `No such album: ${raw}`);
    const id = ID.album(row.id);
    return directory(
      id,
      row.title ?? '',
      songsOfAlbum(db, row.id).map((s) => songChild(s, id)),
    );
  }

  if (parsed.kind === 'ar') {
    const row = artist(db, parsed.n);
    if (row === undefined) throw new ApiError(ERROR.notFound, `No such artist: ${raw}`);

    // The folder decides where the artist owns one, so an artist who owns a
    // folder answers exactly as their node does. `ar:` was the tag's answer and
    // `vn:` the folder's, and one artist reading as two different artists to
    // two clients that came by different doors is the whole of what was wrong
    // with that: `Cock E.S.P.` holds twenty-four records in its folder and
    // thirteen carry its credit.
    const node = nodeOf(db, row.name_key, rootId, visibility);
    if (node !== undefined) {
      const id = ID.virtual(row.name_key);
      return directory(
        id,
        node.name,
        virtualEntries(db, node, visibility).map((entry) => entryChild(entry, id, row.name_key)),
      );
    }

    const id = ID.artist(row.id);
    return directory(
      id,
      row.name,
      albumsOfArtist(db, row.id, rootId, visibility).map((a) => albumChild(a, id)),
    );
  }

  throw new ApiError(ERROR.notFound, `No such id: ${raw}`);
}
