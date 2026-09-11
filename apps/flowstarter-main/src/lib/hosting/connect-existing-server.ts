import 'server-only';

/**
 * Connect a Hetzner server the operator already owns (bootstrapped by hand or
 * by the deploy-agent's own installer) into `hosting_servers`, instead of the
 * `/api/admin/hosting/servers` POST flow which creates a brand-new Hetzner
 * server via the Cloud API.
 *
 * Everything the agent needs to be reachable at comes from server-only env,
 * never from the caller — the route this backs takes no request body. That is
 * what keeps this from being an SSRF/exfil primitive: a caller cannot point it
 * at an arbitrary URL or make it echo back an arbitrary secret.
 *
 *   FLOWSTARTER_EXISTING_HOST_ID          — numeric Hetzner server id
 *   FLOWSTARTER_EXISTING_HOST_AGENT_URL   — https://, or http:// to a loopback
 *                                           address (local SSH tunnel)
 *   FLOWSTARTER_EXISTING_HOST_SECRET_REF  — name of another env var that holds
 *                                           the actual deploy-agent shared
 *                                           secret (never the secret itself)
 *
 * Order of checks mirrors what would be expensive or dangerous to skip:
 * config shape, then the secret it points to, then a live health probe of the
 * agent (proves the agent is up and the operator's Docker runtime is what
 * deploys expect), then Hetzner's own view of the server (proves the id is
 * real and running with a public IP) — only then does anything touch the DB.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { hetznerFromEnv, HetznerApiError, type HetznerClient } from './hetzner';

export type ConnectExistingServerErrorCode =
  | 'config_missing'
  | 'config_invalid'
  | 'secret_unavailable'
  | 'health_check_failed'
  | 'hetzner_api_failed'
  | 'server_not_ready'
  | 'db_error';

export class ConnectExistingServerError extends Error {
  constructor(public code: ConnectExistingServerErrorCode, message: string) {
    super(message);
    this.name = 'ConnectExistingServerError';
  }
}

export interface ExistingHostConfig {
  hostId: string;
  agentUrl: string;
  secretRef: string;
}

/** The only fields this ever hands back — never the agent URL or secret ref. */
const SAFE_COLUMNS =
  'id, name, provider, hetzner_server_id, ipv4, location, server_type, status, site_capacity, sites_count, created_at, updated_at';

export interface ConnectedHostingServer {
  id: string;
  name: string;
  provider: string;
  hetzner_server_id: string | null;
  ipv4: string | null;
  location: string;
  server_type: string;
  status: string;
  site_capacity: number;
  sites_count: number;
  created_at: string;
  updated_at: string;
}

// Keep the response allowlist explicit even if the database adapter returns extra columns.
function publicServer(row: ConnectedHostingServer): ConnectedHostingServer {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    hetzner_server_id: row.hetzner_server_id,
    ipv4: row.ipv4,
    location: row.location,
    server_type: row.server_type,
    status: row.status,
    site_capacity: row.site_capacity,
    sites_count: row.sites_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Reads + validates the three operator env vars. Throws `config_missing` when
 * any is absent and `config_invalid` when one is present but malformed —
 * callers use the distinction to tell "nobody set this up" from "somebody
 * fat-fingered it" without re-parsing the message.
 */
export function readExistingHostConfig(
  env: NodeJS.ProcessEnv = process.env
): ExistingHostConfig {
  const hostIdRaw = env.FLOWSTARTER_EXISTING_HOST_ID;
  const agentUrlRaw = env.FLOWSTARTER_EXISTING_HOST_AGENT_URL;
  const secretRefRaw = env.FLOWSTARTER_EXISTING_HOST_SECRET_REF;

  if (!hostIdRaw || !agentUrlRaw || !secretRefRaw) {
    throw new ConnectExistingServerError(
      'config_missing',
      'FLOWSTARTER_EXISTING_HOST_ID, FLOWSTARTER_EXISTING_HOST_AGENT_URL, and FLOWSTARTER_EXISTING_HOST_SECRET_REF must all be set'
    );
  }

  const hostId = hostIdRaw.trim();
  if (!/^\d+$/.test(hostId)) {
    throw new ConnectExistingServerError(
      'config_invalid',
      'FLOWSTARTER_EXISTING_HOST_ID must be a numeric Hetzner server id'
    );
  }

  const agentUrl = agentUrlRaw.trim();
  let parsed: URL;
  try {
    parsed = new URL(agentUrl);
  } catch {
    throw new ConnectExistingServerError(
      'config_invalid',
      'FLOWSTARTER_EXISTING_HOST_AGENT_URL must be a valid URL'
    );
  }
  const isLoopbackHttp =
    parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLoopbackHttp) {
    throw new ConnectExistingServerError(
      'config_invalid',
      'FLOWSTARTER_EXISTING_HOST_AGENT_URL must be HTTPS, or loopback HTTP for a local SSH tunnel'
    );
  }

  const secretRef = secretRefRaw.trim();
  if (!SECRET_REF_PATTERN.test(secretRef)) {
    throw new ConnectExistingServerError(
      'config_invalid',
      'FLOWSTARTER_EXISTING_HOST_SECRET_REF must be a strict uppercase env variable name'
    );
  }

  return { hostId, agentUrl, secretRef };
}

