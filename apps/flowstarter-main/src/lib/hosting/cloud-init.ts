/**
 * Cloud-init bootstrap script generator for Hetzner servers.
 *
 * Emits a cloud-config (YAML) blob that Hetzner runs on first boot.
 * This sets up the **shared multi-tenant Caddy host** topology described in
 * `docs/CONCIERGE_PIVOT_PLAN.md`:
 *
 *   - Updates packages
 *   - Installs Caddy (auto-https), Docker, jq, curl, ufw
 *   - Installs Node.js 22 + the Claude Code CLI globally so the editor's
 *     coding agent can run on the host (uses ANTHROPIC_API_KEY)
 *   - Hardens SSH (disables root password login, keeps key auth)
 *   - Opens 22/80/443 in ufw
 *   - Drops a systemd unit for the deploy-agent (Bun service, Slice 2.8)
 *   - Writes a base Caddyfile that includes per-site snippets from
 *     /etc/caddy/sites/*.caddy
 *   - Bumps cloud_init_version label so we can track which servers need
 *     a re-bootstrap when the script changes
 *   - Runs a final self-check that fails loudly (writes
 *     /etc/flowstarter/bootstrap-failed and exits non-zero) if Caddy,
 *     Docker, Node or the deploy-agent unit did not come up, so a
 *     half-installed host cannot report `cloud-init status: done` clean.
 *
 * Ordering note (the reason this file looks the way it does): every file
 * that lives under a path a package installed by `runcmd` owns — the Caddy
 * config chief among them — is written FROM runcmd, after that package's
 * `apt-get install`, never from `write_files`. `write_files` runs before
 * `runcmd`, so a `write_files` entry at `/etc/caddy/Caddyfile` lands before
 * dpkg unpacks the `caddy` package's own copy of that path. dpkg then treats
 * our file as a locally-modified conffile and stops to prompt for a decision
 * it can never get an answer to during unattended boot — which aborts the
 * apt transaction (and, with it, every apt-get that runs later in the same
 * `runcmd`: Docker, Node, npm, the Claude CLI) while leaving Caddy without
 * the system user its postinst creates. `cloud-init status` still reports
 * `done` because cloud-init only checks whether its own modules ran, not
 * whether the commands inside them succeeded — hence the self-check below.
 *
 * The deploy-agent binary itself isn't built yet — for now this script
 * leaves a placeholder unit that's disabled. When Slice 2.8 lands the
 * agent, we'll fill the ExecStart in.
 */

import { previewZone, siteRootDomain } from './site-hostnames';

const CLOUD_INIT_VERSION = 6;

/**
 * Pinned versions for the host's coding-agent stack. Bump these together
 * with CLOUD_INIT_VERSION when upgrading.
 */
const NODE_MAJOR = 22;
const CLAUDE_CODE_NPM_PACKAGE = '@anthropic-ai/claude-code';

/**
 * Marks the `on_demand_tls` block this file writes into the base Caddyfile
 * as the platform's own policy. `scripts/install-existing-host-agent.sh`
 * greps for this exact string before it decides whether an on-demand TLS
 * block it finds already on a host is ours to integrate with, or a foreign
 * policy it must refuse to touch. Keep the two in sync by hand — the shell
 * script cannot import this module.
 */
export const ON_DEMAND_TLS_MARKER = 'flowstarter-managed-on-demand-tls';

const CADDYFILE_HEREDOC_MARKER = 'FLOWSTARTER_CADDYFILE';
const PREVIEWS_CADDYFILE_HEREDOC_MARKER = 'FLOWSTARTER_PREVIEWS_CADDYFILE';

