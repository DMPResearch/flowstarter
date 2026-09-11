import 'server-only';

/**
 * Publishing a funnel preview as a real, temporary, hosted site.
 *
 * Previews go out through the SAME deploy-agent contract a paying customer's
 * site uses — same push/remove interface, same tarball, same Caddy snippet,
 * same `systemctl reload caddy`. That is the point: the deploy path is the
 * riskiest thing we own, and it should be exercised dozens of times a day by
 * traffic that costs nothing when it breaks, rather than for the first time on
 * the day somebody pays us.
 *
 * What is NOT shared is the blast radius. Previews talk to their own agent, on
 * its own port, with its own secret, writing to its own sites root and its own
 * Caddy config directory, reloading its own Caddy instance. A malformed
 * LLM-generated preview can take down every preview on the box and cannot take
 * down a single paying customer, because the paid Caddy's config never imports
 * anything the previews agent writes. `previewsDeployAgentFromEnv` reads
 * FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL / _SECRET and nothing else — the
 * paid-site variables are not fallbacks, and a misconfiguration must fail
 * loudly rather than quietly deploy a preview onto the customer host.
 *
 * Three properties every published preview has:
 *
 *  - an UNGUESSABLE hostname. 16 bytes of CSPRNG, never the business name.
 *    A preview carries a real business's name and copy nobody has approved;
 *    a competitor who knows the business exists must not be able to type its
 *    preview URL.
 *  - NOINDEX, twice. `<meta name="robots">` in every HTML file of the manifest
 *    (see `site-archive.ts`) and `X-Robots-Tag` from the Caddy snippet.
 *  - a TTL. Recorded on the row; `preview-reaper.ts` acts on it.
 *
 * When the previews agent is not configured — which is true right now, because
 * no host exists yet — this uses `DryRunDeployAgentClient` and records
 * `deploy_status = 'pending'` with a detail saying so. It never reports a
 * preview as live that isn't.
 */

import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import {
  DryRunDeployAgentClient,
  HttpDeployAgentClient,
  type DeployAgentClient,
} from './deploy';
import {
  markFunnelPreviewDeployment,
  loadFunnelPreview,
  saveFunnelPreview,
  signFunnelPreviewArtifact,
  uploadFunnelPreviewArtifact,
  type FunnelPreviewDeployStatus,
} from './funnel-previews';
import { NOINDEX_HEADER_VALUE, packPreviewTarball } from './site-archive';
import type { ArchiveFile } from './site-archive';

type Client = SupabaseClient<Database>;

/**
 * The DNS zone every preview hostname sits under. It has to match the wildcard
 * A record (`*.preview.flowstarter.net`, dns-only so Caddy can answer the ACME
 * HTTP-01 challenge itself) and the previews Caddy's wildcard site block, so it
 * is one constant rather than three.
 *
 * Not `previewDomainForSlug` from `deploy.ts`: that derives its domain from
 * PLATFORM_DOMAIN — the domain the APP is served on, which is free to differ
 * per environment — while a preview hostname has to resolve to the one host
 * the wildcard record points at. Same `{slug}.preview.{zone}` shape; a pinned
 * zone.
 */
export const PREVIEW_DOMAIN_SUFFIX =
  process.env.FLOWSTARTER_PREVIEW_DOMAIN_SUFFIX?.trim() ||
  'preview.flowstarter.net';

/** `p-` + 16 hex chars. Matches the deploy-agent's slug grammar. */
const SLUG_PATTERN = /^p-[0-9a-f]{16}$/;

export class PreviewPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewPublishError';
  }
}

/**
 * True when a root `index.html` is present — the one thing an Astro dist/
 * build always has and raw Astro source never does (its entry point is
 * `src/pages/index.astro`, not `index.html`). Caddy serves `/` straight off
 * the site directory, so this is both the cheapest and the most direct check
 * that what is about to be deployed is a compiled site rather than source.
 */
export function hasRootIndexHtml(files: readonly ArchiveFile[]): boolean {
  return files.some((file) => file.path.trim().toLowerCase() === 'index.html');
}

/**
 * A site slug with 64 bits of entropy and no relationship whatsoever to the
 * business. Derivable from nothing the visitor typed, so it cannot be guessed
 * from the company name, the domain they want, or the preview id in the
 * unlock link.
 */
export function funnelPreviewSlug(): string {
  return `p-${randomBytes(8).toString('hex')}`;
}

