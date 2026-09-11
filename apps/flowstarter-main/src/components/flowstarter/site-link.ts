/**
 * Where the client can actually see their site.
 *
 * There is no `preview_url` or `live_url` column: a workspace's hostnames live
 * in `workspace_hosts` (one row flagged `is_primary`), and everything else is
 * derived from the slug by `deployedSiteUrl`, the same helper the deploy and
 * the build worker's callback use, so the base domain is never hardcoded and
 * the dashboard cannot disagree with the deploy about where the site is. A
 * link is only offered once `deploy_status` says something has actually been
 * deployed: a dead link is worse than none.
 */
import { deployedSiteUrl, type EnvLike } from '@/lib/hosting/site-urls';

export interface SiteLink {
  kind: 'live' | 'preview';
  href: string;
  hostname: string;
  label: string;
}

export interface SiteLinkInput {
  slug: string | null | undefined;
  deployStatus: string | null | undefined;
  hosts: Array<{ hostname: string; is_primary: boolean | null }>;
  /** Injectable so a test can describe an environment it is not running in. */
  env?: EnvLike;
}

/** Deploy states in which something is genuinely being served. */
const SERVING = new Set(['live', 'deploying']);

export function resolveSiteLink({
  slug,
  deployStatus,
  hosts,
  env,
}: SiteLinkInput): SiteLink | null {
  if (!SERVING.has(deployStatus ?? '')) return null;

  const primary = hosts.find((host) => host.is_primary)?.hostname;
  if (primary) {
    return {
      kind: 'live',
      hostname: primary,
      href: `https://${primary}`,
      label: 'View your site',
    };
  }

  if (!slug) return null;
  // `deployedSiteUrl` is the same resolution the deploy itself and the build
  // worker's callback use, so the link the dashboard offers is the link the
  // site is actually being served at. It matters most where there is no
  // preview host: a full end-to-end run on one machine published to the local
  // deploy agent and the dashboard still pointed at
  // `<slug>.preview.flowstarter.dev`, a name that resolves nowhere, so the one
  // link the client was given was the one thing in the flow that did not work.
  const href = deployedSiteUrl({ slug, ...(env ? { env } : {}) });
  return {
    kind: 'preview',
    hostname: href.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    href,
    label: 'View your preview',
  };
}