export interface CloudInitOptions {
  /** New hosts serve each built site in its own restricted static container. */
  siteRuntime?: 'docker' | 'filesystem';
  /** SSH public key(s) to add to the server's root account */
  sshAuthorizedKeys?: string[];
  /** Hostname to set on the server (FQDN or short name) */
  hostname?: string;
  /**
   * Bearer token the deploy-agent will require on every request from the
   * operator. Should be a high-entropy random string. The operator stores
   * this in Supabase Vault under hosting_servers.deploy_agent_secret_ref.
   */
  deployAgentSharedSecret: string;
  /**
   * Tarball URL (HTTPS) the server pulls the deploy-agent binary from on
   * first boot. Falls back to a placeholder that does nothing when null.
   */
  deployAgentArtifactUrl?: string | null;
  /** Email address Caddy uses for Let's Encrypt registration */
  caddyAcmeEmail: string;
  /**
   * Anthropic API key the on-host Claude Code CLI uses. Written to
   * /etc/flowstarter/anthropic.env (mode 0600, root-only) so any
   * editor-spawned subprocess can read it. Optional during early
   * provisioning — when omitted the CLI is still installed but the env
   * file is left empty so an operator can drop the key in later.
   */
  anthropicApiKey?: string | null;
  /**
   * Bearer token for the SECOND deploy-agent instance — the one that serves
   * funnel previews. Distinct from `deployAgentSharedSecret` on purpose: the
   * previews agent can write to `/var/www/previews` and `/etc/caddy/previews`
   * and to nothing else, so leaking it costs previews, not customer sites.
   *
   * Omit it and none of the previews stack is emitted at all — the output is
   * then byte-for-byte the paid-sites host we have always built.
   */
  previewsDeployAgentSharedSecret?: string | null;
  /**
   * The zone preview hostnames live under. Must match the wildcard DNS record
   * (dns-only so Caddy can answer the ACME HTTP-01 challenge itself) and
   * `PREVIEW_DOMAIN_SUFFIX` in `lib/hosting/preview-publisher.ts`. Defaults to
   * `preview.${resolvePlatformDomain()}` when omitted: `preview.flowstarter.dev`
   * outside production, `preview.flowstarter.net` in it.
   */
  previewsHostSuffix?: string;
  /**
   * The FINAL hostname template a paid site is served at, `{slug}.{domain}`.
   *
   * Defaults to the platform domain for this environment. It is written to the
   * paid agent's env file rather than left to an operator because without it
   * the agent produces an empty Caddy snippet for any workspace with no custom
   * domain attached, and the deploy reports success for a site nobody can
   * open. The name has no `preview.` in it: that namespace is for the
   * temporary funnel previews, which expire.
   */
  siteDomainTemplate?: string;
}

/**
 * Ports and paths for the previews stack. Every one of them differs from the
 * paid-site equivalent; that difference IS the isolation.
 */
const PREVIEWS = {
  /** Second deploy-agent instance. The paid one keeps 8443. */
  agentPort: 8444,
  /** Second Caddy instance. The paid one keeps 80/443. */
  caddyHttpPort: 9080,
  caddyHttpsPort: 9443,
  sitesRoot: '/var/www/previews',
  caddyDir: '/etc/caddy/previews',
  caddySitesDir: '/etc/caddy/previews/sites',
} as const;

export function getCloudInitVersion(): number {
  return CLOUD_INIT_VERSION;
}

/**
 * Builds the cloud-config YAML. The output is meant to be passed to Hetzner's
 * `user_data` field on POST /v1/servers.
 *
 * Note: We intentionally use raw string templating instead of a YAML library
 * because the script is small, the structure is fixed, and we want zero
 * runtime deps on the server-side hot path.
 */
