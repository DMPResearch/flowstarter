# Build context: monorepo root.
#   docker build -f deploy/hetzner-staging/Dockerfile -t flowstarter-main:local .
#
# Runtime: Next.js standalone (`output: 'standalone'` in next.config.mjs).
# This image serves every Hetzner *platform* slot: staging (`main`, `pr-N`) and
# production (`prod`). Client sites still go through deploy-agent →
# /var/www/sites.

ARG NODE_VERSION=22-bookworm-slim
ARG PNPM_VERSION=10.34.5

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/flowstarter-main/package.json ./apps/flowstarter-main/package.json
COPY apps/build-worker/package.json ./apps/build-worker/package.json
COPY packages/agentic-codegen/package.json ./packages/agentic-codegen/package.json
COPY packages/daytona-utils/package.json ./packages/daytona-utils/package.json
COPY packages/flow-design-system/package.json ./packages/flow-design-system/package.json
COPY packages/platform-config/package.json ./packages/platform-config/package.json
# The acceptable-use gate's embedding tier. The `--filter flowstarter...`
# install below resolves flowstarter-main's dependencies, so their manifests
# have to be here; the sources arrive with `COPY packages` in the builder
# stage, where flowstarter-main's `prebuild` compiles them.
COPY packages/sigma-core/package.json ./packages/sigma-core/package.json
COPY packages/sigma-flowstarter/package.json ./packages/sigma-flowstarter/package.json
# Pull the transitive workspace graph for flowstarter-main.
RUN pnpm install --frozen-lockfile --filter flowstarter...

# ── Library previews ────────────────────────────────────────────────────────
# The /library pages iframe `/preview/<slug>/`, which is static Astro output
# under apps/flowstarter-main/public/preview. It is gitignored and exists only
# when this stage builds it.
#
# ALL THREE LANES pass BUILD_LIBRARY_PREVIEWS=true: release.yml, and both
# staging lanes. Staging used to leave it false to keep PR images cheap, on the
# reasoning that "the iframes are the only thing that breaks". Two things were
# wrong with that. A slot with empty iframes is not a rehearsal of production,
# so the one environment meant to catch what production would show was the one
# environment that could not show it. And `e2e/templates-audit.spec.ts` asserts
# every template with `hasPreview: true` returns 2xx at `/preview/<slug>/`,
# which no staging slot could ever satisfy — it only looked green while the
# smoke lane was skipping for want of a healthy slot.
#
# The ARG still defaults to false so a bare `docker build` stays cheap; the
# lanes are explicit about wanting previews.
#
# It is a stage of its own so the extra `pnpm install` cannot disturb the
# node_modules the app build depends on; the builder copies only the finished
# static output out of it.
#
# The templates under apps/flowstarter-library/templates are NOT workspace
# packages (pnpm-workspace.yaml globs `apps/*`, not `apps/*/templates/*`), so
# `pnpm run build` inside one sees the template's own node_modules and the
# workspace root's, and neither has `astro`. The dependency that does is
# apps/flowstarter-library's, which is why that bin directory is put on PATH
# explicitly rather than left to pnpm's lookup.
#
# --ignore-scripts: an Astro build needs no native addon, and the postinstall
# scripts in the root graph (node-gyp for bufferutil, msgpackr-extract) fail on
# a slim image with no Python and print a wall of red for nothing. The browser
# downloads are suppressed for the same reason.
FROM base AS previews
ARG BUILD_LIBRARY_PREVIEWS=false
ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PATH=/app/apps/flowstarter-library/node_modules/.bin:$PATH
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/flowstarter-library/package.json ./apps/flowstarter-library/package.json
COPY apps/flowstarter-library/templates ./apps/flowstarter-library/templates
COPY apps/flowstarter-main/scripts/build-library-previews.mjs ./apps/flowstarter-main/scripts/build-library-previews.mjs
RUN mkdir -p apps/flowstarter-main/public/preview && \
    if [ "$BUILD_LIBRARY_PREVIEWS" = "true" ]; then \
      pnpm install --frozen-lockfile --ignore-scripts --filter @flowstarter/library && \
      node apps/flowstarter-main/scripts/build-library-previews.mjs && \
      test -n "$(ls -A apps/flowstarter-main/public/preview)"; \
    else \
      echo "BUILD_LIBRARY_PREVIEWS is not true; public/preview stays empty."; \
    fi

