# syntax=docker/dockerfile:1
#
# Trusted, deploy-agent-owned Dockerfile — never replaced by tenant input.
# The build context the agent passes alongside this file is only a
# Caddyfile this repo controls (docker/site-runtime.Caddyfile) and a
# `public/` directory of static assets that have already passed
# tar-safety's validation. Nothing here executes tenant source, a tenant
# Dockerfile, or an npm script.
#
# Hardening mirrors examples/dmpresearch/Dockerfile: pinned digest, the
# NET_BIND_SERVICE file capability stripped (port 8080 needs none, and
# keeping it conflicts with --cap-drop ALL), non-root user.
FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
RUN setcap -r /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
COPY --chown=10001:10001 public/ /srv/
USER 10001:10001
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
