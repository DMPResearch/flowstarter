#!/usr/bin/env node
/**
 * Provision the previews host.
 *
 * Creates ONE Hetzner server that runs both deploy-agents (paid sites and
 * previews) behind two Caddy instances, registers it in `hosting_servers`, and
 * points a preview wildcard at it.
 *
 * WHICH ZONE: the same env-driven rule as everywhere else
 * (`resolvePlatformDomain` in `@flowstarter/platform-config`). This script
 * runs from the app's env files, so it takes the environment it runs under,
 * which is `FLOWSTARTER_ENV`, defaulting to `development` when unset, since a
 * one-off provisioning script has no meaningful `NODE_ENV` to fall back to.
 * `development`, `test` and `staging` all resolve to `flowstarter.dev`;
 * only `production` resolves to `flowstarter.net`. `--zone` overrides the
 * resolved zone, but never the safety check below.
 *
 * IT COSTS MONEY AND IT CHANGES DNS. Therefore:
 *
 *   - the default is a DRY RUN. It prints the exact plan (which zone it
 *     resolved and why, server type, image, location, cloud-init size, the
 *     DNS record it would write) and exits 0 without calling a single
 *     mutating API;
 *   - the real run requires `--yes-i-understand-this-costs-money`, in full;
 *   - it refuses to write a `.net` record unless `FLOWSTARTER_ENV=production`
 *     is set explicitly, whether the zone came from the resolver or from
 *     `--zone`. The flowstarter.net zone carries live production records
 *     (the apex, www, mail, autoconfig, autodiscover, MX/TXT/SRV, and at
 *     least one client site); this script must be incapable of disturbing
 *     them from a laptop that forgot to set an env var;
 *   - it NEVER touches an existing DNS record. Before creating the wildcard it
 *     lists the zone, and if a record with that name already exists it stops
 *     and tells you, rather than "upserting" over something you rely on.
 *
 * The wildcard is created dns-only (NOT proxied) deliberately: Caddy answers
 * the ACME HTTP-01 challenge itself, and Cloudflare's proxy would intercept it.
 *
 * Run it with `tsx`, not bare node: the cloud-init generator it imports is the
 * TypeScript one the app itself uses, so the bytes that boot the server are the
 * bytes the tests cover — not a copy that can drift.
 *
 * Usage (from apps/flowstarter-main):
 *   npx tsx scripts/provision-preview-host.mjs                               # plan (dev zone)
 *   npx tsx scripts/provision-preview-host.mjs --name fs-previews-01 \
 *        --yes-i-understand-this-costs-money                                 # apply (dev zone)
 *   FLOWSTARTER_ENV=production npx tsx scripts/provision-preview-host.mjs \
 *        --yes-i-understand-this-costs-money                                 # apply (production zone)
 *
 * Note: it reads .env.local, which points NEXT_PUBLIC_SUPABASE_URL at the LOCAL
 * stack. Point it at production explicitly when you mean production.
 *
 * Env (read from apps/flowstarter-main/.env.local if present):
 *   FLOWSTARTER_ENV         optional; defaults to development. Set to
 *                           production explicitly to target flowstarter.net.
 *   HETZNER_API_TOKEN       required
 *   CLOUDFLARE_API_TOKEN    required
 *   CLOUDFLARE_ZONE_ID      optional; looked up by zone name when absent
 *   HETZNER_SSH_KEY_ID      optional but strongly recommended — without it you
 *                           have no way into the box except the rescue console
 *   CADDY_ACME_EMAIL        optional; defaults to ops@<zone>
 *   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *                           needed only for the hosting_servers insert
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlatformDomain } from '@flowstarter/platform-config';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_ROOT, '../..');

const CONFIRM_FLAG = '--yes-i-understand-this-costs-money';

// ─── Defaults ──────────────────────────────────────────────────────────────
// Smallest current shared-vCPU type, Falkenstein, current Ubuntu LTS. A
// preview host serves static files; CPU is not what runs out first.
//
// `zone` and `previewSuffix` are NOT here: this script runs from the app's
// env files, so which of the two live zones it targets has to be decided
// after those files are loaded (below), the same way `resolvePlatformDomain`
// decides it everywhere else: `flowstarter.net` only when `FLOWSTARTER_ENV`
// says `production`, `flowstarter.dev` otherwise.
const DEFAULTS = {
  name: 'fs-previews-01',
  serverType: 'cx22',
  location: 'fsn1',
  image: 'ubuntu-24.04',
  siteCapacity: 200,
};

// ─── Tiny .env reader ──────────────────────────────────────────────────────
// Deliberately not dotenv: this script must run with `node` and no install
// step, from a repo checkout, on a laptop.
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(resolve(APP_ROOT, '.env.local'));
loadEnvFile(resolve(REPO_ROOT, '.env.local'));

// ─── Args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === CONFIRM_FLAG) {
      args.apply = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const name = typeof args.name === 'string' ? args.name : DEFAULTS.name;
const serverType =
  typeof args['server-type'] === 'string'
    ? args['server-type']
    : DEFAULTS.serverType;
const location =
  typeof args.location === 'string' ? args.location : DEFAULTS.location;

// The environment this script is running under. `FLOWSTARTER_ENV` is
// authoritative, same as `resolveFlowstarterEnv()` in the app; unlike the
// app, there is no meaningful `NODE_ENV` for a one-off provisioning script,
// so an unset `FLOWSTARTER_ENV` means development, the safe zone, rather
// than guessing from `NODE_ENV`.
const flowstarterEnv = process.env.FLOWSTARTER_ENV?.trim() || 'development';
const defaultZone = resolvePlatformDomain({ flowstarterEnv });
const zone = typeof args.zone === 'string' ? args.zone : defaultZone;
const previewSuffix =
  typeof args['preview-suffix'] === 'string'
    ? args['preview-suffix']
    : `preview.${zone}`;
const wildcard = `*.${previewSuffix}`;

if (!/^[a-z0-9-]{2,40}$/.test(name)) {
  fail(`--name must match /^[a-z0-9-]{2,40}$/ (got "${name}")`);
}

// ─── Output helpers ────────────────────────────────────────────────────────
function line(text = '') {
  process.stdout.write(`${text}\n`);
}
function fail(message) {
  process.stderr.write(`\nERROR: ${message}\n`);
  process.exit(1);
}
/** Secrets are shown as an 8-character prefix and never in full. */
function redact(value) {
  if (!value) return '(not set)';
  return `${String(value).slice(0, 8)}… (${String(value).length} chars)`;
}

