-- Meta layer (v1) — the classified model the API will read from.
--
-- Two rules shape this schema and both come straight from the contract
-- (requirements:39):
--
--   1. Album identity is the PATH (root-qualified). Nothing is ever merged by
--      tags or content, so pressings of the same album, or a copy of one album
--      sitting in two roots, are distinct rows.
--   2. The filesystem is raw truth. Every row here is derived from it, and the
--      collection files themselves are never mutated — this layer is an overlay.

-- Scan bookkeeping -----------------------------------------------------------

CREATE TABLE scan_run (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT    NOT NULL,
  finished_at TEXT,
  status      TEXT    NOT NULL,          -- running | ok | failed
  roots_json  TEXT    NOT NULL           -- JSON array of the configured root paths
);

-- Sources --------------------------------------------------------------------

CREATE TABLE root (
  id         INTEGER PRIMARY KEY,
  path       TEXT    NOT NULL UNIQUE,    -- absolute, as configured by the user
  alias      TEXT,
  created_at TEXT    NOT NULL
);

-- Folders, with the classification role the classifier assigns (album /
-- category / box / disc). NULL until the classifier has run over this folder.
CREATE TABLE folder (
  id              INTEGER PRIMARY KEY,
  root_id         INTEGER NOT NULL REFERENCES root(id) ON DELETE CASCADE,
  rel_path        TEXT    NOT NULL,      -- '' is the root itself
  parent_rel_path TEXT,
  role            TEXT,
  UNIQUE (root_id, rel_path)
);

-- Every file met on disk. Audio files are the primary truth; the rest are
-- sidecars (cue/nfo/log), artwork, playlists, or noise.
CREATE TABLE file (
  id                INTEGER PRIMARY KEY,
  root_id           INTEGER NOT NULL REFERENCES root(id) ON DELETE CASCADE,
  rel_path          TEXT    NOT NULL,
  folder_rel_path   TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  kind              TEXT    NOT NULL,    -- audio | cue | image | nfo | log | playlist | other
  ext               TEXT    NOT NULL,
  size              INTEGER NOT NULL,
  mtime_ms          INTEGER NOT NULL,
  first_seen_run_id INTEGER REFERENCES scan_run(id),
  last_seen_run_id  INTEGER REFERENCES scan_run(id),
  UNIQUE (root_id, rel_path)
);

CREATE INDEX idx_file_kind ON file (root_id, kind);
CREATE INDEX idx_file_folder ON file (root_id, folder_rel_path);

-- ffprobe results. `probe_ok = 0` with a `probe_err` is a legitimate state:
-- ffprobe is optional, and a missing probe must degrade, not abort the scan.
CREATE TABLE audio_probe (
  file_id     INTEGER PRIMARY KEY REFERENCES file(id) ON DELETE CASCADE,
  duration_ms INTEGER,
  codec       TEXT,
  sample_rate INTEGER,
  channels    INTEGER,
  bitrate     INTEGER,
  probe_ok    INTEGER NOT NULL DEFAULT 0,
  probe_err   TEXT
);

