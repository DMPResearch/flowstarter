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
# Pull the transitive workspace graph for flowstarter-main.
RUN pnpm install --frozen-lockfile --filter flowstarter...

# ── Library previews ────────────────────────────────────────────────────────
# The /library pages iframe `/preview/<slug>/`, which is static Astro output
# under apps/flowstarter-main/public/preview. Staging can live without it (the
# iframes are the only thing that breaks), so the staging lanes leave
# BUILD_LIBRARY_PREVIEWS false and keep their images cheap. Production cannot:
# the library is part of the public marketing site, so release.yml passes
# BUILD_LIBRARY_PREVIEWS=true.
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
RUN pnpm --filter flowstarter build

FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# Monorepo standalone layout: server lives under apps/flowstarter-main.
COPY --from=builder /app/apps/flowstarter-main/.next/standalone ./
COPY --from=builder /app/apps/flowstarter-main/.next/static ./apps/flowstarter-main/.next/static
COPY --from=builder /app/apps/flowstarter-main/public ./apps/flowstarter-main/public

WORKDIR /app/apps/flowstarter-main
EXPOSE 3000
# $PORT is overridden per slot by docker-compose.yml (network_mode: host, one
# port per slot on the shared host network namespace), so the healthcheck
# must read it at run time rather than assume 3000.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
