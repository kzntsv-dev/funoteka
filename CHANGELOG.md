# Changelog

All notable changes to funoteka. Format follows [Keep a Changelog](https://keepachangelog.com/);
the project uses [Semantic Versioning](https://semver.org/).

The version lives in exactly one place — `package.json`.

## [Unreleased]

### Added

- **`docs/OPENSUBSONIC.md` — what this server implements, endpoint by endpoint.**
  Written because the OpenSubsonic project asked for one: a client developer should be
  able to see what can be tested against a server without reading its source. Every
  answerable method, the five announced extensions, every method answered empty or
  refused, and the three that are not there at all. The page is held to the router by
  `test/docs-opensubsonic.test.ts`, so a method added to `ROUTES` fails a test until
  the page names it — and a stub that becomes real fails it until the page moves it
  out of the empty half.

## [0.1.5] — 2026-09-18

### Fixed

- **A song cut out of an image answers with a path of its own.** Every song of a
  cue-split record is cut from the one image, so all twelve songs of
  `Czesslove — Breakstorm (2004)` answered with the image's path — and Symfonium
  keys a song by its file (*"songs with the same file are supposed to be the same
  song"*), so it played the record as one song: the first track, twelve times,
  and scrobbled it (measured on the installed instance: `tr-858` with
  `playCount` 3 while the player showed `tr-860`). The path is still the image's,
  because that is the file the bytes come from, plus the cut number before the
  extension — `… - Breakstorm (track 3).flac`. The number is the track's
  `ordinal`, which the schema keys `UNIQUE (album_id, ordinal)` on and no rescan
  moves, so two songs of one image can never share a path by accident. This one
  line reached **1 789 songs of 167 records** in the operator's collection, every
  one of which a client had been told was the same song.
- **The smoke step that watches cuts no longer looks for the defect.** It found a
  cue-split record by songs of one record sharing a path — which is now the
  defect itself, so it would have passed a regressed build and skipped a fixed
  one, silently, the way it once skipped over `size`. It now finds its record by
  the image a song is cut from and asserts the fix: every song carries a cut
  number of its own, and it is the number the record gives the song. `size`
  absent for a cut is now reported instead of compared (`undefined * 1.5` is
  `NaN`, so the promise went unchecked in silence).

### Changed

- The `size` of a cut song is still an estimate — the exact length is a number
  nothing holds without walking the image's frames — but its documentation no
  longer claims 0.8 % accuracy from a single measurement. Measured on two cuts it
  is 0.8 % low on one and **13 % high** on the other (42 637 432 promised against
  37 735 326 served for `tr-858`), and the true total is on `stream`'s own answer.
  Dropping the field was considered and turned down: `size` absent surprises more
  clients than `size` 13 % high.

## [0.1.4] — 2026-09-17

### Fixed

- **The scan started from the server starts again.** `src/cli.ts` called
  `entryPoint('./cli')` and the helper's default base was `import.meta.url`
  evaluated *inside the helper* — so `./cli` resolved against `src/cli/`, not the
  caller, and the scan child died with `Cannot find module '.../src/cli/cli.ts'`.
  That killed every server-side entry to a scan: `POST /scan`, the MCP
  `funoteka_scan_start` tool, the interval timer and the reader-change trigger.
  The CLI scan kept working, which is why a broken published build read as a
  deployment problem. The base is now a **required** argument to `entryPoint`
  (forgetting it is a `TS2554`, and a path that does not exist throws), both call
  sites name it, and the seam has tests over the exact pair the call sites use.

## [0.1.3] — 2026-09-17

### Changed

- **The public README, which is a release artefact and ships in this package.**
  Three things in it are new to a reader: **what it costs**, measured rather than
  asserted (about 42 MB of RAM idle, 30 MB of SQLite for 3 432 songs, a 421 MB
  image, and a collection that is only ever read); the **first scan is a step in
  the quick start** (it was missing, so the documented install produced a server
  with an empty library); and the **agent pitch opens the file**. The clients named
  are the ones that have actually connected (`player`: Feishin, Symfonium,
  Substreamer, Amcfy Music, Castafiore), not a compatibility wish-list.
- **A checkout now has a working `funoteka`.** `bin` names `dist/cli.js` and a
  clone had no `dist/` — so `npm install && npm link` produced a binary that
  failed — until `prepare` was added to build it on install.
- `DEPLOY.md` gained the two journeys that were guesses: the Windows service
  wrapper versus the daemon that is in daily use, and the two things a NAS shows
  that the command does not (the container's uid, and the arm64 half being built
  under emulation).

### Fixed

- The engine of this patch is unchanged: no server code, no schema. What changed
  is what a reader is told, and one line of `package.json` that makes the clone
  behave.

## [0.1.2] — 2026-09-17

### Fixed

- **The version the server reports is now the version it is.** `0.1.1`'s image and
  package both answered `0.1.0` on `/health` and in every Subsonic envelope,
  because the version lives in a constant (`SERVER_VERSION`) that a test pins to
  `package.json` — and the bump to `0.1.1` raised the manifest and left the
  constant behind. **That test failed, and `0.1.1` was tagged while CI was red**,
  which is the more serious half of this: the pipeline was watching the artefacts
  and nobody was watching the pipeline. The constant is corrected, and the release
  job now fails when the image it pulls answers with a version other than the one
  the release is about — a check that can fail is what would have caught it.
- Nothing else changed: the same program as `0.1.0` and `0.1.1`, and the same
  schema.

## [0.1.1] — 2026-09-17

### Fixed

- **The release pipeline verifies the package from outside the checkout, and on
  the Node the package asks for.** `npx funoteka@<version>` run in the repository
  root resolves the bin from the project it happens to stand in — whose own name
  is `funoteka` — and reported `funoteka: not found` about a package that
  publishes and installs fine; and the check ran on whatever Node the runner
  ships, while the CLI needs `node:sqlite`. **No server code changed in this
  patch:** `0.1.0` and `0.1.1` are the same program, and the image and the package
  of `0.1.0` are published and verified. This is the release that proves the
  pipeline end to end, taken as a patch because a tag whose verification is red
  is not a release.

## [0.1.0] — 2026-09-17

First public release. A Subsonic-compatible server that reads whatever is on
disk and decides for itself what an album, an artist and a track are — how the
folders happen to be laid out is not a question a client ever has to care about.

### Added

**Scanning and classification**

- A nine-stage scan — `scan → classify → tags → cues → playlists → artists →
  shelves → collisions → search` — where every derived row is rebuilt from the
  current state, so a scan is idempotent and a repeat scan is not a re-read: a
  file whose size and modification time are unchanged is left alone.
- Several library roots at once. The same relative path under two roots stays
  two different albums.
- Classification without an LLM and without a naming convention: the folder
  decides what a record is, and a record that was cut from one image, or that
  names its disc after a number, is recognised as such.
- Cue sheets: songs inside a lossless image are split and handed out as songs —
  only the m4a/ALAC case goes through ffmpeg, everything else is cut in place.
- Playlists imported from the `.m3u` files lying in the collection, matched by
  where the entries point rather than by what the file is called.
- Full-text search over an SQLite FTS5 index, built last, because it is a copy
  of what the previous stages decided.
- `GET /issues`: what the scanner did **not** understand, as an output rather
  than a line in a log.
- A half-written file is not read and not recorded: the scanner waits for the
  disk to go quiet, and a file that is still moving is named as such in
  `GET /issues`.
- The server scans on its own: on an interval, in quiet hours, on changes seen
  by a watcher with a settle window, and when a file was read by an older
  method than the one the current build has.

**HTTP API**

- Subsonic/OpenSubsonic surface under `/rest/…`: ping, browse (artists →
  albums → tracks), search, stream with byte ranges, cover art (embedded and
  from the folder), playlists, stars and ratings, bookmarks, play queue,
  scrobble/now-playing history, transcoding, and a `download` that copies the
  frame range of a cue image instead of the whole image.
- `GET /health` without credentials — for a supervisor that cannot have any.
- A refusal is written down rather than swallowed: a value that is only a
  `${…}` placeholder is read as "no token", and a server with no way in does
  not start at all — a test pins that.

**Admin surface (second port, second token)**

- The admin port does not exist until `FUNOTEKA_ADMIN_TOKEN` is set, and it
  has four locks: the token, an address/CIDR allowlist, a failure limit
  (10 failures from one address → 15 minutes), and optional TLS.
- Roots (`GET`/`POST`/`DELETE`), asynchronous scans (`POST /scan`,
  `GET /scan`, `/scan/cancel`, `/scan/history`), `stats`, `issues`, `logs`,
  `inventory`, the three junk verbs (`junk`, `trust`, and taking the mark off),
  `playlists/import`, `export`/`restore`, and a credentials endpoint that says
  what is set and never what it is.
- Every mutation and every refusal is appended to `<db>.audit.jsonl` — outside
  the database it describes.
- Mutations are idempotent by `Idempotency-Key`, and the record lives in the
  database rather than in memory, so it survives the restart it may cause.

**MCP**

- 22 `funoteka_*` tools over stdio (`funoteka mcp`) and over HTTP `/mcp`.
  Each tool is one admin route rather than a second implementation — the same
  gate, the same audit, the same refusals.

**Deployment**

- `Dockerfile` + `docker-compose.yml`, a systemd unit and a Windows service
  wrapper (WinSW, fetched and hash-checked), all of them telling the server
  `FUNOTEKA_SUPERVISED=1` so that `POST /restart` is a restart and not a stop.
- A configuration file in four layers — defaults → file → environment →
  flag — where an unknown key or an unparsable file stops the command instead
  of starting a server that only looks configured.
- **An npm package**: `npx -y funoteka mcp` starts the MCP server against a running
  funoteka, and the same package carries the CLI (`scan`, `serve`, `stop`, `status`).
  Node refuses to strip types from anything under `node_modules`, so the package ships
  the sources compiled once at release — the repository itself still needs no build.
- **A published container image**: `ghcr.io/kzntsv-dev/funoteka:0.1.0` and
  `:latest` — `linux/amd64` and `linux/arm64` in one manifest, so the main
  install path needs no checkout.
- Daemon mode with `status` and `stop`, a pid file that is checked against the
  OS rather than believed, and `DEPLOY.md`.

### Known limitations

- **The `arm64` leg of the published image is built under emulation** on an
  `amd64` machine, and the `Dockerfile` in this repository still builds on the
  machine that runs it — the path taken where a published image is not wanted or
  not reachable.
- **ffmpeg is needed for one case only:** cue segments inside m4a/ALAC. Without
  it those tracks answer with error code 70 and everything else keeps working.
- **Some Subsonic endpoints are stubs** and say so instead of inventing an
  answer.
- Single-threaded by design — a Node process serves every client on one
  thread, so an expensive request stops the server for as long as it runs.
