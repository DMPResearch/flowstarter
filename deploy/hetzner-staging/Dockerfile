# Build context: monorepo root.
#   docker build -f deploy/hetzner-staging/Dockerfile -t flowstarter-main:local .
#
# Runtime: Next.js standalone (`output: 'standalone'` in next.config.mjs).
# This image is for the Hetzner *platform* staging slots only. Client sites
# still go through deploy-agent → /var/www/sites.

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

FROM base AS builder
COPY --from=deps /app /app
COPY apps/flowstarter-main ./apps/flowstarter-main
COPY apps/build-worker ./apps/build-worker
COPY packages ./packages
# Library previews are optional for staging liveness; skip the Astro prebuild
# to keep CI images cheaper. Public/preview can be empty.
WORKDIR /app
ENV NODE_ENV=production
# NEXT_PUBLIC_* are inlined into the client bundle at build time, so these
# ARGs must always carry the STAGING Supabase CLI stack's values: the
# loopback URL (http://127.0.0.1:54321) and the CLI's demo anon key. They
# must never carry the production project's values. staging-deploy.yml and
# staging-pr-deploy.yml pass them from vars.STAGING_SUPABASE_URL and
# secrets.STAGING_SUPABASE_ANON_KEY, and refuse to fall back to the
# production NEXT_PUBLIC_SUPABASE_* secrets.
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
