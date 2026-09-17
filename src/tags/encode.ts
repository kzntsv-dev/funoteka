/**
 * The tags of a song, as bytes a container can carry.
 *
 * A cue track is not a file — it is a stretch of an image — so when this server
 * serves one it *builds* the file, and the file it built had no tags at all:
 * measured on the live collection, a cut segment arrived with one `STREAMINFO`
 * block and nothing else, and a client that saved it for offline use had a file
 * whose own player could show nothing but the file name (task:2895). What is
 * here is the missing half of that answer.
 *
 * **The tags come from the meta layer, not from the image.** Copying the
 * image's own blocks was the obvious fix and the measurement refused it: of the
 * 156 FLAC images that hold split tracks, 27 carry tags — and those tags are the
 * *disc's*. `Кино - Ночь (MKK861CD1).flac` states `title = Ночь (MKK861CD1)` and
 * `album = lossless-galaxy.ru`; put on a cut track, the first is the name of a
 * disc the track is one song of, and the second is the site it was downloaded
 * from. A track wearing those is worse off than a track wearing nothing, because
 * a player shows them with confidence. The meta layer is the only thing that
 * knows what this track is, so it is the only thing asked.
 *
 * Names are the ones the collection already states — `title`, `artist`, `album`,
 * `albumartist`, `tracknumber`, `discnumber`, `date`, `genre` are the eight most
 * common names in `file_tag` (measured: 1943–3220 rows each, ahead of `comment`
 * at 745) — so what a file this server wrote states is what a file it read
 * states, and the reader needed no new spelling to understand its own output.
 */

/**
 * What is known about one song, in the words every container here uses.
 *
 * Null means the collection does not know, and a field the collection does not
 * know is left out of the file rather than written empty: a `TITLE=` of nothing
 * is a claim that the song has no title, where a missing one is a file that
 * never said.
 */
export interface TrackTags {
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  /** The year, or a whole date, as the collection states it. */
  date: string | null;
  genre: string | null;
}

/**
 * What this writer calls itself, which is what the vendor field is for.
 *
 * Vorbis I §5.2.1 defines the vendor string as identifying the *software*, not
 * the collection, and it is written for the same reason a `TENC` frame is: a
 * file that says who wrote it can be asked why it looks the way it does.
 */
const VENDOR = 'funoteka';

/** The fields to write, in a fixed order, each as `NAME=value` — Vorbis I §5.2.2. */
function fields(tags: TrackTags): [string, string][] {
  const wanted: [string, string | number | null][] = [
    ['TITLE', tags.title],
    ['ARTIST', tags.artist],
    ['ALBUMARTIST', tags.albumArtist],
    ['ALBUM', tags.album],
    ['TRACKNUMBER', tags.trackNumber],
    ['DISCNUMBER', tags.discNumber],
    ['DATE', tags.date],
    ['GENRE', tags.genre],
  ];

  return wanted
    .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== '')
    .map(([name, value]) => [name, String(value)]);
}

/**
 * The body of a `VORBIS_COMMENT` metadata block (Vorbis I §5.2.1, RFC 9639
 * §8.6, which is the same layout).
 *
 * A 32-bit vendor length and its bytes, a 32-bit field count, then each field as
 * its own length and bytes — every length little-endian, every string UTF-8. The
 * block *header* is not here: that is the container's, and `stream/flac.ts`
 * writes it, because a block header is three bytes of type and size that only a
 * FLAC file has.
 *
 * A field is written even when it is the only one, and the block is written even
 * when there are none — an empty comment list is a valid block that says the
 * file states nothing, which is a different statement from a file with no
 * comment block at all, and the one this server can make.
 */
export function vorbisComment(tags: TrackTags): Buffer {
  const vendor = Buffer.from(VENDOR, 'utf8');
  const written = fields(tags).map(([name, value]) => Buffer.from(`${name}=${value}`, 'utf8'));

  const at = (length: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(length, 0);
    return buffer;
  };

  return Buffer.concat([
    at(vendor.length),
    vendor,
    at(written.length),
    ...written.map((field) => Buffer.concat([at(field.length), field])),
  ]);
}