export function buildCloudInit(opts: CloudInitOptions): string {
  if (!opts.deployAgentSharedSecret) {
    throw new Error('buildCloudInit: deployAgentSharedSecret is required');
  }
  if (!opts.caddyAcmeEmail) {
    throw new Error('buildCloudInit: caddyAcmeEmail is required');
  }

  const sshKeys = opts.sshAuthorizedKeys ?? [];
  const hostname = opts.hostname ?? 'flowstarter-host';
  const artifactUrl = opts.deployAgentArtifactUrl;
  const previewsSecret = opts.previewsDeployAgentSharedSecret?.trim() || null;
  // Same env-driven rule as `previewDomainForSlug` and `PREVIEW_DOMAIN_SUFFIX`:
  // a caller that provisions from a development or staging process gets
  // `preview.flowstarter.dev` without having to pass `previewsHostSuffix`
  // explicitly; production gets `preview.flowstarter.net`.
  const previewsSuffix = opts.previewsHostSuffix?.trim() || previewZone();
  const siteDomainTemplate =
    opts.siteDomainTemplate?.trim() || `{slug}.${siteRootDomain()}`;

  const sshKeysYaml = sshKeys.length
    ? sshKeys.map((k) => `      - ${escapeYaml(k)}`).join('\n')
    : '';

  const runcmd = [
    caddyInstallRuncmd(),
    heredocRuncmdStep(
      '/etc/caddy/Caddyfile',
      CADDYFILE_HEREDOC_MARKER,
      baseCaddyfileContent(opts.caddyAcmeEmail, previewsSecret, previewsSuffix)
    ),
    dockerInstallRuncmd(),
    nodeAndClaudeInstallRuncmd(),
    sitesDirRuncmd(),
    previewsSecret ? previewsRuncmd() : '',
    firewallRuncmd(),
    deployAgentInstallRuncmd(artifactUrl, previewsSecret),
    selfCheckRuncmd(Boolean(artifactUrl), Boolean(previewsSecret)),
  ]
    .filter(Boolean)
    .join('\n\n');

  // Note: heredoc must keep tab/space indentation correct for YAML.
  return `#cloud-config
#
# Flowstarter Hetzner host bootstrap — version ${CLOUD_INIT_VERSION}
# See apps/flowstarter-main/src/lib/hosting/cloud-init.ts for source.
#
hostname: ${hostname}
manage_etc_hosts: true

package_update: true
package_upgrade: true

packages:
  - curl
  - jq
  - ufw
  - debian-keyring
  - debian-archive-keyring
  - apt-transport-https
  - ca-certificates
  - software-properties-common

users:
  - name: root
${
  sshKeysYaml
    ? `    ssh_authorized_keys:\n${sshKeysYaml}`
    : '    # no extra ssh keys'
}

write_files:
  - path: /etc/flowstarter/version
    content: |
      cloud_init_version=${CLOUD_INIT_VERSION}
    owner: root:root
    permissions: '0644'
  - path: /etc/flowstarter/deploy-agent.env
    content: |
      DEPLOY_AGENT_SHARED_SECRET=${opts.deployAgentSharedSecret}
      DEPLOY_AGENT_PORT=8443
      DEPLOY_AGENT_SITE_RUNTIME=${opts.siteRuntime ?? 'docker'}
      # The name a paying client was sold. Without it the agent writes an
      # empty snippet for any site with no custom domain yet.
      DEPLOY_AGENT_SITE_DOMAIN_TEMPLATE=${siteDomainTemplate}
    owner: root:root
    permissions: '0600'
  - path: /etc/flowstarter/anthropic.env
    content: |
      # Anthropic credentials for the on-host Claude Code CLI. Sourced by
      # any editor-spawned subprocess that runs the agent on this host.
      ANTHROPIC_API_KEY=${opts.anthropicApiKey ?? ''}
    owner: root:root
    permissions: '0600'
  - path: /etc/systemd/system/flowstarter-deploy-agent.service
    content: |
      [Unit]
      Description=Flowstarter deploy-agent
      After=network-online.target docker.service
      Wants=network-online.target

      [Service]
      EnvironmentFile=/etc/flowstarter/deploy-agent.env
      ExecStart=/usr/local/bin/flowstarter-deploy-agent
      Restart=on-failure
      RestartSec=5

      [Install]
      WantedBy=multi-user.target
    owner: root:root
    permissions: '0644'
${
  previewsSecret
    ? previewsWriteFiles(
        previewsSecret,
        previewsSuffix,
        opts.siteRuntime ?? 'docker'
      )
    : ''
}
runcmd:
${runcmd}

final_message: "Flowstarter host bootstrap complete (cloud_init_version=${CLOUD_INIT_VERSION}). Caddy + Docker + Node ${NODE_MAJOR} + Claude Code CLI installed. Deploy-agent ${
    artifactUrl ? 'started' : 'disabled (no artifact url)'
  }. Anthropic env ${
    opts.anthropicApiKey
      ? 'wired'
      : 'placeholder (drop key in /etc/flowstarter/anthropic.env)'
  }."
`;
}

function caddyInstallRuncmd(): string {
  return `  # ─── Caddy install (official repo) ────────────────────────────────────
  - curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  - curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list
  - apt-get update
  # --force-confold: belt to the ordering-fix braces above. If a stray
  # conffile ever ends up on disk before this runs again, keep our copy
  # instead of dropping into an unattended prompt that never resolves.
  - apt-get install -y -o Dpkg::Options::=--force-confold caddy`;
}

function dockerInstallRuncmd(): string {
  return `  # ─── Docker install (official convenience script) ─────────────────────
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable docker
  - systemctl start docker`;
}

function nodeAndClaudeInstallRuncmd(): string {
  return `  # ─── Node.js ${NODE_MAJOR} + Claude Code CLI ──────────────────────────
  # NodeSource ships current LTS; Debian's own apt is too stale for the
  # CLI's engine requirement. Globally installs ${CLAUDE_CODE_NPM_PACKAGE}
  # so editor-spawned subprocesses on the host can run \`claude\` directly.
  - curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
  - apt-get install -y nodejs
  - npm install -g ${CLAUDE_CODE_NPM_PACKAGE}
  - claude --version || true`;
}