export function isFunnelPreviewSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** `{slug}.preview.flowstarter.net`. */
export function funnelPreviewHostname(slug: string): string {
  if (!isFunnelPreviewSlug(slug)) {
    throw new PreviewPublishError(`"${slug}" is not a preview slug`);
  }
  return `${slug}.${PREVIEW_DOMAIN_SUFFIX}`;
}

/** The slug back out of a hostname we minted, for teardown. */
export function slugFromPreviewHostname(hostname: string): string | null {
  const suffix = `.${PREVIEW_DOMAIN_SUFFIX}`;
  if (!hostname.endsWith(suffix)) return null;
  const slug = hostname.slice(0, -suffix.length);
  return isFunnelPreviewSlug(slug) ? slug : null;
}

export interface PreviewAgentConfig {
  deployAgentUrl: string;
  sharedSecret: string;
  client: DeployAgentClient;
  /** False when nothing is configured and this is a dry run. */
  configured: boolean;
}

/**
 * The PREVIEWS agent, and only it.
 *
 * `FLOWSTARTER_DEPLOY_AGENT_SECRET` / the per-server `deploy_agent_url` in
 * `hosting_servers` are the paid-site path and are deliberately not consulted
 * here. A preview must never be pushed to the host that serves customers, and
 * the way to guarantee that is to have no code path that could.
 */
export function previewsDeployAgentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): PreviewAgentConfig {
  const url = env.FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL?.trim();
  const secret = env.FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET?.trim();
  if (!url || !secret) {
    return {
      deployAgentUrl: url ?? '',
      sharedSecret: '',
      client: new DryRunDeployAgentClient(),
      configured: false,
    };
  }
  return {
    deployAgentUrl: url,
    sharedSecret: secret,
    client: new HttpDeployAgentClient(fetchImpl),
    configured: true,
  };
}

export interface PublishFunnelPreviewInput {
  previewId: string;
  /**
   * The generated site's SOURCE — Astro pages, components, `package.json`.
   * Never deployed as-is (a static Caddy cannot serve Astro source); this is
   * what makes a preview claimable, stashed verbatim in the manifest.
   */
  files: readonly ArchiveFile[];
  /**
   * The compiled `dist/` output — what actually gets tarred, uploaded and
   * pushed to the previews deploy-agent. Falls back to {@link files} when
   * omitted, which {@link hasRootIndexHtml} then almost always refuses (raw
   * Astro source has no root `index.html`): a caller with no compiled output
   * should not silently deploy the source instead, so the fallback fails
   * closed rather than resurrecting the old source-only behaviour.
   */
  builtFiles?: readonly ArchiveFile[];
  templateSlug?: string | null;
  templateVersion?: string | null;
  brandConfig?: unknown;
  /** Defaults to the previews agent from env (dry run when unconfigured). */
  agent?: PreviewAgentConfig;
  supabase?: Client;
  /** Test seam. */
  now?: Date;
}

export interface PublishFunnelPreviewResult {
  previewId: string;
  slug: string;
  hostname: string;
  url: string;
  status: FunnelPreviewDeployStatus;
  /** Null when live; the reason otherwise. Never a secret. */
  detail: string | null;
  artifactPath: string | null;
  /** True when the bytes went to a real agent rather than a dry run. */
  published: boolean;
}

/**
 * Packages, stores and deploys one preview.
 *
 * Order matters. The row and the artifact are written BEFORE the agent is
 * called, so a deploy that fails still leaves a claimable preview: the visitor
 * loses the hosted URL, not the site they were looking at. The row is then
 * updated with whatever the agent actually did.
 */
