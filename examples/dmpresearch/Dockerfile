# syntax=docker/dockerfile:1
# Build from examples/dmpresearch. Update pinned digests with dependency updates.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /site
COPY site/package.json site/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY site/ ./

# These values are PUBLIC and become browser JavaScript. Never pass a secret key.
ARG PUBLIC_SUPABASE_URL
ARG PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG PUBLIC_TENANT_ID
ENV PUBLIC_SUPABASE_URL=$PUBLIC_SUPABASE_URL \
    PUBLIC_SUPABASE_PUBLISHABLE_KEY=$PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    PUBLIC_TENANT_ID=$PUBLIC_TENANT_ID \
    ASTRO_TELEMETRY_DISABLED=1
RUN npm run build

FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS runtime
# The upstream binary requests NET_BIND_SERVICE. Port 8080 needs none, and
# retaining that file capability conflicts with Compose's cap_drop: ALL.
RUN setcap -r /usr/bin/caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build --chown=10001:10001 /site/dist/ /srv/
USER 10001:10001
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
