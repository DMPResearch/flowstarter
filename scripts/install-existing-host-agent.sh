#!/usr/bin/env bash
# Run on an existing Ubuntu host after installing Docker and Caddy.
# Usage: sudo bash install-existing-host-agent.sh BUNDLE_DIR PREVIEW_SUFFIX
# Bundle: flowstarter-deploy-agent (Linux binary), deploy-agent.env,
# preview-deploy-agent.env. Env files contain distinct private bearer tokens.
# This installs the platform agent, never a generated customer site.
set -euo pipefail
bundle="${1:?bundle directory required}"
suffix="${2:?preview hostname suffix required}"
[[ "$EUID" == 0 ]] || { echo 'Run as root' >&2; exit 1; }
[[ "$suffix" =~ ^[a-z0-9]+([.-][a-z0-9]+)+$ ]] || exit 1
command -v docker >/dev/null
command -v caddy >/dev/null
for required in flowstarter-deploy-agent deploy-agent.env preview-deploy-agent.env; do
  test -f "$bundle/$required"
done

install -d -m 0755 /etc/flowstarter /etc/caddy/sites /etc/caddy/platform \
  /etc/caddy/previews/sites /var/www/sites /var/www/previews
install -m 0755 "$bundle/flowstarter-deploy-agent" /usr/local/bin/flowstarter-deploy-agent.next
mv /usr/local/bin/flowstarter-deploy-agent.next /usr/local/bin/flowstarter-deploy-agent
install -m 0600 "$bundle/deploy-agent.env" /etc/flowstarter/deploy-agent.env
install -m 0600 "$bundle/preview-deploy-agent.env" /etc/flowstarter/preview-deploy-agent.env

cat > /etc/caddy/previews/Caddyfile <<'CADDY'
{
  admin 127.0.0.1:2020
  auto_https off
  default_bind 127.0.0.1
  http_port 9080
}
import /etc/caddy/previews/sites/*.caddy
CADDY
cat > /etc/systemd/system/caddy-previews.service <<'UNIT'
[Unit]
Description=Flowstarter preview ingress
After=network-online.target
Wants=network-online.target
[Service]
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --config /etc/caddy/previews/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/previews/Caddyfile --address 127.0.0.1:2020 --force
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

for mode in sites previews; do
  unit=flowstarter-deploy-agent
  envfile=deploy-agent.env
  if [[ "$mode" == previews ]]; then
    unit=flowstarter-preview-deploy-agent
    envfile=preview-deploy-agent.env
  fi
  cat > "/etc/systemd/system/$unit.service" <<UNIT
[Unit]
Description=Flowstarter deployment agent ($mode)
After=network-online.target docker.service
Requires=docker.service
[Service]
EnvironmentFile=/etc/flowstarter/$envfile
ExecStart=/usr/local/bin/flowstarter-deploy-agent
Restart=on-failure
RestartSec=3
UMask=0022
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
done

# Preserve existing platform vhosts. Add only a managed preview front door.
# Ask restricts certificate issuance to previews registered by the agent.
backup=$(mktemp /etc/caddy/Caddyfile.before-flowstarter.XXXXXX)
cp /etc/caddy/Caddyfile "$backup"
python3 - <<'PY'
from pathlib import Path
p = Path('/etc/caddy/Caddyfile')
s = p.read_text()
marker = 'import /etc/caddy/flowstarter-preview-global.caddy'
if marker not in s:
    if 'on_demand_tls' in s:
        raise SystemExit('Existing on-demand TLS policy requires explicit integration')
    if not s.lstrip().startswith('{'):
        raise SystemExit('Expected an existing global Caddy options block')
    at = s.index('{') + 1
    s = s[:at] + '\n  ' + marker + s[at:]
for glob in ['/etc/caddy/sites/*.caddy', '/etc/caddy/platform/*.caddy']:
    if 'import ' + glob not in s:
        s += '\nimport ' + glob + '\n'
p.write_text(s)
PY
cat > /etc/caddy/flowstarter-preview-global.caddy <<'CADDY'
on_demand_tls {
  ask http://127.0.0.1:8444/tls-ask
}
CADDY
cat > /etc/caddy/platform/flowstarter-preview-front.caddy <<CADDY
# Managed by install-existing-host-agent.sh
*.$suffix {
  tls {
    on_demand
  }
  header X-Robots-Tag "noindex, nofollow, noarchive"
  reverse_proxy 127.0.0.1:9080
}
CADDY
if ! caddy validate --config /etc/caddy/Caddyfile; then
  cp "$backup" /etc/caddy/Caddyfile
  echo "Caddy validation failed; restored base config from $backup" >&2
  exit 1
fi
caddy validate --config /etc/caddy/previews/Caddyfile
systemctl daemon-reload
systemctl enable --now caddy-previews flowstarter-deploy-agent flowstarter-preview-deploy-agent
systemctl restart flowstarter-deploy-agent flowstarter-preview-deploy-agent
systemctl reload caddy
systemctl is-active caddy caddy-previews flowstarter-deploy-agent flowstarter-preview-deploy-agent
