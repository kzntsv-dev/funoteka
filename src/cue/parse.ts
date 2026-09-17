/**
 * A cue sheet, reported exactly as written.
 *
 * The parser deliberately makes no judgement calls. It does not decide that a
 * `FILE ... WAVE` line is really an `.m4a`, does not fall back to the album
 * PERFORMER for a track that lacks one, and does not tidy a missing INDEX 01.
 * Those are decisions with consequences, and they belong to the matcher, which
 * can record what it assumed. Here, what the file says is what comes out.
 */

export interface CueFileRef {
  name: string;
  /** As declared — commonly wrong. `WAVE` on an `.m4a` is a real case. */
  type: string | null;
}

export interface CueTrack {
  /** TRACK number as written; cues are not guaranteed to be contiguous. */
  ordinal: number;
  /** Usually AUDIO; data tracks appear in mixed-mode rips. */
  type: string;
  title: string | null;
  performer: string | null;
  /** Pregap start, if the cue declares one. */
  index00Ms: number | null;
  /** Track start. Null when the cue declares a track but no INDEX 01. */
  index01Ms: number | null;
  /**
   * Which FILE each mark was written in — not always the track's own.
   *
   * A cue writes the pregap of a track that opens a file at the *end* of the file
   * before it, so `INDEX 00` can sit in one FILE and `INDEX 01` in the next. The
   * two times are then counted from different starts, and without these the row
   * can say a track ends before it begins: measured on this collection, 31 rows
   * of 1001 across six cues (task:2755).
   */
  index00FileIndex: number | null;
  index01FileIndex: number | null;
  /** Which of `files` this track belongs to — cues can span several files. */
  fileIndex: number;
}

/**
 * A line this parser looked at and could not place.
 *
 * Reported rather than dropped, because the parser's whole promise is that what
 * the file says is what comes out — and a line nobody understood is part of what
 * the file says. `FILE My Album.flac FLAC`, written without the quotes the
 * grammar wants, takes its file reference with it and leaves every TRACK after
 * it counted against the file *before* it: the cue still parses, the album still
 * gets tracks, and the offsets they carry point at the wrong file (task:2756,
 * finding 2).
 *
 * Measured over the live library — all 263 cue files under the scan root — the
 * list is empty every time: not one line in the collection is a line this
 * parser cannot place. So the counter is not a stream of complaints to be
 * skimmed, and anything it ever says is news (2026-09-14).
 */
export interface UnrecognizedLine {
  /** 1-based, as an editor would show it. */
  line: number;
  /** The line as written, trimmed. */
  text: string;
  /**
   * The line opened with a cue command and still did not parse.
   *
   * The difference is worth carrying: a `FILE` or `TRACK` that will not read is
   * a statement this reader failed to understand and a real risk to the rows
   * built from it, while a line that is not cue syntax at all is usually noise
   * a ripper left behind. One is worth a warning and the other is not.
   */
  malformed: boolean;
}

export interface CueDocument {
  title: string | null;
  performer: string | null;
  /**
   * Values the cue states by name, keyed uppercased: from `REM` (DATE, GENRE,
   * DISCID, COOLNESS, …) and from `CATALOG`, which states the same kind of fact
   * under a command of its own rather than behind a comment.
   */
  rem: Record<string, string>;
  files: CueFileRef[];
  tracks: CueTrack[];
  /** Lines that matched no cue command, in the order they were written. */
  unrecognized: UnrecognizedLine[];
}

/** 75 CD frames to the second — the unit INDEX timestamps are counted in. */
const FRAMES_PER_SECOND = 75;

/**
 * `mm:ss:ff` to milliseconds, or null when the value is not a cue time at all.
 *
 * Frames are optional because some rippers write plain `mm:ss`. Seconds and
 * frames are range-checked so a malformed timestamp is reported rather than
 * quietly turned into a plausible-looking offset.
 */
export function parseCueTime(value: string): number | null {
  const match = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const frames = match[3] === undefined ? 0 : Number(match[3]);

  if (seconds > 59 || frames >= FRAMES_PER_SECOND) return null;

  return minutes * 60_000 + seconds * 1000 + Math.round((frames * 1000) / FRAMES_PER_SECOND);
}

const FILE_LINE = /^FILE\s+(?:"([^"]*)"|(\S+))(?:\s+(\S+))?\s*$/i;
const TRACK_LINE = /^TRACK\s+(\d+)\s+(\S+)/i;
const INDEX_LINE = /^INDEX\s+(\d{1,2})\s+(\S+)/i;
const REM_LINE = /^REM\s+(\S+)\s*(.*)$/i;
const FIELD_LINE = /^(TITLE|PERFORMER)\s+(.*)$/i;