# ── Preview templates ────────────────────────────────────────────────────────
# The discovery funnel builds a generated preview with the same fixed
# `astro build` apps/build-worker runs for a paid site (see
# apps/flowstarter-main/src/lib/discovery/static-preview-build.ts). That code
# never runs `pnpm install` itself — it copies a generated workspace into a
# scratch dir and symlinks `node_modules` in from
# FLOWSTARTER_TEMPLATE_ROOT/<template>/node_modules. Before this stage the
# runner shipped no templates at all (apps/flowstarter-templates is excluded
# from the build context; see .dockerignore) and their node_modules didn't
# exist anywhere in the image, so every platform preview failed here even
# though the exact same build worked in CI and on a dev laptop.
#
# Only the four templates a generated site can actually be built from ship:
# creative-portfolio, local-trade, professional-services, wellness-therapy —
# TEMPLATE_CATALOG in packages/agentic-codegen/src/workspace.ts. dorin-portfolio
# is legacy (superseded by creative-portfolio, kept only for
# apps/flowstarter-library's own iframe preview above) and demo-coach is the
# editor's own dev fixture; neither is reachable from the funnel, so neither
# earns space in a production image.
#
# One `pnpm install --filter` across all four rather than four separate
# `pnpm deploy` runs: they share a single `astro` version, so pnpm's
# content-addressed store pays for that dependency tree once regardless of
# how many of the four templates resolve it. Four independent deploys would
# have paid for it four times over — measured at ~670MB for astro alone.
#
# --prod: astro is these templates' only dependency, so this changes nothing
# about it, but keeps the rule identical to the `previews` stage above.
# --ignore-scripts: same reasoning as `previews` — no native addon here
# either, and this image has no Python to build one against.
#
# WORKDIR of its own, not the `base` stage's inherited /app: pnpm writes each
# CLI's `.bin/astro` as a real shell shim with the `../../..` climb back to
# its content-addressed store computed textually, from the package's depth
# under whatever directory `pnpm install` ran in — not as a symlink, and not
# re-derived later. `node`'s own loader then resolves that shim's target path
# with plain string arithmetic (`path.resolve`, which never touches the
# filesystem or follows a symlink) before it ever opens a file. So the
# instant this layer's `apps/flowstarter-templates` sits at a different depth
# than it did during install — merged into the runner's own /app alongside
# the standalone build's unrelated node_modules, say — that shim silently
# resolves to the wrong absolute path and `astro build` dies with a
# MODULE_NOT_FOUND for a path that was never real anywhere (verified with
# `docker build --target templates` on 2026-09-13; moving the installed tree
# a single directory deeper than this reproduces it every time). Copying this
# whole stage into the runner at the identical absolute path it was installed
# at (see the runner stage below) is what keeps that arithmetic valid, and is
# the actual reason this lands under /srv rather than under the runner's own
# /app — not merely to dodge a same-name-package collision with the
# standalone output, though it does that too.
FROM base AS templates
WORKDIR /srv/preview-templates
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/flowstarter-templates/creative-portfolio/package.json ./apps/flowstarter-templates/creative-portfolio/package.json
COPY apps/flowstarter-templates/local-trade/package.json ./apps/flowstarter-templates/local-trade/package.json
COPY apps/flowstarter-templates/professional-services/package.json ./apps/flowstarter-templates/professional-services/package.json
COPY apps/flowstarter-templates/wellness-therapy/package.json ./apps/flowstarter-templates/wellness-therapy/package.json
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter @flowstarter/template-creative-portfolio \
      --filter @flowstarter/template-local-trade \
      --filter @flowstarter/template-professional-services \
      --filter @flowstarter/template-wellness-therapy
# The rest of each template's own source (components, content, public
# assets). node_modules from the install above is untouched by this COPY:
# .dockerignore strips node_modules out of the build context entirely, so
# there is nothing here to overwrite it with.
COPY apps/flowstarter-templates/creative-portfolio ./apps/flowstarter-templates/creative-portfolio
COPY apps/flowstarter-templates/local-trade ./apps/flowstarter-templates/local-trade
COPY apps/flowstarter-templates/professional-services ./apps/flowstarter-templates/professional-services
COPY apps/flowstarter-templates/wellness-therapy ./apps/flowstarter-templates/wellness-therapy

