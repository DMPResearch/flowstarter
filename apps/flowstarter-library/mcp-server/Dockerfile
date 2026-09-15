# The Flowstarter template library (MCP server), as one image.
#
# Build context MUST be the monorepo root, because the image carries the
# template sources from apps/flowstarter-templates as well as the server:
#   docker build -f apps/flowstarter-library/mcp-server/Dockerfile \
#     -t flowstarter-mcp .
#
# The root .dockerignore excludes apps/flowstarter-library/** (it exists for
# the app's image, which wants only the workspace's package.json and the
# Astro templates). BuildKit reads `<dockerfile>.dockerignore` in preference
# to the root one, so this build has its own beside this file rather than
# loosening the app's.
#
# WHAT THIS SERVES. `search_templates`, `list_templates`,
# `get_template_details` and `scaffold_template` over MCP's Streamable HTTP
# transport at POST /mcp, plus an unauthenticated GET /health. The discovery
# funnel's live preview route (apps/flowstarter-main/src/app/api/discovery/
# preview/live/route.ts) drives it through `FlowstarterMcpTemplateLibrary`:
# the agent searches the catalog, picks a template, and scaffolds its SOURCES
# into the workspace it then personalises. Nothing here executes a client's
# code, and nothing here writes: the whole surface is a read-only view of the
# template sources committed in this repository.
#
# ── Why this is NOT redundant with the templates baked into the app image ──
#
# deploy/hetzner-staging/Dockerfile's `templates` stage installs the same four
# templates at /srv/preview-templates and the app slot points
# FLOWSTARTER_TEMPLATE_ROOT at it. That tree supplies exactly two things to a
# preview build: the pre-installed `node_modules` the generated workspace
# symlinks to, and the `astro` binary it is compiled with
# (apps/flowstarter-main/src/lib/discovery/static-preview-build.ts). It never
# supplies the workspace's CONTENTS — those come from `scaffold_template`
# here. The two halves are the same four templates at the same commit, and
# they have to stay that way: a scaffold whose package.json disagrees with the
# node_modules the app symlinks in is a build that fails on a missing import
# for a dependency the template plainly declares. That is why the CI lane
# builds this image from the same `github.sha` as the app's, and why the four
# template directories are asserted below rather than assumed.

ARG NODE_VERSION=22-bookworm-slim

# ── Build ───────────────────────────────────────────────────────────────────
# npm, not pnpm, and deliberately: apps/flowstarter-library/mcp-server is NOT a
# pnpm workspace package (pnpm-workspace.yaml globs `apps/*`, which is its
# parent, not it) and carries its own package-lock.json. `npm ci` against that
# lock is the reproducible install; the parent Astro workspace is not needed
# here at all.
FROM node:${NODE_VERSION} AS builder
WORKDIR /app/apps/flowstarter-library/mcp-server
COPY apps/flowstarter-library/mcp-server/package.json \
     apps/flowstarter-library/mcp-server/package-lock.json ./
# --ignore-scripts: nothing in this graph needs a native addon built here.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/flowstarter-library/mcp-server/tsconfig.json ./
COPY apps/flowstarter-library/mcp-server/src ./src
# tsconfig sets `noEmitOnError: false`, so `tsc` alone would emit a running
# server out of code that does not type-check — which is how
# `@supabase/supabase-js` came to be imported by src/utils/supabase.ts without
# ever appearing in this package's dependencies (it resolved through the
# parent workspace on a developer's machine and would have been absent here).
# `--noEmitOnError` turns that class of mistake back into a failed build.
RUN ./node_modules/.bin/tsc --noEmitOnError

# ── Runtime dependencies, without the toolchain ─────────────────────────────
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app/apps/flowstarter-library/mcp-server
COPY apps/flowstarter-library/mcp-server/package.json \
     apps/flowstarter-library/mcp-server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ── Runner ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
# The path layout is load-bearing. src/config.ts resolves the template catalog
# by walking three levels up from the compiled module's own directory
# (build/ -> mcp-server -> flowstarter-library -> apps) and looking for
# `flowstarter-templates`. Keeping the monorepo's own relative shape inside
# the image is what makes that first candidate hit, rather than depending on
# the working directory a container happens to start in.
WORKDIR /app/apps/flowstarter-library/mcp-server
COPY --from=prod-deps /app/apps/flowstarter-library/mcp-server/node_modules ./node_modules
COPY --from=builder /app/apps/flowstarter-library/mcp-server/build ./build
COPY apps/flowstarter-library/mcp-server/package.json ./package.json

# The catalog. FOUR templates, named one by one rather than copied as a
# directory, and the list is the same one TEMPLATE_CATALOG in
# packages/agentic-codegen/src/workspace.ts and the app image's `templates`
# stage carry.
#
# What a wildcard would have added: `demo-coach` (the editor's dev fixture)
# and `dorin-portfolio` (legacy). Neither is a template a generated site can
# be built from, and the app image installs node_modules for neither — but
# `demo-coach` has no `catalogEnabled: false` in its config.json, so a
# directory copy would have published it through `list_templates` and the
# selection agent could have picked it. The failure that produces is a preview
# that dies at `astro build` with a missing dependency, three phases after the
# decision that caused it.
COPY apps/flowstarter-templates/creative-portfolio /app/apps/flowstarter-templates/creative-portfolio
COPY apps/flowstarter-templates/local-trade /app/apps/flowstarter-templates/local-trade
COPY apps/flowstarter-templates/professional-services /app/apps/flowstarter-templates/professional-services
COPY apps/flowstarter-templates/wellness-therapy /app/apps/flowstarter-templates/wellness-therapy

# Catalog tripwire, in the spirit of the app image's route tripwire. A
# template the build context quietly dropped would not fail this build: the
# server would start, answer /health, and simply offer a smaller catalog — and
# the visible symptom would be the selection agent picking a worse-fitting
# template for somebody's business, which nothing downstream can tell apart
# from a judgement call. So the shape of the catalog is asserted, both ways.
RUN set -eu; \
    for slug in creative-portfolio local-trade professional-services wellness-therapy; do \
      dir="/app/apps/flowstarter-templates/$slug"; \
      [ -f "$dir/config.json" ] || { \
        echo "missing template in the build context: $dir/config.json" >&2; \
        echo "Check apps/flowstarter-library/mcp-server/Dockerfile.dockerignore." >&2; \
        exit 1; \
      }; \
    done; \
    for slug in demo-coach dorin-portfolio; do \
      [ ! -d "/app/apps/flowstarter-templates/$slug" ] || { \
        echo "$slug is in this image; it is not a catalog template." >&2; \
        exit 1; \
      }; \
    done; \
    echo "catalog: four templates present, no fixtures"

# The container's own namespace, not the host's. The compose file publishes
# this on 127.0.0.1 only; see deploy/hetzner-staging/mcp/docker-compose.yml
# for why this service is the one on this box that does NOT use host
# networking.
ENV HTTP_HOST=0.0.0.0
ENV HTTP_PORT=3001

# Non-root. This process only ever reads: the template sources are baked in,
# and nothing in the request path writes to disk.
USER node

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.HTTP_PORT || 3001) + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/index.js", "--mode=http"]
