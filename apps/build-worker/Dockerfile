# The Flowstarter build worker, as one image.
#
# Build context MUST be the monorepo root (pnpm workspace + catalogs):
#   docker build -f apps/build-worker/Dockerfile -t flowstarter-build-worker .
#
# WHAT THIS IMAGE IS NOT. It is not where a client's generated site is built.
# The worker runs `pnpm install && pnpm run build` for a generated site in a
# *separate, disposable* container, one per command, from
# apps/build-worker/docker/validation-runtime.Dockerfile — read-only root,
# `--network=none` for everything after the install, `--cap-drop=ALL`, one bind
# mount and no Docker socket (see apps/build-worker/src/validator.ts and
# README.md, "Validation isolation"). That is the container generated code runs
# in. This one only ever runs code from this repository.
#
# That split is the whole reason this image carries a Docker CLI and is handed
# the host's Docker socket at runtime: the worker is the *client* that asks the
# host daemon for those disposable containers. The socket is root-equivalent on
# the host, so it is a trust boundary and not a convenience — see
# deploy/hetzner-staging/build-worker/docker-compose.yml, which states it in
# the one place an operator reads before starting this.
#
# The worker is run through `tsx`, not compiled: apps/build-worker and both
# workspace packages it depends on (@flowstarter/agentic-codegen,
# @flowstarter/platform-config) publish `main` straight at their TypeScript
# sources, and `pnpm --dir apps/build-worker start` is the same command a
# developer runs. One fewer build step that can disagree with the dev loop.

ARG NODE_VERSION=22-bookworm-slim
ARG PNPM_VERSION=10.34.5
# Keep in step with the daemon on the host. Only the CLI is installed; it talks
# to /var/run/docker.sock and ships no daemon of its own.
ARG DOCKER_CLI_VERSION=27.5.1

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ── The Docker CLI ──────────────────────────────────────────────────────────
# The static tarball rather than Docker's apt repository: one file is wanted
# (`docker`), the repo would drag in containerd and a daemon this image must
# never have, and a pinned URL is easier to audit than an apt source.
FROM base AS docker-cli
ARG DOCKER_CLI_VERSION
ARG TARGETARCH=amd64
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
      -o /tmp/docker.tgz; \
    tar -xzf /tmp/docker.tgz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker.tgz /tmp/docker; \
    docker --version

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/build-worker/package.json ./apps/build-worker/package.json
COPY packages/agentic-codegen/package.json ./packages/agentic-codegen/package.json
COPY packages/platform-config/package.json ./packages/platform-config/package.json
# The transitive workspace graph for the worker, and nothing else. The app's
# own image (deploy/hetzner-staging/Dockerfile) installs `flowstarter...`; this
# one deliberately does not, so a change to the Next app cannot invalidate this
# layer or enlarge this image.
#
# --ignore-scripts: nothing in this graph needs a native addon built here, and
# the postinstall scripts in the root graph (node-gyp for bufferutil,
# msgpackr-extract) fail on a slim image with no Python and print a wall of red
# for nothing. onnxruntime-node ships prebuilds.
ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @flowstarter/build-worker...

FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
# git, because SafeGitWorktreeManager shells out to it for every job: one
# worktree per client, `git commit` per finished build, and `git init` for the
# local sites repository on first boot in local publish mode.
# ca-certificates, because every outbound call this process makes is https
# (Supabase, the model provider, flowstarter-main when it is not loopback).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=deps /app /app
COPY apps/build-worker ./apps/build-worker
COPY packages/agentic-codegen ./packages/agentic-codegen
COPY packages/platform-config ./packages/platform-config

# uid 1000, the stock `node` user, and it is load-bearing rather than hygiene.
# `resolveContainerUser` in apps/build-worker/src/isolation.ts refuses to run a
# generated build as uid 0 and defaults the disposable validation container to
# *this* process's own uid:gid, so that the build output in the bind mount is
# owned by the process that has to read it back. A root worker would have to
# name a non-root uid by hand and would still write root-owned worktrees on the
# host. Running as `node` here makes the default correct.
#
# The host's docker group is granted at runtime with compose's `group_add`
# (see deploy/hetzner-staging/build-worker/docker-compose.yml) rather than
# baked in: the gid differs per host and an image that assumed one would fail
# in a way that reads like a permissions bug.
USER node

# The worker's own HTTP surface: POST /jobs/full-site (bearer), GET /health,
# and GET /artifacts/<token>.tar.gz in local publish mode. Never published to
# the internet — the slot runs with host networking and binds loopback.
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.FLOWSTARTER_BUILD_WORKER_PORT || 8787) + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--dir", "apps/build-worker", "start"]
