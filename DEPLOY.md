# Deploying funoteka

A self-hosted music server. It reads a directory of music, classifies it, and
serves it over the Subsonic API — the protocol every music client speaks. It has
no web interface: what a person operates it with is the admin API on its own
port, and what an agent operates it with is the same API over MCP.

This document is written to be followed **by an agent with no other context**.
It asks the questions whose answers change the steps, gives a default for each,
and then walks one path to a server that plays a track. Every command is meant to
be copied.

If something goes wrong, [Troubleshooting](#troubleshooting) lists the failures
that actually happen, with the sentences they produce.

---

## 1. What you need before starting

| | |
|---|---|
| **A machine** | Anything that runs Docker, or Linux/Windows with Node 24+. A NAS, a small VDS, or the desktop in the corner all work. |
| **A music directory** | The collection to serve. It is read, never written — nothing here ever modifies or moves your files. |
| **Two ports** | `4533` for music clients, `4534` for the admin surface. Both configurable. |
| **Docker ≥ 20** *(path A)* | Or Node ≥ 24 and ffmpeg *(path B)*. |

ffmpeg is needed for one thing: cutting cue tracks out of an `.m4a`/MP4 image.
Everything else — whole files, FLAC and mp3 segments, browsing, search, covers —
works without it, and the tracks that need it are refused with a reason. The
Docker image contains ffmpeg; a native install has to provide it.

---

## 2. Questions to answer first

Ask these in order. Each has a default, and the defaults are a working server.

| # | Question | Default | Why it matters |
|---|---|---|---|
| 1 | Which machine, and is Docker available? | Docker where it is | Docker is the main path: one command, and ffmpeg comes with it. |
| 2 | Where is the music? | — | Mounted **read-only**. |
| 3 | Where should the server keep its own files? | `./data` beside the compose file | The meta layer, the log, the cache, the config. This is the whole of what a backup takes. |
| 4 | What port for music clients? | `4533` | Clients guess this one. |
| 5 | What port for the admin surface? | `4534` | Reachable from outside by design; guarded by its own token. |
| 6 | A user name and password for listeners | — | Without both, the server refuses to start. |
| 7 | An admin token | generated below | **Without it there is no admin surface at all.** |
| 8 | Should the admin surface terminate TLS itself, or sit behind a proxy? | whatever is simpler | Either is fine; both are described in §7. |

There is a machine-readable form of these at `deploy/answers.schema.json` — an
agent that has been handed answers rather than asked for them should read that
file for the shape.

Generate the admin token (32 random bytes, URL-safe):

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

---

## 3. Path A — Docker (main path)

Works the same on a laptop, a NAS and a VDS. There is a **published image** —
`ghcr.io/kzntsv-dev/funoteka:0.1.2`, `linux/amd64` and `linux/arm64` in one
manifest — and `build: .` still builds on the machine that runs it (that is the
path where a published image is not wanted or not reachable).

With no checkout to build from, the image and four values are the whole
installation (verified by running exactly this against the published image):

```sh
MUSIC=/absolute/path/to/your/music
docker run -d --name funoteka -p 4533:4533 -p 4534:4534 \
  -e FUNOTEKA_USER=you -e FUNOTEKA_PASSWORD=change-me \
  -e FUNOTEKA_ADMIN_TOKEN=PASTE_THE_TOKEN_YOU_GENERATED \
  -e FUNOTEKA_SUPERVISED=1 -e FUNOTEKA_LOG_FILE=/data/funoteka.log \
  -v "$MUSIC":/music:ro -v funoteka-data:/data \
  --restart unless-stopped ghcr.io/kzntsv-dev/funoteka:0.1.2
```

(The token above is a placeholder with no angle brackets in it, on purpose: a
copy-paste that misses the substitution should fail to authenticate loudly rather
than carry a string that looks like a token.)

`FUNOTEKA_SUPERVISED=1` is what makes `POST /restart` a restart rather than a
stop, and the restart policy beside it is what supervises the process. The first
scan is still a command, not a startup side effect — see the end of this section.

Two things that bite on a NAS, and neither is visible from the command above:

- **The container runs as `node`, uid 1000.** A collection on a share that this
  uid cannot read scans as an empty root — the server says so rather than failing
  (`nothing here — an empty directory and a mistyped path read alike`), and the
  fix is on the host: `chown` it, grant the group, or run the container with
  `--user` set to the owner.
- **The `arm64` half of the published image is built under emulation** on an
  `amd64` machine. It runs correctly and it is not as fast as a build made on
  that box would be — for a small board this is the difference worth measuring,
  and `build: .` in a checkout on that box is the other path.

From a checkout, the same installation is the compose file:

```sh
git clone <this repository> funoteka
cd funoteka
cp .env.example .env
```

Edit `.env` — four values, and the rest can stay as they are:

```sh
MUSIC=/absolute/path/to/your/music     # read-only into the container
DATA=./data                            # everything the server owns
FUNOTEKA_USER=you
FUNOTEKA_PASSWORD=change-me
FUNOTEKA_ADMIN_TOKEN=PASTE_THE_TOKEN_YOU_GENERATED
```

Start it:

```sh
docker compose up -d
docker compose logs -f          # Ctrl-C leaves it running
```

`/health` answers as soon as the process is up, and it is meant to be reachable
without credentials:

```sh
curl http://127.0.0.1:4533/health
# {"status":"ok","server":"funoteka","version":"…","schema":…,"uptime":0.4}
```

### Tell it where the music is, and read it

The admin surface is a second port with its own token. Nothing below works
without one, and that is the point: with no token the port is not open at all.

```sh
TOKEN=<the token from .env>

curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4534/status
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4534/stats
```

Add the collection and read it. The path is the one **inside the container**
(`/music`, as the compose file mounts it):

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"path": "/music"}' http://127.0.0.1:4534/roots

curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4534/scan
# {"started":{"pid":…,"mode":"incremental","roots":["/music"]}, …}
```

A scan is a process of its own and the answer above comes back immediately —
that is what the **202** means. Watch it:

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4534/scan
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4534/scan/history
```

The server also scans by itself every six hours, never starting in the quiet
hours (03:00–06:00 by default), and it can watch the roots for changes instead
(`FUNOTEKA_SCAN_WATCH=1`) — see §8.

### Is the library there?

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4534/stats
# {"roots":1,"folders":…,"songs":…,"albums":…,"artists":…,"issues":…}
```

`songs` is what a person counts as songs. If it is `0`, the scan found nothing —
read `issues` for why, which is where every unreadable file, unmatched cue and
refused tag lands:

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4534/issues
```

### Play a track

Any Subsonic client works. To prove it without one:

```sh
curl -s "http://127.0.0.1:4533/rest/search3?u=$FUNOTEKA_USER&p=$FUNOTEKA_PASSWORD&f=json&query=&songCount=1"
# {"subsonic-response":{…,"searchResult3":{"song":[{"id":"tr-1",…}]}}}

curl -s -o /tmp/track "http://127.0.0.1:4533/rest/stream?u=$FUNOTEKA_USER&p=$FUNOTEKA_PASSWORD&id=tr-1"
file /tmp/track          # audio, and not an error document
```

That is the whole acceptance: a server answering, a library read, and bytes that
are audio. Point a client at `http://<host>:4533` with the same credentials and
it will list the collection.

### The packaging check, if you want one

```sh
node deploy/smoke.mjs http://127.0.0.1:4533 "$FUNOTEKA_USER" "$FUNOTEKA_PASSWORD"
```

Walks the acceptance checklist over HTTP — browsing, playlists, stars, ranges,
cue segments, covers, search, a refusal on wrong credentials — and prints one
line per step. `skip` means this collection has nothing to check that with,
which is a fact about the collection and not a failure.