# ── Sigma model ──────────────────────────────────────────────────────────
# The sigma classifier (@flowstarter/sigma-flowstarter, warmed once at
# startup by src/instrumentation.ts, see src/lib/sigma/warm.ts) needs the
# pinned multilingual-e5-small ONNX encoder on disk before that warm-up can
# succeed. packages/sigma-core/src/encoder.ts sets `allowRemoteModels=false`
# at runtime on purpose, so a cache miss there is a startup warning and a
# `sigma: missing` health field, never an outbound request made from inside
# a visitor's request — which means the fetch has to happen here, at build
# time, or not at all.
#
# fetch-model.mjs depends on nothing but Node's own fetch/crypto/fs/path, so
# this stage needs neither `pnpm install` nor the `deps` stage's
# node_modules — only the script and the config it reads. It verifies every
# file's sha256 against packages/sigma-core/config/encoder.json itself (see
# that file's `_comment`) and exits non-zero on a mismatch, so a mirror
# serving different weights fails this stage rather than silently shipping
# an encoder every calibrated cosine in packages/sigma-flowstarter/models
# was never built against. The `test -s` after it is a second, cheaper
# tripwire against the one failure mode sha256 checking can't catch on its
# own: fetch-model.mjs succeeding having fetched nothing at all because
# config/encoder.json's file list came in empty.
#
# Cached at a fixed path outside /app (not under the `deps`/`builder`
# node_modules tree) so it survives independently of however `next build`'s
# output-file-tracing lays out `.next/standalone`'s own node_modules, and so
# the runner stage and a developer's own Mac dev stack
# (apps/flowstarter-main/README.md) can agree on one env var,
# SIGMA_MODEL_CACHE_DIR, pointing at it.
FROM base AS sigma-model
COPY packages/sigma-core/scripts ./packages/sigma-core/scripts
COPY packages/sigma-core/config ./packages/sigma-core/config
ENV SIGMA_MODEL_CACHE_DIR=/opt/flowstarter/sigma-model-cache
RUN node packages/sigma-core/scripts/fetch-model.mjs && \
    test -s /opt/flowstarter/sigma-model-cache/Xenova/multilingual-e5-small/onnx/model_quantized.onnx

FROM base AS builder
COPY --from=deps /app /app
COPY apps/flowstarter-main ./apps/flowstarter-main
COPY apps/build-worker ./apps/build-worker
COPY packages ./packages
# Empty when BUILD_LIBRARY_PREVIEWS was false, which is what staging wants.
COPY --from=previews /app/apps/flowstarter-main/public/preview ./apps/flowstarter-main/public/preview
WORKDIR /app
ENV NODE_ENV=production
# NEXT_PUBLIC_* are inlined into the client bundle at build time, so the value
# passed here decides which database the shipped bundle talks to, and the lane
# that builds the image is what keeps the two apart:
#   staging-deploy.yml / staging-pr-deploy.yml pass the STAGING Supabase CLI
#   stack's values (loopback URL, the CLI's demo anon key) from
#   vars.STAGING_SUPABASE_URL / secrets.STAGING_SUPABASE_ANON_KEY, and refuse
#   to fall back to anything hosted.
#   release.yml passes the PRODUCTION values from secrets.PROD_NEXT_PUBLIC_*,
#   and refuses to build production against a loopback URL.
# Neither lane may borrow the other's values.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SITE_URL=https://staging.flowstarter.dev
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
# apps/flowstarter-main depends on @flowstarter/sigma-flowstarter, whose
# package.json points main/types/exports at dist/ (#167) — that dist/ has
# to exist before `next build` can resolve it at all. This one command
# builds both: sigma-flowstarter's own `build` script carries a `prebuild`
# hook that builds @flowstarter/sigma-core first.
RUN pnpm --filter @flowstarter/sigma-flowstarter build
RUN pnpm --filter flowstarter build