function sitesDirRuncmd(): string {
  return `  # ─── Sites dir + Caddy reload ─────────────────────────────────────────
  - mkdir -p /etc/caddy/sites
  - mkdir -p /var/www/sites
  - chown -R caddy:caddy /var/www/sites
  - systemctl reload caddy`;
}

function firewallRuncmd(): string {
  return `  # ─── Firewall ─────────────────────────────────────────────────────────
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow 22/tcp
  - ufw allow 80/tcp
  - ufw allow 443/tcp
  - ufw --force enable`;
}

function deployAgentInstallRuncmd(
  artifactUrl: string | null | undefined,
  previewsSecret: string | null
): string {
  const header = `  # ─── Deploy-agent install (placeholder until artifact is published) ───`;
  if (!artifactUrl) {
    return `${header}
  # Deploy-agent artifact URL not provided. Service unit installed but disabled.
  - systemctl daemon-reload`;
  }
  const previewsLine = previewsSecret
    ? `
  # Same binary, second instance: everything that differs (port, secret,
  # sites root, Caddy dir, reload command, snippet shape) comes from
  # /etc/flowstarter/preview-deploy-agent.env.
  - systemctl enable --now flowstarter-preview-deploy-agent`
    : '';
  return `${header}
  - curl -fsSL ${escapeShell(
    artifactUrl
  )} -o /usr/local/bin/flowstarter-deploy-agent
  - chmod +x /usr/local/bin/flowstarter-deploy-agent
  - systemctl daemon-reload
  - systemctl enable --now flowstarter-deploy-agent${previewsLine}`;
}

/**
 * The previews half of the host's `runcmd`: the second Caddy's own config
 * (written here, after `caddy` is installed, for the same conffile reason
 * as the paid Caddyfile above) plus its directories and service.
 */
function previewsRuncmd(): string {
  return `  # ─── Previews: separate roots, separate Caddy ─────────────────────────
  # Different directories from the paid sites above, owned by the same user
  # only so Caddy can read them. The previews agent is the only writer.
  - mkdir -p ${PREVIEWS.caddySitesDir}
${heredocRuncmdStep(
  `${PREVIEWS.caddyDir}/Caddyfile`,
  PREVIEWS_CADDYFILE_HEREDOC_MARKER,
  previewsCaddyfileContent()
)}
  - mkdir -p ${PREVIEWS.sitesRoot}
  - chown -R caddy:caddy ${PREVIEWS.sitesRoot}
  - systemctl daemon-reload
  - systemctl enable --now caddy-previews`;
}

/**
 * Final `runcmd` step. A `cloud-init status` of `done` only means every
 * module ran, not that the commands inside `runcmd` succeeded — the exact
 * gap that let a dpkg conffile prompt poison apt for the rest of boot while
 * cloud-init reported a clean finish. This step checks the things that
 * actually make the host usable and fails the boot loudly, in a place an
 * operator will find, when any of them did not come up.
 *
 * The deploy-agent unit is only required to be active when an artifact URL
 * was actually provided — with none, leaving it installed-but-disabled is
 * the intended placeholder state, not a failure.
 */
function selfCheckRuncmd(hasArtifact: boolean, hasPreviews: boolean): string {
  const checks: string[] = [
    'command -v caddy >/dev/null 2>&1 || flowstarter_bootstrap_fail "caddy is not installed"',
    'systemctl is-active --quiet caddy || flowstarter_bootstrap_fail "caddy.service is not active"',
    'command -v docker >/dev/null 2>&1 || flowstarter_bootstrap_fail "docker is not installed"',
    'systemctl is-active --quiet docker || flowstarter_bootstrap_fail "docker.service is not active"',
    'command -v node >/dev/null 2>&1 || flowstarter_bootstrap_fail "node is not installed"',
  ];
  if (hasArtifact) {
    checks.push(
      'systemctl is-active --quiet flowstarter-deploy-agent || flowstarter_bootstrap_fail "flowstarter-deploy-agent.service is not active"'
    );
  }
  if (hasPreviews) {
    checks.push(
      'systemctl is-active --quiet caddy-previews || flowstarter_bootstrap_fail "caddy-previews.service is not active"'
    );
    if (hasArtifact) {
      checks.push(
        'systemctl is-active --quiet flowstarter-preview-deploy-agent || flowstarter_bootstrap_fail "flowstarter-preview-deploy-agent.service is not active"'
      );
    }
  }
  const script = [
    'flowstarter_bootstrap_fail() {',
    '  mkdir -p /etc/flowstarter',
    '  printf \'%s\\n\' "$1" > /etc/flowstarter/bootstrap-failed',
    '  echo "flowstarter bootstrap self-check failed: $1" >&2',
    '  exit 1',
    '}',
    ...checks,
    'rm -f /etc/flowstarter/bootstrap-failed',
    'echo "flowstarter bootstrap self-check passed"',
  ].join('\n');
  return `  # ─── Self-check: a half-installed host must not look healthy ──────────
  - |
${script
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}`;
}