---

## 4. Path B — native Linux (systemd)

For a machine where Docker is not wanted. Node 24 and ffmpeg must be installed.

```sh
sudo useradd --system --home /var/lib/funoteka funoteka
sudo install -Dm644 deploy/systemd/funoteka.service /etc/systemd/system/funoteka.service
sudo install -Dm600 deploy/systemd/funoteka.env.example /etc/funoteka/env
sudo editor /etc/funoteka/env        # credentials, admin token, FUNOTEKA_DB
sudo systemctl daemon-reload
sudo systemctl enable --now funoteka
```

The unit keeps the service in `/var/lib/funoteka` and nothing else; the env file
is where the secrets live, because a unit file is world-readable. Then the same
admin calls as §3 — add the root with the path **as this machine sees it**
(`/srv/music`), and scan.

## 5. Path C — native Windows (service)

**The daemon works on Windows and is in daily use** — it is how the author's own
server runs (started by a `start.cmd` that carries the `FUNOTEKA_*` variables
from §3). What has not been run end to end is the *service wrapper* below, and
its own help says so.

```powershell
# elevated PowerShell, from the checkout
.\deploy\windows\install-service.ps1 -Data 'C:\ProgramData\funoteka'
```

The script downloads WinSW (pinned, hash-checked) to wrap `node src/cli.ts
serve` as a service, writes the config file to `<Data>\funoteka.json` and the log
to `<Data>\funoteka.log`, and restricts the directory's ACL. **Edit that config
file before starting the service** — it needs a password and an admin token, and
the service reads them from there rather than from a shell.

## 6. Verify, then keep it running

| What | How | Expected |
|---|---|---|
| the process is up | `curl http://127.0.0.1:4533/health` | `{"status":"ok",…}` |
| the library was read | admin `GET /stats` | `songs` > 0 |
| a client can play | the `stream` call in §3 | audio bytes |
| the admin surface is guarded | `curl http://127.0.0.1:4534/status` with no token | `401` |
| the admin surface is off when unconfigured | unset `FUNOTEKA_ADMIN_TOKEN`, restart | connection refused, not 401 |
| the config survives a restart | `POST /config`, then `POST /restart` | the setting is still there |
| mutations are recorded | `ls <data>/funoteka.db.audit.jsonl` | one JSON line per mutation |

A restart is `POST /restart` with the admin token — it answers first and then
exits, and whatever supervises the process starts it again. Where nothing does,
it **refuses** (`409`) rather than stopping the server, and says which setting
would make it true (`FUNOTEKA_SUPERVISED=1`). The compose file and the unit set
it; a bare `serve --daemon` has nobody and should not claim otherwise.

## 7. TLS, and who may reach the admin port

The admin port is meant to be reachable from outside — that is what it is for —
and it is guarded by its token. Four locks, each a setting, each off by default
except the token:

1. **`FUNOTEKA_ADMIN_TOKEN`** — the gate. No token, no listener.
2. **`FUNOTEKA_ADMIN_ALLOW`** — comma-separated addresses and CIDR blocks
   (`10.0.0.0/8,192.0.2.0/24`). Empty means every address.
3. **A failure limit** — ten wrong tokens from one address locks that address out
   for fifteen minutes. Not configurable; the numbers are in `admin-guard.ts`.
4. **TLS** — either terminate it here:

   ```sh
   FUNOTEKA_ADMIN_TLS_CERT=/etc/funoteka/admin.crt
   FUNOTEKA_ADMIN_TLS_KEY=/etc/funoteka/admin.key
   ```

   (both or neither; a path that cannot be read stops the server at startup
   rather than on the first connection), or terminate it at a proxy and keep the
   admin port on the loopback. In the proxy case, narrow `FUNOTEKA_ADMIN_ALLOW`
   to the proxy's address and set `FUNOTEKA_ADMIN_TRUST_PROXY=1` so
   `X-Forwarded-For` is believed. That header is written by the caller: believing
   it on a port that can be reached directly means anyone can claim any address.