/**
 * Commands a cue sheet carries that this reader reads nothing out of.
 *
 * Dropping one of these is a decision, not a failure to understand: the pregap
 * is where the split stage already gets its answer from `INDEX 00`, the flags
 * and the ISRC describe the disc, and the songwriter is a credit the artist
 * stage does not take from a cue. Counting them as unrecognised would make the
 * counter fire on most cues in the library and say nothing by doing so.
 *
 * `CATALOG` is deliberately **not** here, though it reads like the others. It
 * was, until the counter was pointed at the library and the vocabulary of all
 * 263 cues was counted: 21 of them state a catalogue number as a bare `CATALOG`
 * line, and not one of those 21 writes it as `REM CATALOG` as well. The column
 * that exists for it is filled from the `REM` form alone, so those 21 numbers —
 * real EANs, `4988015085082`, `0602475036746` — reached no column and no report.
 * A command whose value goes nowhere was never "understood and not kept"; it
 * was the same silence this counter is here to end (task:2756, finding 2).
 */
const IGNORED_LINE = /^(?:CDTEXTFILE|FLAGS|ISRC|POSTGAP|PREGAP|SONGWRITER)\b/i;

/**
 * The media catalogue number, which a cue states under its own command.
 *
 * Kept in the same map the `REM` form lands in, so the caller reads one key —
 * `cue.catalog` is filled from `doc.rem['CATALOG']` and does not have to learn
 * about a second spelling. When a cue writes both, the *command* is the one
 * that stands: `REM` is a comment convention and `CATALOG` is the format's own
 * field for the number, so the reading is settled by position in the grammar
 * rather than by line order. No cue in the collection writes both; the rule is
 * here so that the first one that does is read the same way twice.
 */
const CATALOG_LINE = /^CATALOG\s+(.*)$/i;

/** The commands this parser does read, for telling a broken line from a foreign one. */
const READ_COMMAND = /^(?:FILE|TRACK|INDEX|REM|TITLE|PERFORMER)\b/i;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseCue(text: string): CueDocument {
  const doc: CueDocument = {
    title: null,
    performer: null,
    rem: {},
    files: [],
    tracks: [],
    unrecognized: [],
  };
  let current: CueTrack | null = null;
  // Held apart from `rem` until the end so that the command outranks the
  // comment however the two are ordered in the file — see `CATALOG_LINE`.
  let statedCatalog: string | null = null;

  // A BOM would otherwise attach itself to the first key and silently lose it.
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = (lines[lineNo] ?? '').trim();
    if (line === '') continue;

    const file = FILE_LINE.exec(line);
    if (file) {
      doc.files.push({ name: file[1] ?? file[2] ?? '', type: file[3] ?? null });
      continue;
    }

    const track = TRACK_LINE.exec(line);
    if (track) {
      current = {
        ordinal: Number(track[1]),
        type: (track[2] ?? 'AUDIO').toUpperCase(),
        title: null,
        performer: null,
        index00Ms: null,
        index01Ms: null,
        index00FileIndex: null,
        index01FileIndex: null,
        fileIndex: Math.max(0, doc.files.length - 1),
      };
      doc.tracks.push(current);
      continue;
    }

    const index = INDEX_LINE.exec(line);
    if (index && current) {
      const ms = parseCueTime(index[2] ?? '');
      if (ms !== null) {
        // The file in force at *this* line, which is what makes the time mean
        // something: a cue writes a track's pregap at the end of the file before
        // the one the track opens, so the two marks can be in different files
        // and their times are then counted from different starts.
        const at = Math.max(0, doc.files.length - 1);
        if (index[1] === '00') {
          current.index00Ms = ms;
          current.index00FileIndex = at;
        } else if (index[1] === '01') {
          current.index01Ms = ms;
          current.index01FileIndex = at;
        }
      }
      continue;
    }

    const rem = REM_LINE.exec(line);
    if (rem) {
      const key = (rem[1] ?? '').toUpperCase();
      if (key !== '') doc.rem[key] = unquote(rem[2] ?? '');
      continue;
    }

    const catalog = CATALOG_LINE.exec(line);
    if (catalog) {
      const value = unquote(catalog[1] ?? '');
      if (value !== '') statedCatalog = value;
      continue;
    }

    const field = FIELD_LINE.exec(line);
    if (field) {
      const key = (field[1] ?? '').toUpperCase();
      const value = unquote(field[2] ?? '');
      // Album-level fields precede the first TRACK; per-track fields follow it.
      if (current === null) {
        if (key === 'TITLE') doc.title = value;
        else doc.performer = value;
      } else if (key === 'TITLE') {
        current.title = value;
      } else {
        current.performer = value;
      }
      continue;
    }

    // Understood and deliberately not kept — see `IGNORED_LINE`.
    if (IGNORED_LINE.test(line)) continue;

    // Nothing claimed it. The parser's contract is to report what the file says,
    // and this is a thing it says that nothing here read.
    doc.unrecognized.push({
      line: lineNo + 1,
      text: line,
      malformed: READ_COMMAND.test(line),
    });
  }

  if (statedCatalog !== null) doc.rem['CATALOG'] = statedCatalog;

  return doc;
}
