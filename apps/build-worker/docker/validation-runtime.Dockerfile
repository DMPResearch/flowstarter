# syntax=docker/dockerfile:1
#
# The image generated site code is built inside.
#
# Trusted and worker-owned, never replaced by tenant input — the same rule as
# `apps/deploy-agent/docker/site-runtime.Dockerfile`, and for the same reason:
# validation is the one step that executes code an agent wrote, so the thing it
# executes inside has to be something this repository controls.
#
# What it buys over the stock `node:22-bookworm-slim` default is one thing, and
# it is the reason the file exists: the pinned pnpm is already prepared. Without
# it, corepack downloads pnpm on first use, into a corepack home that lives on
# the container's tmpfs and dies with it — so *every* command would need a
# registry, and `pnpm run build` could never run with `--network=none`. With it,
# only the install step touches the network.
#
# Build and use it:
#
#   docker build -f apps/build-worker/docker/validation-runtime.Dockerfile \
#     --build-arg PNPM_VERSION=10.29.2 \
#     -t flowstarter/build-validation:node22-pnpm10 apps/build-worker/docker
#
#   FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE=flowstarter/build-validation:node22-pnpm10
#   FLOWSTARTER_BUILD_VALIDATE_DOCKER_PNPM_BAKED=true
#
# The worker never builds this image and never pulls it with credentials: the
# Docker CLI is invoked with PATH, HOME, DOCKER_HOST and DOCKER_CONTEXT and
# nothing else, so the image has to be public or already on the host.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# Must match FLOWSTARTER_BUILD_VALIDATE_PNPM_VERSION. The package manager that
# installs tenant code is part of the trusted wrapper, not part of the build's
# input, so it is pinned here and asserted by the worker's own config.
ARG PNPM_VERSION=10.29.2

# Prepared into the image's corepack home, which is on the read-only root the
# worker runs the container with. The build's own COREPACK_HOME points at the
# tmpfs instead; this copy is the one it resolves the pinned version from.
ENV COREPACK_HOME=/opt/corepack
RUN mkdir -p "$COREPACK_HOME" \
  && corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
  && chmod -R a+rX "$COREPACK_HOME"

# The worker passes --user explicitly (its own uid:gid, so build output in the
# bind mount stays readable), and refuses to run as root either way. This is the
# fallback for a host with no uid to map.
USER node
WORKDIR /site