/** One `runcmd` item that heredocs `content` into `path`, quoted so nothing in it re-expands. */
function heredocRuncmdStep(
  path: string,
  marker: string,
  content: string
): string {
  const indented = content
    .split('\n')
    .map((line) => (line.length ? `    ${line}` : ''))
    .join('\n');
  return `  - |
    cat <<'${marker}' > ${path}
${indented}
    ${marker}`;
}

/**
 * The paid-site base Caddyfile's content, unindented — callers place it into
 * a `runcmd` heredoc (after `caddy` is installed) rather than `write_files`.
 */
function baseCaddyfileContent(
  caddyAcmeEmail: string,
  previewsSecret: string | null,
  previewsSuffix: string
): string {
  return `# Base Caddyfile — per-site vhosts live in /etc/caddy/sites/*.caddy${
    previewsSecret
      ? `
#
# This file and that glob are the PAID-SITE Caddy instance, and it never
# imports anything the previews agent writes. Preview snippets live under
# ${PREVIEWS.caddySitesDir}/*.caddy, a different directory loaded by a
# different Caddy process (caddy-previews.service). A preview snippet
# that does not parse takes that process down and leaves every customer
# site on this box serving.`
      : ''
  }
{
  email ${caddyAcmeEmail}${
    previewsSecret
      ? `
  # Certificates for preview hostnames are issued on demand and only for
  # hostnames the previews agent confirms it is actually serving — the
  # ask endpoint is what stops a stranger pointing DNS at this box and
  # making us mint certificates for them. (Caddy removed the older
  # \`interval\`/\`burst\` rate limiters; \`ask\` is the control now,
  # which is why it is not optional here.)
  # ${ON_DEMAND_TLS_MARKER}
  on_demand_tls {
    ask http://127.0.0.1:${PREVIEWS.agentPort}/tls-ask
  }`
      : ''
  }
}
import /etc/caddy/sites/*.caddy${
    previewsSecret
      ? `

# ─── Previews ────────────────────────────────────────────────────────
# ONE static block, written once at boot and never touched again by any
# agent. It terminates TLS for the whole preview zone and hands the
# request to the previews Caddy on loopback. Nothing here is generated,
# so nothing generated can break it.
*.${previewsSuffix} {
  tls {
    on_demand
  }
  # Belt to the meta tag's braces: every HTML file in a preview also
  # carries <meta name="robots" content="noindex, ...">.
  header X-Robots-Tag "noindex, nofollow, noarchive"
  reverse_proxy 127.0.0.1:${PREVIEWS.caddyHttpPort}
}`
      : ''
  }`;
}

/** The previews Caddy's own config, unindented. Nothing in it varies by call. */
function previewsCaddyfileContent(): string {
  return `# PREVIEWS Caddy — a different process from the one in /etc/caddy.
#
# TLS is terminated by the paid Caddy on 443 and the request arrives here
# over loopback, so this instance speaks plain HTTP and auto_https is off.
# It imports ONLY its own snippet directory; nothing in here can be
# reached from /etc/caddy/Caddyfile's import glob.
{
  admin 127.0.0.1:2020
  default_bind 127.0.0.1
  auto_https off
  http_port ${PREVIEWS.caddyHttpPort}
  https_port ${PREVIEWS.caddyHttpsPort}
}
import ${PREVIEWS.caddySitesDir}/*.caddy`;
}

