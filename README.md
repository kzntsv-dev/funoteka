# funoteka

**The Subsonic server a real collection deserves.**

**A folder is an album** — not a guess, not a heuristic: the rule. funoteka keys every record on
its folder path, so three pressings of the same album stay three albums, a box stays a box and its
discs, and an image file with a cue sheet becomes real, playable tracks. Nothing merged, nothing lost.

- **An image file and its cue sheet become real tracks** — cut exactly where the cue's `INDEX`
  says, at the frame it names.
- **A folder is an album.** Three pressings stay three; a box set stays a box set *and* its
  disc-albums. Tags are metadata, never the identity.
- **Every format your collection actually has** — FLAC, ALAC, MP3, Ogg Vorbis, Opus — plus
  **transcoding**, so a client that cannot play one still can.
- **Your files are never modified.** Classification, cue boundaries, encodings, dedup — all of it
  lives in a meta layer beside the server. Point it at your disk; your disk stays as it is.
- **No LLM, no Discogs, no Last.fm, no external service.** The core reads what is in your files and
  folders. Enrichment is possible later, and it is optional.
- **An agent installs, configures and runs it.** Hand your agent `DEPLOY.md`.

A complete **Subsonic / OpenSubsonic** surface, filled from your own files wherever it can be and
answered honestly and empty wherever it cannot — so the client you already like just works.

## Why the folder wins

Three CD pressings of one album are three different records, and a box set is not one CD. Because
funoteka keys the album on its **path**, that is exactly what you get:

```
Cure, The/Pictures Of You [1989 UK CD]/   ← one album
Cure, The/Pictures Of You [1990 US CD]/   ← another album
Cure, The/Disintegration (Box, 12 CD)/    ← the box, and each disc inside it
```

Three albums, a box set of twelve discs. No merging, no guessing, nothing lost.

## What it does

| | |
|---|---|
| **Identity** | the absolute folder path — not the tag |
| **Cue sheets** | image + cue → real tracks; several `.cue` in one folder, `INDEX 00`, `mm:ss:ff`, per-track performer |
| **Box sets** | a release *and* its disc-albums |
| **Encodings** | CP1251, UTF-16, ID3v1/v2, Vorbis, MP4 — normalised in the meta layer, files untouched |
| **Rescan** | incremental by mtime/size; a timer, an optional filesystem watcher, or your own scheduler |
| **Junk** | releaser debris and fake folders are marked and hidden from the default view — never deleted |
| **Library** | playlists (server-side and `.m3u`), stars and ratings, play history, play queue, bookmarks, offline download |
| **Clients** | the Subsonic API + OpenSubsonic extensions; everything else answers with honest, well-formed empty responses — never a 404 |
| **Management** | an admin API on its own port, and an **MCP server** — an agent can run the whole thing |

## Install

### Docker — the main path

The image carries everything, **ffmpeg included** — the only external binary the server ever wants,
and only for cue tracks inside an m4a/MP4 container.

```sh
git clone https://github.com/kzntsv-dev/funoteka && cd funoteka
cp .env.example .env        # your music folder, a password, an admin token
docker compose up -d
docker compose exec funoteka node src/cli.ts scan /music   # fill the library, once
```

> **On Windows with Git Bash**, prefix that last line with `MSYS_NO_PATHCONV=1`. The shell
> rewrites `/music` into a Windows path before Docker ever sees it, and the scan then answers
> honestly about an empty root — `/app/C:/Program Files/Git/music` — which reads like a broken
> image and is really the shell.

### Or let your agent do it

> **Give `DEPLOY.md` to your agent.** It asks the questions that matter — where the music is, where
> to keep the database, which ports, TLS or a reverse proxy, a password — and does the rest. Local
> machine, NAS, VDS: the guide covers all three.

### Native, without Docker

Needs **Node 24+**. There are **no runtime dependencies** — Node carries SQLite, FTS5 and the
TypeScript runtime, and there is no build step (TypeScript is a dev-time tool only). `ffmpeg` on the
PATH is needed only for cue tracks inside an m4a/MP4 container.

```sh
npm install -g funoteka
funoteka scan /path/to/music     # build the library
funoteka serve --daemon          # serve it
```

## Quick start

1. Start the server. It listens on **4533**.
2. Install any Subsonic client — Symfonium, Feishin, Substreamer, or whatever you already use.
3. Point it at `http://your-host:4533`, with the login and password you set.
4. Browse and play.

You see the disk as it should have looked all along: artists, albums, box sets, and cue tracks that
are tracks.

## How it works

```
your folders ─► scanner ─► classifier ─► meta layer (SQLite) ─► Subsonic API ─► any client
                   │           │                 ▲
             cue engine   folder identity   admin API · MCP
```

The scanner **reads**. Everything it learns — what is an album, where a cue track starts, what an
encoding was — goes into a SQLite database it owns, beside the server. Change your mind about a
classification and you edit that layer, not your music.

## Compatibility

- **Subsonic 1.16.1** — the standard surface.
- **OpenSubsonic** — `getArtistInfo2`, genres, `getAlbumList2` by year and genre, embedded cover
  art, Ogg and ID3 readers, transcoding, and the extension manifest (`getOpenSubsonicExtensions`
  declares exactly what works — nothing more).
- What the server does not source from your own files — lyrics, similar artists, top songs, bios —
  is answered **honestly and empty**, so no client breaks on it.

## What it is not

- **Not a web player.** It is headless: no UI, no dashboard. You drive it with the admin API or MCP,
  and the music reaches you through the Subsonic client you already like.
- **Not tag-driven.** It will not merge your pressings, rename your artists to match an online
  database, or call home. Nothing about your collection leaves the machine.
- **Not overclaiming.** Where a thing does not exist yet — a published cross-build, say — the docs
  say so instead of pretending.

## Documentation

- `DEPLOY.md` — install, configure and manage, written to be read by an agent
- The admin API and the MCP server — `DEPLOY.md` §11

## License

MIT © Victor Kuznetsov. Use it, fork it, ship it.