# ── Sigma runtime dependency closure ────────────────────────────────────
# Despite the dist/ build above making both sigma packages ordinary,
# untranspiled, serverExternalPackages-listed external packages,
# `.next/standalone` still does not reliably carry them (or
# @huggingface/transformers, onnxruntime-node/-common, sharp) into a form
# the running container can actually use — two independent gaps, both
# reproduced and explained in full in deploy/hetzner-staging/README.md,
# "Shipping the sigma model": the packages are sometimes simply absent
# (tracing never follows the edge that reaches them), and even when their
# files ARE present, Turbopack's production "external module" loader
# resolves some of their own native dependencies against a pnpm
# virtual-store path baked in AT BUILD TIME rather than wherever the files
# land at runtime.
#
# deploy/hetzner-staging/scripts/stage-sigma-runtime.mjs does not trust
# tracing for any of this: it copies the real, complete files for the whole
# chain to a flat top-level location AND, for every leaf npm package, a
# second copy mirrored at the exact pnpm-store-shaped path Turbopack's
# baked-in resolution actually reads — see that script's own doc comment
# for the mechanics, and the README section above for how each failure
# mode was found.
FROM builder AS sigma-runtime-deps
COPY deploy/hetzner-staging/scripts/stage-sigma-runtime.mjs ./deploy/hetzner-staging/scripts/stage-sigma-runtime.mjs
RUN node deploy/hetzner-staging/scripts/stage-sigma-runtime.mjs \
      apps/flowstarter-main/package.json \
      /opt/flowstarter/sigma-runtime-deps

FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# /api/health reports this as `commit`, which is what
# .github/scripts/wait-for-staging-slot.sh waits to match before treating a
# slot as ready -- health alone cannot tell a slot still serving the previous
# commit (while a new container builds and deploys underneath it) apart from
# one already running the commit under test. The Depot workflows pass this as
# the git SHA they tag the image with. deploy-slot.sh independently sets the
# same-named env var at deploy time, derived from that image tag, which is
# what actually takes effect for an already-built image (no rebuild needed);
# this ARG only matters for a `docker run`/`docker build` done outside that
# script. Never required: apps/flowstarter-main/src/lib/build-commit.ts omits
# the field rather than fail health when it is unset.
ARG FLOWSTARTER_BUILD_COMMIT
ENV FLOWSTARTER_BUILD_COMMIT=$FLOWSTARTER_BUILD_COMMIT
WORKDIR /app

# Monorepo standalone layout: server lives under apps/flowstarter-main.
COPY --from=builder /app/apps/flowstarter-main/.next/standalone ./
COPY --from=builder /app/apps/flowstarter-main/.next/static ./apps/flowstarter-main/.next/static
COPY --from=builder /app/apps/flowstarter-main/public ./apps/flowstarter-main/public

# The sigma model, fetched and sha256-verified at build time by the
# `sigma-model` stage above (see its comment). `--chown=node:node` so the
# `node` user this stage runs as (below) can read it; nothing here ever
# needs to write to it. SIGMA_MODEL_CACHE_DIR matches what
# packages/sigma-core/src/artifacts.ts reads, so `warmSigma()`
# (src/instrumentation.ts, via src/lib/sigma/warm.ts) finds it with no
# network call and no dependence on where `next build` happened to put
# `.next/standalone`'s own node_modules.
COPY --from=sigma-model --chown=node:node /opt/flowstarter/sigma-model-cache /opt/flowstarter/sigma-model-cache
ENV SIGMA_MODEL_CACHE_DIR=/opt/flowstarter/sigma-model-cache

# The sigma classifier's runtime dependency chain (@flowstarter/sigma-
# flowstarter, @flowstarter/sigma-core, @huggingface/transformers,
# onnxruntime-node/onnxruntime-common), flattened at build time by the
# `sigma-runtime-deps` stage above — see its comment and
# deploy/hetzner-staging/scripts/stage-sigma-runtime.mjs for why tracing
# alone cannot be trusted for this edge. The trailing `/.` on the source
# merges into this stage's existing (Next-traced) node_modules rather than
# replacing it, the same merge semantics the templates COPY below relies
# on.
COPY --from=sigma-runtime-deps --chown=node:node /opt/flowstarter/sigma-runtime-deps/node_modules/. ./node_modules/