## 8. What it does on its own

| Setting | Default | What it does |
|---|---|---|
| `FUNOTEKA_SCAN_INTERVAL` | `360` | Minutes between scans. `0` turns the timer off, for a deployment with a cron job of its own. |
| `FUNOTEKA_SCAN_QUIET_FROM` / `_TO` | `3` / `6` | The hours a scan may not *start*. A scan that comes due inside the window waits for the end of it. A scan is audible: it reads every file. |
| `FUNOTEKA_SCAN_WATCH` | off | Watch the roots for changes instead of waiting. Waits for five seconds of silence first, so a file being copied in is never read halfway. On a network share it cannot work — the server says so in the log and falls back to the interval. |

**A file being written is not read, and does not enter the library.** A scan holds
back any file the disk has not been quiet about for five seconds — the same window
the watcher waits out — and says so in `GET /issues` as `still being written`. Held
means both halves: the run does not write the file's row, and it does not read the
file either, because the stages that follow select their work by the stamp the scan
puts on what it saw and a held file does not carry it. The rows a previous run gave
that file stay where they are, so an album does not lose a track and get it back. A
file that was *finished* before the scan began is not held: the scan waits out the
remainder of the window and looks again, so an album copied and then scanned arrives
whole. A scan that lands *while* a copy is running records everything that has
finished and leaves the file in flight to the next one.

The one case this cannot catch is a copy that pauses for longer than the window and
then resumes — over a network, where the pause is the point, and in an archive
unpacked with the mtimes it was packed with. Such a file reads as quiet and is
recorded; the next scan meets a file that has stopped and records it again. Five
seconds of quiet is a rule about waiting, not a promise about a writer.

A deployment that has just been upgraded scans when it comes up rather than after
another interval, because files read by an older reader are re-read by the
stages, and the server knows the next scan is not an ordinary one.

## 9. Backups

**The files on disk are the backup of the library.** Albums, tracks, tags, the
tree and the search index are all readings of them: a rescan rebuilds every one.
What cannot be rebuilt is what a person said, and that is what `GET /export`
writes:

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4534/export > funoteka-export.json
```

Playlists, stars, ratings, bookmarks, hand edits to the junk filter, and the api
keys — keyed by the *files* a track lives in, not by row ids, so the document
survives a rescan and a move. `POST /restore` with that document merges it back
and lists anything it could not place.

Also worth copying, and small: the config file, and the admin token.

The password and the bootstrap key are **not** in the export — a backup that
anybody can read should not be a credential. They live in the config file or the
environment.

## 10. Upgrading and rolling back

```sh
git pull
docker compose up -d --build     # or: sudo systemctl restart funoteka
```

Migrations run when the database is opened, and they only add. An older build
opening a database a newer one has migrated is **not** refused: `migrate()`
skips every migration at or below the version already stamped, and the newer
schema is a superset of the one the older build expects. So rolling the code
back is usually the whole of the rollback, and the copy of the database is for
the case where the rollback needs the old shape.

What a rollback does not undo is what a stage derived from the files. Rows carry
the method that wrote them, and a build that does not recognise a method leaves
those files alone rather than reading them again — so after rolling back, and
again after returning, run a scan before pointing clients at it.

## 11. Talking to it from an agent

The MCP server speaks on stdin and stdout and calls the admin API. It is the same
program as the CLI, and how it is started depends on how funoteka was installed:
`package.json` declares a `funoteka` bin, and the image installs no such binary,
so inside a container the script is named instead.

```sh
# a native install, with the bin on PATH (`npm link`, or `npm install -g .`)
FUNOTEKA_ADMIN_TOKEN=$TOKEN funoteka mcp

# or without installing anything: the published package, the same command
FUNOTEKA_ADMIN_TOKEN=$TOKEN npx -y funoteka mcp