async function checkAgentHealth(opts: {
  agentUrl: string;
  secret: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<void> {
  const url = `${opts.agentUrl.replace(/\/$/, '')}/health`;

  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.secret}` },
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    throw new ConnectExistingServerError(
      'health_check_failed',
      `Could not reach the deploy-agent health endpoint: ${
        e instanceof Error ? e.message : 'network error'
      }`
    );
  }

  if (!res.ok) {
    throw new ConnectExistingServerError(
      'health_check_failed',
      `Deploy-agent health check returned HTTP ${res.status}`
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ConnectExistingServerError(
      'health_check_failed',
      'Deploy-agent health response was not valid JSON'
    );
  }

  const data = body as { ok?: unknown; siteRuntime?: unknown };
  if (data.ok !== true || data.siteRuntime !== 'docker') {
    throw new ConnectExistingServerError(
      'health_check_failed',
      'Deploy-agent health check did not report ok:true with siteRuntime:"docker"'
    );
  }
}

export async function connectExistingHostingServer(opts: {
  supabase: SupabaseClient<Database>;
  createdBy: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to a real client built from HETZNER_API_TOKEN. */
  hetznerClient?: Pick<HetznerClient, 'getServer'>;
  healthTimeoutMs?: number;
}): Promise<ConnectedHostingServer> {
  const env = opts.env ?? process.env;
  const config = readExistingHostConfig(env);

  const secret = env[config.secretRef];
  if (!secret) {
    throw new ConnectExistingServerError(
      'secret_unavailable',
      `Env var ${config.secretRef} (named by FLOWSTARTER_EXISTING_HOST_SECRET_REF) is not set`
    );
  }

  await checkAgentHealth({
    agentUrl: config.agentUrl,
    secret,
    fetchImpl: opts.fetchImpl ?? globalThis.fetch,
    timeoutMs: opts.healthTimeoutMs ?? 5_000,
  });

  let server;
  try {
    const hetzner = opts.hetznerClient ?? hetznerFromEnv(env);
    server = await hetzner.getServer(config.hostId);
  } catch (e) {
    throw new ConnectExistingServerError(
      'hetzner_api_failed',
      e instanceof HetznerApiError
        ? `${e.code}: ${e.message}`
        : e instanceof Error
        ? e.message
        : 'Hetzner API call failed'
    );
  }

  const ipv4 = server.public_net?.ipv4?.ip ?? null;
  if (server.status !== 'running' || !ipv4) {
    throw new ConnectExistingServerError(
      'server_not_ready',
      `Hetzner server ${
        config.hostId
      } must be running with a public IPv4 (status: ${server.status}, ipv4: ${
        ipv4 ?? 'none'
      })`
    );
  }

  const location = server.datacenter?.location?.name ?? 'fsn1';
  const serverType = server.server_type?.name ?? 'unknown';

  const { data: existing, error: findErr } = await opts.supabase
    .from('hosting_servers')
    .select('id')
    .eq('hetzner_server_id', config.hostId)
    .maybeSingle();
  if (findErr) {
    throw new ConnectExistingServerError('db_error', findErr.message);
  }

  // Connection metadata only — `site_capacity`/`sites_count` are never
  // touched on an existing row, since re-running this must not wipe out how
  // many sites the fleet already thinks live there.
  const metadata = {
    provider: 'hetzner' as const,
    hetzner_server_id: config.hostId,
    name: server.name,
    ipv4,
    location,
    server_type: serverType,
    deploy_agent_url: config.agentUrl,
    deploy_agent_secret_ref: config.secretRef,
    status: 'active',
    status_detail: null,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data: updated, error: updateErr } = await opts.supabase
      .from('hosting_servers')
      .update(metadata)
      .eq('id', existing.id)
      .select(SAFE_COLUMNS)
      .single();
    if (updateErr || !updated) {
      throw new ConnectExistingServerError(
        'db_error',
        updateErr?.message ?? 'Failed to update hosting_servers row'
      );
    }
    return publicServer(updated as ConnectedHostingServer);
  }

  const { data: inserted, error: insertErr } = await opts.supabase
    .from('hosting_servers')
    .insert({
      ...metadata,
      site_capacity: 50,
      sites_count: 0,
      created_by: opts.createdBy,
    })
    .select(SAFE_COLUMNS)
    .single();
  if (insertErr || !inserted) {
    throw new ConnectExistingServerError(
      'db_error',
      insertErr?.message ?? 'Failed to insert hosting_servers row'
    );
  }
  return publicServer(inserted as ConnectedHostingServer);
}