/**
 * A whole ID3v2.4 tag, which is what an mp3 segment is served behind.
 *
 * **Version 2.4 and not 2.3, and the reason is the collection.** 2.3 has two
 * encodings and neither is UTF-8 — a title with one Cyrillic letter in it needs
 * UTF-16 with a byte-order mark, and this collection is full of them. 2.4 added
 * UTF-8 as a third encoding, and every reader that matters — this project's own
 * (`tags/id3v2.ts`) and ffmpeg's — reads it. The alternative is writing a
 * byte-order mark into every song whose name is not ASCII and hoping the reader
 * guesses the endianness, which is the guess the reader's own comments spend a
 * page explaining.
 *
 * The frame sizes are **syncsafe** here, which is 2.4's other change: four bytes
 * of seven bits each, so that a size can never contain a byte that looks like a
 * frame sync. That is the trap in writing 2.4 by hand, and the test reads the
 * result back through this project's own reader rather than asserting the bytes.
 */
export function id3v2(tags: TrackTags): Buffer {
  const frames: Buffer[] = [];
  for (const [name, value] of fields(tags)) {
    frames.push(textFrame(FRAMES[name] ?? name, value));
  }
  return Buffer.concat([header(frames), ...frames]);
}

/**
 * The frame identifiers a name is written under.
 *
 * 2.4's own set, and the date is the one worth stating: `TYER` is 2.3's frame
 * for a year and 2.4 replaced it with `TDRC`, which carries a whole timestamp —
 * so a year goes in `TDRC` because that is the frame a 2.4 reader looks for, and
 * the value is short rather than wrong. `tags/id3v2.ts` reads both and prefers
 * the one that states more, so a file this server wrote and a file a ripper
 * wrote are read by the same rule.
 */
const FRAMES: Record<string, string> = {
  TITLE: 'TIT2',
  ARTIST: 'TPE1',
  ALBUMARTIST: 'TPE2',
  ALBUM: 'TALB',
  TRACKNUMBER: 'TRCK',
  DISCNUMBER: 'TPOS',
  DATE: 'TDRC',
  GENRE: 'TCON',
};

/** Four bytes of id, four of syncsafe size, two of flags — the informal 2.4 §4. */
function textFrame(id: string, value: string): Buffer {
  const text = Buffer.concat([Buffer.from([0x03]), Buffer.from(value, 'utf8')]);
  const frame = Buffer.alloc(10);
  frame.write(id, 0, 'latin1');
  syncsafe(text.length).copy(frame, 4);
  // Flags are zero: no compression, no encryption, no grouping, no unsynchronisation.
  return Buffer.concat([frame, text]);
}

/** The tag header: `ID3`, version, flags, and the size of what follows (2.4 §3.1). */
function header(frames: readonly Buffer[]): Buffer {
  const body = frames.reduce((total, frame) => total + frame.length, 0);
  const head = Buffer.alloc(10);
  head.write('ID3', 0, 'latin1');
  head[3] = 0x04;
  head[4] = 0x00;
  head[5] = 0x00;
  syncsafe(body).copy(head, 6);
  return head;
}

/**
 * A length as four seven-bit bytes, most significant first (2.4 §6.2).
 *
 * The top bit of every byte is clear, so no byte of a size can be mistaken for a
 * frame sync or a terminator by a scanner that is looking for one. A length that
 * does not fit in 28 bits is refused rather than truncated: it cannot happen for
 * a tag this writer builds, and the failure of getting it wrong silently is a
 * tag whose frames are read from the wrong offsets.
 */
function syncsafe(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value >= 1 << 28) {
    throw new Error(`a tag length must fit in four syncsafe bytes: ${value}`);
  }
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}
