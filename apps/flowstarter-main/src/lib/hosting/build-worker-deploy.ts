/**
 * The build worker's way in to `deploySite`.
 *
 * The worker finishes a build on a compute host and has a tarball; it cannot
 * import this app's Supabase clients, and it must not talk to the deploy-agent
 * itself, because the `deployments` ledger, the version counter and the DNS
 * upsert all live here. So it posts the artifact URL and this runs the same
 * `deploySite` the operator's own deploy button runs.
 *
 * Authorization is the shared dispatch secret — the worker already holds it
 * (flowstarter-main signs every dispatch with it), it is server-side only, and
 * it is compared in constant time. There is no user session on this path by
 * design: the caller is a service, and a session check would only make it
 * impersonate one.
 */

import { timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { CloudflareClient } from './cloudflare';
import {
  deploySite,
  DryRunDeployAgentClient,
  HttpDeployAgentClient,
  type DeployAgentClient,
} from './deploy';
import { resolveFlowstarterEnv } from '../supabase-target';
import { deployedSiteUrl, type EnvLike } from './site-urls';

/** Minimum length the dispatch secret must have to be usable here. */
const MIN_SECRET_LENGTH = 32;

export function buildWorkerSecret(env: EnvLike = process.env): string | null {
  const secret = env.FLOWSTARTER_BUILD_WORKER_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

export function authorizeBuildWorker(
  header: string | null | undefined,
  env: EnvLike = process.env
): boolean {
  const secret = buildWorkerSecret(env);
  if (!secret) return false;
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  // timingSafeEqual throws on a length mismatch, so length is checked first.
  // The length of the secret is not itself a secret.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

export class ArtifactUrlError extends Error {}

/**
 * Artifacts are fetched by the deploy-agent, so the URL is attacker-relevant
 * even though the caller is trusted: it decides what bytes land on a host.
 * Production insists on HTTPS; everywhere else allows loopback, so a worker on
 * the same box can serve its own tarball with no bucket and no certificate.
 *
 * The environment is resolved through `resolveFlowstarterEnv`, NOT read off
 * `NODE_ENV` directly, and the difference is the whole reason this paragraph
 * exists. Every containerised slot runs `NODE_ENV=production`, staging
 * included — that is simply what a Next standalone build is — so
 * `FLOWSTARTER_ENV` is the only thing that can name staging at all (see
 * `lib/supabase-target.ts`). Reading `NODE_ENV` meant the staging slot took
 * production's rule and refused the loopback URL of the build worker running
 * beside it on the same host: a worker on `fs-sites-01` could claim a job,
 * build it and pass every gate, only to fail at the last step with
 * "artifactUrl must be https" over a request that never left the machine.
 *
 * Production's behaviour is unchanged. `FLOWSTARTER_ENV=production`, or a
 * plain `NODE_ENV=production` with no `FLOWSTARTER_ENV`, still insists on
 * HTTPS, because production's artifact URL is meant to be an object store and
 * a loopback one there is a worker nobody finished configuring.
 */
export function assertUsableArtifactUrl(
  raw: string,
  env: EnvLike = process.env
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArtifactUrlError('artifactUrl is not a valid URL');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol !== 'http:') {
    throw new ArtifactUrlError('artifactUrl must be http(s)');
  }
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]';
  const flowstarterEnv = resolveFlowstarterEnv(env as NodeJS.ProcessEnv);
  if (flowstarterEnv === 'production' || !loopback) {
    throw new ArtifactUrlError(
      'artifactUrl must be https (plain http is allowed only on loopback outside production)'
    );
  }
  return url;
}

export function deployAgentClientFromEnv(
  env: EnvLike = process.env
): DeployAgentClient {
  return env.DEPLOY_AGENT_DRY_RUN === 'true'
    ? new DryRunDeployAgentClient()
    : new HttpDeployAgentClient();
}

/**
 * v1 shortcut, shared with the operator deploy route: agent secrets reach the
 * app through env rather than Supabase Vault, keyed by the server's
 * `deploy_agent_secret_ref`, with a single-server global fallback for dev.
 */
export function resolveDeployAgentSecret(
  ref: string,
  env: EnvLike = process.env
): string | null {
  return env[ref.toUpperCase()] ?? env.DEPLOY_AGENT_SHARED_SECRET ?? null;
}

export interface BuildWorkerDeployResult {
  deployment: Awaited<ReturnType<typeof deploySite>>;
  /** Null when the workspace vanished between the deploy and this lookup. */
  siteUrl: string | null;
}

/**
 * Runs the deploy and answers with a URL a human can open. Callers have
 * already authorized; this does the work.
 */
export async function deployBuildArtifact(input: {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  artifactUrl: string;
  /** Required — see the route's doc comment. */
  artifactSha256: string;
  deployedBy: string;
  env?: EnvLike;
}): Promise<BuildWorkerDeployResult> {
  const env = input.env ?? process.env;
  const cloudflareToken = env.CLOUDFLARE_API_TOKEN;

  const deployment = await deploySite({
    supabase: input.supabase,
    agentClient: deployAgentClientFromEnv(env),
    cloudflare: cloudflareToken
      ? new CloudflareClient({ token: cloudflareToken })
      : null,
    cloudflareDefaultZoneId: env.CLOUDFLARE_DEFAULT_ZONE_ID ?? null,
    workspaceId: input.workspaceId,
    artifact: {
      kind: 'url',
      url: input.artifactUrl,
      sha256: input.artifactSha256,
    },
    deployedBy: input.deployedBy,
    resolveSharedSecret: async (ref) => resolveDeployAgentSecret(ref, env),
  });

  const { data: workspace } = await input.supabase
    .from('workspaces')
    .select('slug')
    .eq('id', input.workspaceId)
    .maybeSingle();
  const { data: hosts } = await input.supabase
    .from('workspace_hosts')
    .select('hostname, is_primary')
    .eq('workspace_id', input.workspaceId);

  const siteUrl = workspace?.slug
    ? deployedSiteUrl({
        slug: workspace.slug,
        primaryDomain:
          (hosts ?? []).find((host) => host.is_primary)?.hostname ?? null,
        env,
      })
    : null;

  return { deployment, siteUrl };
}