# the container — the token arrives through .env, so it need not be repeated
docker compose exec -T funoteka node src/cli.ts mcp
```

The tools are `funoteka_*` — status, stats, issues, logs, config get/set, roots
list/add/remove, scan start/status/cancel/history, junk list/mark/unmark,
playlists import, export, restore, user get/set, restart — and `tools/list` is
how a client finds them. The token comes from the environment or the config file
and never from an argument: an argument is readable from the process list.

The admin port answers `/mcp` for a client that would rather use HTTP. Same
token, same audit: a mutation asked for through MCP appears in the audit file
exactly as `curl` does.

## 12. Troubleshooting

Every one of these is a sentence this server actually says.

| It says | It means |
|---|---|
| `no credentials: set FUNOTEKA_USER with FUNOTEKA_PASSWORD or FUNOTEKA_APIKEY` | The server refuses to start without a way in. Set them in `.env` or the unit's env file. |
| `funoteka: admin surface off — no FUNOTEKA_ADMIN_TOKEN` | No token, so no admin port. This is the intended state, not a fault. |
| `the admin port 4534 could not be opened (EADDRINUSE)` | Something else has the port. `FUNOTEKA_ADMIN_PORT` names it. |
| `the admin TLS certificate or key could not be read: …` | The path in the sentence. Both or neither. |
| `no roots are configured — POST /roots adds one` | A scan was asked for before the collection was added. |
| `not a directory on this machine: /music` | The path the *server* sees — inside the container, not on the host. |
| a root scans as empty, and the path in the report is `/app/C:/Program Files/Git/music` | Git Bash on Windows rewrote `/music` into a Windows path before Docker saw it. Prefix the command with `MSYS_NO_PATHCONV=1`. |
| `no such file (or segment) in this library` | A restore named a song this library does not have. The file moved, or the root is different. |
| `that is not an export document` | `POST /restore` wants the object `GET /export` answered with. |
| `funoteka.json is not JSON: …` | The config file is broken and the command stopped rather than coming up on defaults beside it. |
| `unknown key "prot" — did you mean "port"?` | A typo in the config file. It is refused, not ignored. |
| `no log file at … — carrying on without one` | The log path has no directory. The server keeps running. |
| `not watching /mnt/nas — a network path …; the interval still scans` | The watcher cannot work there, and this is the honest fallback. |
| `nothing to scan — no roots are configured` | Said once, and again if roots come and go. |

**A scan that ends with `failed`.** Read `GET /issues` and `GET /logs`. The
stages record what they could not understand rather than losing it, and the run's
own status is in `GET /scan/history`.

**A client cannot play anything.** Check the credentials first (`/rest/ping`
with them), then whether the song exists (`/rest/search3`), then the log with
`FUNOTEKA_LOG_REQUESTS=1`, which prints one line per request with the method and
the query — masked, because a client spells its password there.

## 13. Why the published package is built, and the repository is not

The repository runs its own TypeScript: `node src/cli.ts` is the program, `npm
test` is the suite, and there is no build step to run before either of them.

**The npm package cannot do that**, and the reason is a rule rather than a
preference: Node refuses to strip types from any file under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and no flag lifts it — checked on
v24.19.0 with the default, both `--experimental-strip-types` and
`--experimental-transform-types`, and the two together. A `bin` that named a `.ts`
file would install a package that cannot start.

So `npm run build` compiles `src` into `dist` for the package only
(`tsconfig.build.json`, `deploy/build.mjs`), copying the schema migrations
beside the code that reads them, and `bin` names `dist/cli.js`. Two consequences
worth knowing:

- **A fresh checkout has no `dist/`** and therefore no `funoteka` bin until the
  build runs. `npm install` in a checkout now runs it (`prepare`), so
  `npm link` from a clone works; `git clone` without an install does not.
- **The image still copies `src/`** and runs `node src/cli.ts serve` — the
  container is a checkout, and it never needs the build.
