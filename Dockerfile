# funoteka in a container: the server, its meta layer's directory, and the one
# binary it cannot do without.
#
# **Why a container is the main deployment path.** This server has no runtime
# dependencies — Node 24 carries SQLite and FTS5, `node:sqlite`, and this project
# runs its own TypeScript with no build step — so the only thing standing between
# a machine and a working funoteka is *ffmpeg*, which only the cue tracks inside
# an m4a/MP4 container need and which is a different install on every platform.
# A container is how that becomes one command everywhere, on a NAS, a VDS and a
# laptop alike, and multi-arch so the same command works on an amd64 box and on
# the arm64 board in the cupboard.
#
# The native path (`deploy/systemd`, `deploy/windows`) exists for machines where
# Docker is not wanted, and the two are the same program with the same flags.

FROM node:24-alpine

# ffmpeg, and nothing else. Every other capability this server has is in Node
# itself or in this repository.
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copied as a whole rather than one file per layer: there is no build step and no
# dependency install, so there is nothing to cache between them — the image is
# the sources and the runtime.
COPY package.json ./
COPY src ./src
COPY deploy ./deploy

# One directory for everything this deployment owns: the meta layer, its cached
# re-encodes, the log file and the config file, if any. Mounted as a volume, and
# the whole of what a backup has to take.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Not root. The server writes one directory and reads a collection; neither needs
# a privileged user, and the container is the one place where the uid is easy to
# get right for good.
USER node

ENV FUNOTEKA_DB=/data/funoteka.db \
    FUNOTEKA_HOST=0.0.0.0 \
    FUNOTEKA_PORT=4533 \
    FUNOTEKA_ADMIN_PORT=4534 \
    FUNOTEKA_FFMPEG=ffmpeg

# The API, and the admin port beside it. Both are published on purpose: the
# admin surface is reached from outside the container by design, and it is
# guarded by its own token rather than by not being reachable.
EXPOSE 4533 4534

# `/health` through Node's own fetch, so the check needs no curl in the image.
# It reads FUNOTEKA_PORT rather than assuming 4533, because an operator who moved
# the port must not get a container that is healthy only in its own opinion.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FUNOTEKA_PORT||'4533')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No `--daemon`: in a container this process *is* the service, and a daemon that
# forks would leave the supervisor watching a parent that is already gone.
# `FUNOTEKA_SUPERVISED=1` is set in the compose file, because that is the file
# that knows whether a restart policy is in place.
CMD ["node", "src/cli.ts", "serve"]