-- Artists. `name_key` is the normalised merge key (Cure / The Cure / Cure, The
-- collapse to one). It stays UNIQUE, so one row still cannot be two artists at
-- once — but a homonym no longer has to share a key: the second artist folder to
-- claim a name gets `nirvana#2`, which cannot collide with a bare key because a
-- key carrying `#` has no letter or digit in it (`qualifiedKey`, src/artist).
--
-- `ambiguous = 1` therefore records that a row's identity is a *guess*, whichever
-- way it was reached: a key that merged spellings which fold differently, or a
-- key split apart because two artist folders both claimed it ("разные арт-папки
-- = разные артисты", wiki:3498 §3). An artist that won its name outright is the
-- only kind left unflagged; `artist-homonym` issues name what a split threw
-- together, and `ambiguous` alone never says which of the two happened.
CREATE TABLE artist (
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL,
  name_key  TEXT    NOT NULL UNIQUE,
  sort_key  TEXT,
  ambiguous INTEGER NOT NULL DEFAULT 0
);

-- A box set: one release spanning several discs, which also projects each disc
-- as its own album row. Discs show up two ways — as CD subfolders, or, when the
-- rip is flat, as one image+cue pair per disc.
CREATE TABLE release (
  id        INTEGER PRIMARY KEY,
  root_id   INTEGER NOT NULL REFERENCES root(id) ON DELETE CASCADE,
  rel_path  TEXT    NOT NULL,
  title     TEXT,
  artist_id INTEGER REFERENCES artist(id),
  UNIQUE (root_id, rel_path)
);

CREATE TABLE album (
  id         INTEGER PRIMARY KEY,
  root_id    INTEGER NOT NULL REFERENCES root(id) ON DELETE CASCADE,
  rel_path   TEXT    NOT NULL,           -- identity — see rule 1 above
  title      TEXT,
  artist_id  INTEGER REFERENCES artist(id),
  release_id INTEGER REFERENCES release(id),
  disc_number INTEGER,
  UNIQUE (root_id, rel_path)
);

CREATE INDEX idx_album_release ON album (release_id);

-- Cue documents. `audio_file_id` is resolved by matching the audio files that
-- are actually present, NOT by the cue's FILE tag — real rips carry a stale tag
-- (a .m4a declared as WAVE). NULL means no audio in the folder matched.
CREATE TABLE cue (
  id                  INTEGER PRIMARY KEY,
  file_id             INTEGER NOT NULL UNIQUE REFERENCES file(id) ON DELETE CASCADE,
  encoding            TEXT,
  encoding_confidence REAL,
  audio_file_id       INTEGER REFERENCES file(id)
);

-- Raw cue TRACK entries, in file order. Times are milliseconds; `index00_ms` is
-- the pregap and may legitimately be absent.
CREATE TABLE cue_track (
  id          INTEGER PRIMARY KEY,
  cue_id      INTEGER NOT NULL REFERENCES cue(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  title       TEXT,
  performer   TEXT,
  index00_ms  INTEGER,
  index01_ms  INTEGER NOT NULL,
  UNIQUE (cue_id, ordinal)
);

-- Playable units. A whole-file track leaves the segment NULL; a cue-split track
-- points at the image file and carries a time segment. Note that the *last*
-- split track has no following index to bound it — its end comes from the audio
-- file's real duration, which is why audio_probe exists.
CREATE TABLE track (
  id               INTEGER PRIMARY KEY,
  album_id         INTEGER REFERENCES album(id) ON DELETE CASCADE,
  artist_id        INTEGER REFERENCES artist(id),
  ordinal          INTEGER NOT NULL,
  title            TEXT,
  file_id          INTEGER NOT NULL REFERENCES file(id),
  segment_start_ms INTEGER,
  segment_end_ms   INTEGER,
  duration_ms      INTEGER,
  UNIQUE (album_id, ordinal)
);

CREATE INDEX idx_track_file ON track (file_id);

-- Incremental rescan bookkeeping: a file whose size and mtime are unchanged is
-- not re-read.
CREATE TABLE scan_state (
  root_id          INTEGER NOT NULL REFERENCES root(id) ON DELETE CASCADE,
  rel_path         TEXT    NOT NULL,
  size             INTEGER NOT NULL,
  mtime_ms         INTEGER NOT NULL,
  last_seen_run_id INTEGER NOT NULL REFERENCES scan_run(id),
  PRIMARY KEY (root_id, rel_path)
);

-- "What the scanner did not understand." Every guess, skip and unmatched cue
-- lands here so a scan can never lose information silently.
CREATE TABLE issue (
  id          INTEGER PRIMARY KEY,
  scan_run_id INTEGER REFERENCES scan_run(id) ON DELETE CASCADE,
  root_id     INTEGER REFERENCES root(id),
  rel_path    TEXT,
  kind        TEXT    NOT NULL,
  severity    TEXT    NOT NULL DEFAULT 'warn',
  detail      TEXT
);

CREATE INDEX idx_issue_run ON issue (scan_run_id, kind);

-- Search layer (spec §2) ----------------------------------------------------
-- Populated by a later stage; declared here so the meta layer is complete.

CREATE VIRTUAL TABLE track_fts USING fts5 (
  title,
  artist,
  album,
  tokenize = 'unicode61 remove_diacritics 2'
);
