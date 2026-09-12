#!/usr/bin/env bash
# Run on an existing Ubuntu host after installing Docker and Caddy.
# Usage: sudo bash install-existing-host-agent.sh BUNDLE_DIR PREVIEW_SUFFIX
# Bundle: flowstarter-deploy-agent (Linux binary), deploy-agent.env,
# preview-deploy-agent.env. Env files contain distinct private bearer tokens.
# This installs the platform agent, never a generated customer site.
set -euo pipefail

# Determine how the host's existing base Caddyfile ($1) relates to the
# platform's own on-demand TLS policy, and reconcile the two in place.
#
# Hosts cloud-init itself provisioned
# (apps/flowstarter-main/src/lib/hosting/cloud-init.ts) already carry an
# `on_demand_tls` block inline when previews were enabled at boot -- it is
# the platform's own policy, and cloud-init marks it with the
# "flowstarter-managed-on-demand-tls" comment right next to the directive.
# Before this fix, finding ANY on_demand_tls block made this script abort,
# which meant it refused the very hosts the platform provisions (for example
# when re-running it to push a new agent binary onto one that already has
# previews). This function recognises that marker and integrates with the
# existing policy instead of aborting. It still aborts for a foreign
# on-demand policy this script did not write and cannot safely merge with.
#
# Prints one of on stdout:
#   own                 no policy existed; this call added our import marker
#   already-integrated  a previous run of this script already added it
#   platform            cloud-init's own policy is already there; nothing to add
#
# Exits non-zero, with the reason on stderr, for a foreign on_demand_tls
# policy neither of the above accounts for.
integrate_on_demand_policy() {
  local caddyfile="$1"
  python3 - "$caddyfile" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
s = p.read_text()
marker = 'import /etc/caddy/flowstarter-preview-global.caddy'
platform_marker = 'flowstarter-managed-on-demand-tls'
if marker in s:
    mode = 'already-integrated'
elif 'on_demand_tls' in s:
    if platform_marker not in s:
        raise SystemExit(
            'Existing on-demand TLS policy requires explicit integration: '
            'this host has an on_demand_tls block this script did not write, '
            'and it is missing the "' + platform_marker + '" marker '
            'cloud-init emits, so it is not the Flowstarter platform policy. '
            'Merge the policies by hand -- point a single ask directive at '
            'http://127.0.0.1:8444/tls-ask and remove the other -- then '
            're-run this script.'
        )
    # cloud-init already wrote this on-demand policy inline in the global
    # options block; nothing to add, just leave it as the one policy.
    mode = 'platform'
else:
    if not s.lstrip().startswith('{'):
        raise SystemExit('Expected an existing global Caddy options block')
    at = s.index('{') + 1
    s = s[:at] + '\n  ' + marker + s[at:]
    mode = 'own'
for glob in ['/etc/caddy/sites/*.caddy', '/etc/caddy/platform/*.caddy']:
    if 'import ' + glob not in s:
        s += '\nimport ' + glob + '\n'
p.write_text(s)
print(mode)
PY
}

main() {
  local bundle="${1:?bundle directory required}"
  local suffix="${2:?preview hostname suffix required}"
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

  local mode unit envfile
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
  local backup integration_mode
  backup=$(mktemp /etc/caddy/Caddyfile.before-flowstarter.XXXXXX)
  cp /etc/caddy/Caddyfile "$backup"
  integration_mode=$(integrate_on_demand_policy /etc/caddy/Caddyfile) || exit 1
  if [[ "$integration_mode" != "platform" ]]; then
    cat > /etc/caddy/flowstarter-preview-global.caddy <<'CADDY'
on_demand_tls {
  ask http://127.0.0.1:8444/tls-ask
}
CADDY
  fi
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
}

# Sourcing this file (as the test script does, to reach
# `integrate_on_demand_policy` without root/docker/caddy/systemctl) must not
# also run `main`. Only run it when the file is executed directly.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