/**
 * The previews half of the host: a second deploy-agent instance and a second
 * Caddy, sharing nothing writable with the paid-site stack.
 *
 * What is actually separated, and why each one matters:
 *
 *  - SITES ROOT. Previews extract into /var/www/previews/{slug}/. The previews
 *    agent's DEPLOY_AGENT_SITES_ROOT never points at /var/www/sites, so a
 *    preview slug that collides with a customer's workspace slug overwrites
 *    another preview, not their site.
 *  - CADDY CONFIG DIRECTORY. Preview snippets are written to
 *    /etc/caddy/previews/sites/*.caddy. The paid Caddyfile imports
 *    /etc/caddy/sites/*.caddy and nothing else, so a snippet that does not
 *    parse cannot be loaded by the process that serves customers.
 *  - CADDY PROCESS. caddy-previews.service is a separate unit with its own
 *    config and its own ports. Caddy refuses to load a config with a bad
 *    import — the isolation only holds if that failure happens to a different
 *    process, which is the whole reason there are two.
 *  - PORT + SECRET. 8444 and its own bearer token. The previews token cannot
 *    deploy to a customer host, and the customer token is never sent to the
 *    previews agent.
 *
 * The one thing they share is the public listener: the paid Caddy owns 80/443
 * because only one process can, and hands the preview zone to the previews
 * Caddy over loopback through a single static block that no agent ever writes.
 *
 * The previews Caddyfile itself is NOT written here — it lives under
 * /etc/caddy, a package-owned path, so it is written from `runcmd` by
 * `previewsRuncmd()` instead, after `caddy` is installed.
 */
function previewsWriteFiles(
  sharedSecret: string,
  hostSuffix: string,
  siteRuntime: 'docker' | 'filesystem'
): string {
  return `  - path: /etc/flowstarter/preview-deploy-agent.env
    content: |
      # SECOND deploy-agent instance — funnel previews only.
      # Same binary as the paid agent, everything that matters different.
      DEPLOY_AGENT_MODE=previews
      DEPLOY_AGENT_SITE_RUNTIME=${siteRuntime}
      DEPLOY_AGENT_SHARED_SECRET=${sharedSecret}
      DEPLOY_AGENT_PORT=${PREVIEWS.agentPort}
      DEPLOY_AGENT_SITES_ROOT=${PREVIEWS.sitesRoot}
      DEPLOY_AGENT_CADDY_SITES_DIR=${PREVIEWS.caddySitesDir}
      DEPLOY_AGENT_CADDY_RELOAD_CMD=systemctl reload caddy-previews
      DEPLOY_AGENT_TEMP_ROOT=/tmp/flowstarter-preview-deploys
      DEPLOY_AGENT_SITE_PORT=${PREVIEWS.caddyHttpPort}
      DEPLOY_AGENT_PREVIEW_HOST_SUFFIX=${hostSuffix}
    owner: root:root
    permissions: '0600'
  - path: /etc/systemd/system/caddy-previews.service
    content: |
      [Unit]
      Description=Caddy (funnel previews)
      After=network-online.target
      Wants=network-online.target

      [Service]
      User=caddy
      Group=caddy
      ExecStart=/usr/bin/caddy run --environ --config ${PREVIEWS.caddyDir}/Caddyfile
      ExecReload=/usr/bin/caddy reload --config ${PREVIEWS.caddyDir}/Caddyfile --address 127.0.0.1:2020 --force
      Restart=on-failure
      RestartSec=5
      # A previews Caddy that cannot start must not take the box with it.
      TimeoutStopSec=5s

      [Install]
      WantedBy=multi-user.target
    owner: root:root
    permissions: '0644'
  - path: /etc/systemd/system/flowstarter-preview-deploy-agent.service
    content: |
      [Unit]
      Description=Flowstarter deploy-agent (funnel previews)
      After=network-online.target
      Wants=network-online.target

      [Service]
      EnvironmentFile=/etc/flowstarter/preview-deploy-agent.env
      ExecStart=/usr/local/bin/flowstarter-deploy-agent
      Restart=on-failure
      RestartSec=5

      [Install]
      WantedBy=multi-user.target
    owner: root:root
    permissions: '0644'
`;
}

function escapeYaml(value: string): string {
  // Quote only if needed: contains ':' or starts with a YAML-significant char.
  if (/^[a-zA-Z0-9@\-+=/_.\s]+$/.test(value) && !value.includes(': ')) {
    return value;
  }
  return JSON.stringify(value);
}

function escapeShell(value: string): string {
  // For URLs in cloud-init runcmd. We trust the input (operator-controlled),
  // but still wrap in single quotes and escape any embedded single quotes.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