# Both sigma packages compute their own asset roots (config/, models/) from
# `import.meta.url` at module-load time (packages/sigma-core/src/
# artifacts.ts's CORE_ROOT, packages/sigma-flowstarter/src/config.ts's
# PACKAGE_ROOT) — ordinarily fine, except Turbopack's production chunk for
# an "external" package apparently still inlines that computation against
# wherever the package sat AT BUILD TIME (`/app/packages/sigma-flowstarter`
# in the `builder` stage), not wherever its files actually end up at
# runtime. Verified 2026-09-15 with process.stdout.write diagnostics added
# temporarily to warmSigmaOrWarn() (console.log/.warn are stripped in
# production — see src/lib/sigma/warm.ts's own doc comment): the real error
# was `ENOENT ... /app/packages/sigma-flowstarter/models/centroids.json` —
# a path that only ever existed in the `builder` stage, never in this one.
# Both root
# computations already support an env override for exactly this kind of
# case; pointing them at where the `sigma-runtime-deps` stage staged the
# real package content (COPY above) sidesteps the baked-in path entirely,
# the same way SIGMA_MODEL_CACHE_DIR sidesteps trusting `next build`'s
# tracing for the model cache.
ENV SIGMA_CORE_ROOT=/app/node_modules/@flowstarter/sigma-core
ENV SIGMA_FLOWSTARTER_ROOT=/app/node_modules/@flowstarter/sigma-flowstarter

# The templates stage's own WORKDIR, copied in at the identical absolute
# path it was installed at (see that stage's comment for why the path must
# not move — a relocated `pnpm install` output is not just a style choice)
# and not merged into this stage's own /app for a second reason on top of
# that: the standalone copy above already put its own pruned node_modules at
# /app/node_modules, real files traced out of the Next build rather than
# pnpm's symlinks into a content-addressed store, and a same-named package
# resolved to a different version between the two graphs would let whichever
# COPY ran last silently win the collision. `--link`: a ~670MB layer is worth
# letting BuildKit fetch independently of the layers above it.
COPY --from=templates --link /srv/preview-templates /srv/preview-templates
# apps/flowstarter-main/src/lib/discovery/static-preview-build.ts (and the
# local-preview fallback beside it) read this to find each template's
# pre-installed node_modules. Not left to that code's own default
# (`resolve(process.cwd(), '../flowstarter-templates')`, which would resolve
# under /app/apps and find nothing there) because the path above is fixed by
# the `pnpm install` that built it, not by this image's WORKDIR.
ENV FLOWSTARTER_TEMPLATE_ROOT=/srv/preview-templates/apps/flowstarter-templates

# Astro's build calls into Vite, and Vite pre-bundles dependencies into a
# `node_modules/.vite` cache it creates itself the first time anything asks
# for it — it is not optional and there is no flag that turns it off, so a
# strictly read-only template breaks `astro build` outright (verified with
# `docker build --target templates` on 2026-09-13: EACCES creating
# node_modules/.vite/deps_temp_*). The four `chown` targets below are each
# template's own top-level node_modules DIRECTORY ENTRY only — not
# recursive, so the symlinks inside it that point at the real dependency
# code keep the ownership they already have. That is deliberate: the actual
# astro/vite source under node_modules/.pnpm stays root-owned and
# unwritable, which is the thing worth protecting from a generated site's
# build; a directory entry that can hold nothing but a disposable cache is
# not. All previews built from the same template share one cache directory,
# same as they already share one node_modules — no worse than what this
# layer already asks the four templates to live with.
RUN chown node:node \
      /srv/preview-templates/apps/flowstarter-templates/creative-portfolio/node_modules \
      /srv/preview-templates/apps/flowstarter-templates/local-trade/node_modules \
      /srv/preview-templates/apps/flowstarter-templates/professional-services/node_modules \
      /srv/preview-templates/apps/flowstarter-templates/wellness-therapy/node_modules

# node:${NODE_VERSION} ships uid 1000 as `node` (the same convention
# apps/build-worker/src/isolation.ts assumes for the build container). Every
# file above was laid down by root during the build; running as `node` means
# a preview build that got its own fixed `astro build` command wrong still
# cannot write anywhere under /srv/preview-templates or /app beyond the four
# cache directories just handed to it — the funnel's build itself writes the
# generated site's own copy into the OS temp dir (os.tmpdir(), see
# static-preview-build.ts's PREVIEW_BUILD_PARENT), which needs no ownership
# change here because /tmp is world-writable already.
USER node

WORKDIR /app/apps/flowstarter-main
EXPOSE 3000
# $PORT is overridden per slot by docker-compose.yml (network_mode: host, one
# port per slot on the shared host network namespace), so the healthcheck
# must read it at run time rather than assume 3000.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