export async function publishFunnelPreview(
  input: PublishFunnelPreviewInput
): Promise<PublishFunnelPreviewResult> {
  if (input.files.length === 0) {
    throw new PreviewPublishError('cannot publish a preview with no files');
  }

  const agent = input.agent ?? previewsDeployAgentFromEnv();
  const existing = await loadFunnelPreview(input.previewId, {
    includeExpired: true,
    supabase: input.supabase,
  });

  // Re-publishing the same preview keeps its hostname, so a visitor who
  // refreshes mid-generation does not get a second live site (and a second
  // thing to tear down) at a different URL.
  const slug =
    (existing?.hostname && slugFromPreviewHostname(existing.hostname)) ||
    funnelPreviewSlug();
  const hostname = funnelPreviewHostname(slug);
  const url = `https://${hostname}`;

  // What actually goes out to the deploy-agent. `files` (source) is never a
  // valid deploy target on its own — see PublishFunnelPreviewInput.builtFiles.
  const deployFiles = input.builtFiles ?? input.files;
  const deployable = deployFiles.length > 0 && hasRootIndexHtml(deployFiles);

  // rememberClaimablePreview writes the full manifest — files AND the intake
  // the claim later needs. Overwriting it with { files } minted workspaces
  // with no intake: the claim found nothing, the workspace stayed in INTAKE,
  // and the deposit was refused. Preserve whatever the row already carries
  // and only refresh the keys this publisher actually owns.
  //
  // The manifest always stores `input.files` (source), never `deployFiles`:
  // it is what the claim rebuilds the workspace from, and a claim rebuilt
  // from compiled dist/ output would have nothing left to personalize.
  const existingManifest =
    existing?.manifest && typeof existing.manifest === 'object'
      ? (existing.manifest as Record<string, unknown>)
      : {};
  const persistManifest = (artifactPath: string | null) =>
    saveFunnelPreview({
      previewId: input.previewId,
      templateSlug: input.templateSlug ?? existing?.templateSlug ?? null,
      templateVersion:
        input.templateVersion ?? existing?.templateVersion ?? null,
      brandConfig: input.brandConfig ?? existing?.brandConfig ?? {},
      manifest: { ...existingManifest, files: input.files },
      artifactPath,
      ...(input.supabase ? { supabase: input.supabase } : {}),
    });

  if (!deployable) {
    // The manifest still gets written — a preview with no compiled output
    // is exactly as claimable as one the deploy-agent rejected outright, and
    // must not cost the visitor that claim. What it must never do is tar up
    // Astro source and hand it to a static Caddy as if it were a site.
    await persistManifest(null);
    const detail =
      'the preview has no compiled dist/ output (no root index.html), so ' +
      'it cannot be served as a static site; the manifest is still claimable';
    await markFunnelPreviewDeployment({
      previewId: input.previewId,
      hostname,
      status: 'failed',
      error: detail,
      ...(input.supabase ? { supabase: input.supabase } : {}),
    });
    return {
      previewId: input.previewId,
      slug,
      hostname,
      url,
      status: 'failed',
      detail,
      artifactPath: null,
      published: false,
    };
  }

  const tarball = packPreviewTarball(deployFiles);

  const artifactPath = await uploadFunnelPreviewArtifact({
    previewId: input.previewId,
    tarball,
    supabase: input.supabase,
  });

  await persistManifest(artifactPath);

  if (!agent.configured) {
    const detail =
      'previews deploy-agent is not configured ' +
      '(FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL / _SECRET); ' +
      'the preview was packaged and stored but no site was deployed';
    await markFunnelPreviewDeployment({
      previewId: input.previewId,
      hostname,
      status: 'pending',
      error: detail,
      ...(input.supabase ? { supabase: input.supabase } : {}),
    });
    // Still exercise the client, so the dry run records the arguments the real
    // call would have made — including the size of the tarball that would
    // have gone out.
    await agent.client.push({
      deployAgentUrl: agent.deployAgentUrl || 'dry-run://previews',
      sharedSecret: agent.sharedSecret,
      siteSlug: slug,
      artifact: artifactPath
        ? { kind: 'url', url: `storage://${artifactPath}` }
        : { kind: 'bytes', bytes: toArrayBuffer(tarball) },
      primaryDomain: hostname,
      additionalDomains: [],
    });
    return {
      previewId: input.previewId,
      slug,
      hostname,
      url,
      status: 'pending',
      detail,
      artifactPath,
      published: false,
    };
  }

  // The agent fetches the artifact itself from a URL by default — that is the
  // only shape its `POST /sites/:slug/deploy` accepts in production, and it
  // keeps a 20MB tarball out of this process's request path. That contract
  // cannot hold against a local deploy-agent, which has no way to fetch a
  // signed URL pointing at 127.0.0.1. FLOWSTARTER_PREVIEW_ARTIFACT_TRANSPORT=
  // bytes is the explicit, server-only opt-out for that case: the durable
  // Storage upload above still happens either way (still the record a
  // redeploy or an audit reads), only the deploy call itself skips the
  // sign-and-fetch round trip in favour of the bytes HttpDeployAgentClient
  // already knows how to send.
  const useBytesTransport =
    process.env.FLOWSTARTER_PREVIEW_ARTIFACT_TRANSPORT?.trim().toLowerCase() ===
    'bytes';

  let artifact:
    | { kind: 'url'; url: string }
    | { kind: 'bytes'; bytes: ArrayBuffer };
  if (useBytesTransport) {
    artifact = { kind: 'bytes', bytes: toArrayBuffer(tarball) };
  } else {
    const signed = artifactPath
      ? await signFunnelPreviewArtifact({
          path: artifactPath,
          ...(input.supabase ? { supabase: input.supabase } : {}),
        })
      : null;

    if (!signed) {
      // No URL means no deploy. Saying so is the whole point: pushing raw
      // bytes the agent would reject with a 400 would look like a deploy
      // attempt and leave nobody any wiser about the actual problem (Storage).
      const detail =
        'the preview artifact could not be stored or signed, so the previews ' +
        'agent has nothing to fetch; the manifest is still claimable';
      await markFunnelPreviewDeployment({
        previewId: input.previewId,
        hostname,
        status: 'failed',
        error: detail,
        ...(input.supabase ? { supabase: input.supabase } : {}),
      });
      return {
        previewId: input.previewId,
        slug,
        hostname,
        url,
        status: 'failed',
        detail,
        artifactPath,
        published: false,
      };
    }
    artifact = { kind: 'url', url: signed };
  }

  try {
    await agent.client.push({
      deployAgentUrl: agent.deployAgentUrl,
      sharedSecret: agent.sharedSecret,
      siteSlug: slug,
      artifact,
      primaryDomain: hostname,
      additionalDomains: [],
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'previews deploy-agent failed';
    await markFunnelPreviewDeployment({
      previewId: input.previewId,
      hostname,
      status: 'failed',
      error: detail,
      ...(input.supabase ? { supabase: input.supabase } : {}),
    });
    return {
      previewId: input.previewId,
      slug,
      hostname,
      url,
      status: 'failed',
      detail,
      artifactPath,
      published: false,
    };
  }

  await markFunnelPreviewDeployment({
    previewId: input.previewId,
    hostname,
    status: 'live',
    error: null,
    ...(input.supabase ? { supabase: input.supabase } : {}),
  });

  return {
    previewId: input.previewId,
    slug,
    hostname,
    url,
    status: 'live',
    detail: null,
    artifactPath,
    published: true,
  };
}

export interface UnpublishResult {
  previewId: string;
  hostname: string | null;
  removed: boolean;
  detail: string | null;
}

/**
 * Tears the hosted site down. Leaves the row (marked `removed`) and, for a
 * claimed preview, everything under the client's tenant prefix: this removes a
 * temporary site, it does not delete anybody's work.
 */
export async function unpublishFunnelPreview(input: {
  previewId: string;
  hostname?: string | null;
  agent?: PreviewAgentConfig;
  supabase?: Client;
}): Promise<UnpublishResult> {
  const agent = input.agent ?? previewsDeployAgentFromEnv();
  let hostname = input.hostname ?? null;
  if (!hostname) {
    const row = await loadFunnelPreview(input.previewId, {
      includeExpired: true,
      ...(input.supabase ? { supabase: input.supabase } : {}),
    });
    hostname = row?.hostname ?? null;
  }
  const slug = hostname ? slugFromPreviewHostname(hostname) : null;

  if (!slug) {
    // Nothing was ever deployed under a hostname we recognise. Recording it as
    // removed is honest: there is no site.
    await markFunnelPreviewDeployment({
      previewId: input.previewId,
      status: 'removed',
      error: null,
      ...(input.supabase ? { supabase: input.supabase } : {}),
    });
    return {
      previewId: input.previewId,
      hostname,
      removed: true,
      detail: 'no hosted site to remove',
    };
  }

  try {
    await agent.client.remove({
      deployAgentUrl: agent.deployAgentUrl || 'dry-run://previews',
      sharedSecret: agent.sharedSecret,
      siteSlug: slug,
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'previews deploy-agent failed';
    return { previewId: input.previewId, hostname, removed: false, detail };
  }

  await markFunnelPreviewDeployment({
    previewId: input.previewId,
    status: 'removed',
    error: null,
    ...(input.supabase ? { supabase: input.supabase } : {}),
  });
  return {
    previewId: input.previewId,
    hostname,
    removed: true,
    detail: agent.configured ? null : 'dry run: previews agent not configured',
  };
}

/**
 * The `X-Robots-Tag` value the previews Caddy snippet must carry. Exported so
 * the deploy-agent's snippet builder and this module cannot drift.
 */
export const PREVIEW_ROBOTS_HEADER = NOINDEX_HEADER_VALUE;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