// ─── Cloud-init ────────────────────────────────────────────────────────────
// The generator is TypeScript inside the Next app. Rather than depend on a
// build step, this script shells out to `tsx` when it needs the real bytes —
// and in a dry run it only needs the size, so a failure to load it is
// reported, not fatal.
async function buildCloudInitYaml(paidSecret, previewsSecret, acmeEmail) {
  const { buildCloudInit, getCloudInitVersion } = await import(
    resolve(APP_ROOT, 'src/lib/hosting/cloud-init.ts')
  );
  return {
    yaml: buildCloudInit({
      hostname: name,
      deployAgentSharedSecret: paidSecret,
      previewsDeployAgentSharedSecret: previewsSecret,
      previewsHostSuffix: previewSuffix,
      caddyAcmeEmail: acmeEmail,
      deployAgentArtifactUrl:
        typeof args['agent-artifact-url'] === 'string'
          ? args['agent-artifact-url']
          : null,
      sshAuthorizedKeys: [],
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    }),
    version: getCloudInitVersion(),
  };
}

// ─── API helpers ───────────────────────────────────────────────────────────
async function hetzner(method, path, token, body) {
  const res = await fetch(`https://api.hetzner.cloud/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(
      `Hetzner ${method} ${path} → ${res.status}: ${
        data?.error?.message ?? text
      }`
    );
  }
  return data;
}

async function cloudflare(method, path, token, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(
      `Cloudflare ${method} ${path} → ${res.status}: ${JSON.stringify(
        data.errors ?? data
      )}`
    );
  }
  return data.result;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const hetznerToken = process.env.HETZNER_API_TOKEN;
  const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
  const sshKeyId = process.env.HETZNER_SSH_KEY_ID;
  const acmeEmail = process.env.CADDY_ACME_EMAIL || `ops@${zone}`;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const paidSecret = randomBytes(32).toString('base64url');
  const previewsSecret = randomBytes(32).toString('base64url');
  const paidSecretRef = `deploy_agent_shared_secret_${name}`;

  let cloudInit = null;
  let cloudInitError = null;
  try {
    cloudInit = await buildCloudInitYaml(paidSecret, previewsSecret, acmeEmail);
  } catch (error) {
    cloudInitError = error instanceof Error ? error.message : String(error);
  }

  line();
  line('══ Flowstarter previews host ══════════════════════════════════════');
  line(args.apply ? 'MODE:  APPLY (this will spend money)' : 'MODE:  DRY RUN');
  line(
    `ENV:   FLOWSTARTER_ENV=${flowstarterEnv} → zone ${zone}${
      args.zone ? ' (--zone override)' : ''
    }`
  );
  line();
  line('1. Hetzner server');
  line(`     name           ${name}`);
  line(`     server_type    ${serverType}`);
  line(`     location       ${location}`);
  line(`     image          ${DEFAULTS.image}`);
  line(`     ssh_keys       ${sshKeyId ? `[${sshKeyId}]` : '[] (NONE SET)'}`);
  line(
    `     user_data      ${
      cloudInit
        ? `cloud-init v${cloudInit.version}, ${cloudInit.yaml.length} bytes`
        : `UNAVAILABLE (${cloudInitError})`
    }`
  );
  line(`     labels         role=previews, managed-by=flowstarter`);
  line();
  line('2. hosting_servers row');
  line(`     name                     ${name}`);
  line(`     provider                 hetzner`);
  line(`     status                   provisioning`);
  line(`     deploy_agent_url         https://<ipv4>:8443  (paid sites)`);
  line(`     deploy_agent_secret_ref  ${paidSecretRef}`);
  line(`     site_capacity            ${DEFAULTS.siteCapacity}`);
  line(
    `     supabase                 ${
      supabaseUrl && supabaseKey ? supabaseUrl : 'NOT CONFIGURED (row skipped)'
    }`
  );
  line();
  line('3. Cloudflare DNS');
  line(`     zone           ${zone}`);
  line(`     record         A  ${wildcard}  →  <ipv4>`);
  line(`     proxied        false   (Caddy must answer the ACME challenge)`);
  line(`     ttl            60`);
  line(
    `     safety         refuses to run if any record named "${wildcard}" already exists`
  );
  line();
  line('4. Env to set afterwards (values printed once, on apply only)');
  line(`     FLOWSTARTER_DEPLOY_AGENT_SECRET           ${redact(paidSecret)}`);
  line(`     FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL      https://<ipv4>:8444`);
  line(
    `     FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET   ${redact(previewsSecret)}`
  );
  line(`     FLOWSTARTER_PREVIEW_DOMAIN_SUFFIX         ${previewSuffix}`);
  line(`     CLOUDFLARE_ZONE_ID                        <zone id for ${zone}>`);
  line();
  line('Credentials present:');
  line(`     HETZNER_API_TOKEN      ${hetznerToken ? 'yes' : 'NO'}`);
  line(`     CLOUDFLARE_API_TOKEN   ${cloudflareToken ? 'yes' : 'NO'}`);
  line(`     HETZNER_SSH_KEY_ID     ${sshKeyId ? 'yes' : 'no'}`);
  line(
    `     SUPABASE service role  ${supabaseUrl && supabaseKey ? 'yes' : 'no'}`
  );
  line('═══════════════════════════════════════════════════════════════════');
  line();

  if (!args.apply) {
    line(`Dry run. Nothing was created. Re-run with ${CONFIRM_FLAG} to apply.`);
    return;
  }

  // ── From here on it is real. ────────────────────────────────────────────
  // The flowstarter.net zone carries live production DNS. Writing to it is
  // refused unless FLOWSTARTER_ENV=production was set explicitly: not
  // inferred, not defaulted, and not implied by `--zone flowstarter.net`
  // alone, so a laptop running with no env file cannot touch it by accident.
  if (zone.endsWith('.net') && flowstarterEnv !== 'production') {
    fail(
      `Refusing to write to zone "${zone}": FLOWSTARTER_ENV is ` +
        `"${flowstarterEnv}", not "production". This zone carries live ` +
        'production DNS records. Set FLOWSTARTER_ENV=production explicitly ' +
        'if you really mean to provision the production previews host.'
    );
  }
  if (!hetznerToken) fail('HETZNER_API_TOKEN is required to apply');
  if (!cloudflareToken) fail('CLOUDFLARE_API_TOKEN is required to apply');
  if (!cloudInit) fail(`cloud-init could not be built: ${cloudInitError}`);
  if (!sshKeyId) {
    fail(
      'HETZNER_SSH_KEY_ID is not set. Refusing to create a server you cannot ' +
        'ssh into — add the key in the Hetzner console first.'
    );
  }

  // Zone + existing-record check BEFORE anything is created, so a name
  // collision costs nothing.
  const zoneId =
    process.env.CLOUDFLARE_ZONE_ID ||
    (await cloudflare('GET', `/zones?name=${zone}`, cloudflareToken))?.[0]?.id;
  if (!zoneId) fail(`Could not resolve a Cloudflare zone for ${zone}`);

  const existing = await cloudflare(
    'GET',
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(wildcard)}`,
    cloudflareToken
  );
  if (existing.length > 0) {
    fail(
      `A DNS record named ${wildcard} already exists (${existing[0].type} → ` +
        `${existing[0].content}). Refusing to modify it. Delete it by hand ` +
        'if it is stale, then re-run.'
    );
  }

  line(`Creating Hetzner server ${name}…`);
  const created = await hetzner('POST', '/servers', hetznerToken, {
    name,
    server_type: serverType,
    location,
    image: DEFAULTS.image,
    ssh_keys: [sshKeyId],
    user_data: cloudInit.yaml,
    start_after_create: true,
    labels: { role: 'previews', 'managed-by': 'flowstarter' },
  });
  const server = created.server;
  const ipv4 = server.public_net?.ipv4?.ip;
  line(`  → id ${server.id}, ipv4 ${ipv4 ?? '(pending)'}`);

  if (supabaseUrl && supabaseKey) {
    line('Inserting hosting_servers row…');
    const res = await fetch(`${supabaseUrl}/rest/v1/hosting_servers`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        name,
        provider: 'hetzner',
        hetzner_server_id: String(server.id),
        ipv4,
        location,
        server_type: serverType,
        status: 'provisioning',
        deploy_agent_url: ipv4 ? `https://${ipv4}:8443` : null,
        deploy_agent_secret_ref: paidSecretRef,
        site_capacity: DEFAULTS.siteCapacity,
        cloud_init_version: cloudInit.version,
        notes: `Runs the previews deploy-agent on :8444 and caddy-previews on :9080. Preview zone ${previewSuffix}.`,
      }),
    });
    if (!res.ok) {
      line(`  ! hosting_servers insert failed: ${await res.text()}`);
      line('  ! The server exists. Insert the row by hand before deploying.');
    } else {
      line('  → ok');
    }
  } else {
    line(
      'Skipping hosting_servers row (no Supabase service-role credentials).'
    );
  }

  if (ipv4) {
    line(`Creating DNS A ${wildcard} → ${ipv4} (dns-only)…`);
    await cloudflare('POST', `/zones/${zoneId}/dns_records`, cloudflareToken, {
      type: 'A',
      name: wildcard,
      content: ipv4,
      ttl: 60,
      proxied: false,
      comment: `flowstarter funnel previews (${name})`,
    });
    line('  → ok');
  } else {
    line('! Server has no IPv4 yet. Create the wildcard record once it does.');
  }

  line();
  line('Set these, then restart the app:');
  line(`  FLOWSTARTER_DEPLOY_AGENT_SECRET=${paidSecret}`);
  line(`  FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL=https://${ipv4}:8444`);
  line(`  FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET=${previewsSecret}`);
  line(`  FLOWSTARTER_PREVIEW_DOMAIN_SUFFIX=${previewSuffix}`);
  line(`  CLOUDFLARE_ZONE_ID=${zoneId}`);
  line();
  line('These are the only time these secrets are printed. Store them now.');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
