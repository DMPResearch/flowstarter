/**
 * Where the client can actually see their site, and where they can see the
 * preview that is not it.
 *
 * Two links, because there are two things, and Darius said what separates
 * them: "the publish should be done for the final sites, the preview should
 * have a temporary URL and have the parts blurred and the final site should
 * unlock all the sections."
 *
 *   - the FINAL site: `{slug}.{platformDomain}` (or the client's own domain
 *     from `workspace_hosts`), offered once `deploy_status` says something is
 *     being served. No expiry, nothing blurred.
 *   - the PREVIEW: the temporary hostname a funnel preview was published at,
 *     offered with the date it stops working, because it does.
 *
 * There is no `preview_url` or `live_url` column: hostnames live in
 * `workspace_hosts` (one row flagged `is_primary`), and everything else is
 * derived by `deployedSiteUrl`, the same helper the deploy and the build
 * worker's callback use, so the dashboard cannot disagree with the deploy
 * about where the site is. A link is only offered once something has actually
 * been deployed: a dead link is worse than none.
 */
import en from '@/locales/en';
import { deployedSiteUrl, type EnvLike } from '@/lib/hosting/site-urls';

export interface SiteLink {
  kind: 'live';
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
      label: en['site.link.live'],
    };
  }

  if (!slug) return null;
  // `deployedSiteUrl` is the same resolution the deploy itself and the build
  // worker's callback use, so the link the dashboard offers is the link the
  // site is actually being served at. It matters most where there is no
  // hosted site yet: a full end-to-end run on one machine published to the
  // local deploy agent and the dashboard still pointed at a public name that
  // resolves nowhere, so the one link the client was given was the one thing
  // in the flow that did not work.
  const href = deployedSiteUrl({ slug, ...(env ? { env } : {}) });
  return {
    kind: 'live',
    hostname: href.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    href,
    label: en['site.link.live'],
  };
}

/**
 * One date format for the expiry, wherever it is shown.
 *
 * The wizard and the dashboard are quoting the same instant off the same
 * column, and two formats would read as two different promises. UTC on
 * purpose: the reaper works in UTC, and a date that shifts by a day depending
 * on where the reader is sitting is a date we cannot be held to.
 */
export function formatPreviewExpiry(iso: string, locale = 'en-GB'): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(at));
}

export interface PreviewLink {
  href: string;
  hostname: string;
  label: string;
  /** "Your preview link works until 26 September 2026", or the expired line. */
  expiryNote: string;
  expired: boolean;
}

export interface PreviewLinkInput {
  hostname: string | null | undefined;
  /** `funnel_previews.expires_at`. */
  expiresAt: string | null | undefined;
  /** `funnel_previews.deploy_status`. */
  deployStatus: string | null | undefined;
  now?: Date;
  /** Test seam; the client's own locale would be threaded in here. */
  locale?: string;
}

/**
 * The preview link, with the date it dies printed next to it.
 *
 * Offered only for a preview that is actually live. A `pending`, `failed` or
 * `removed` preview has no site behind its hostname, and a client who clicks
 * one learns only that we handed them a broken URL.
 *
 * An expired preview still gets a line, and deliberately no link: the reaper
 * may not have swept yet, so the URL might even answer, but telling somebody
 * their link works when we are about to delete it is the lie this whole
 * expiry rule exists to stop us telling.
 */
export function resolvePreviewLink({
  hostname,
  expiresAt,
  deployStatus,
  now = new Date(),
  locale = 'en-GB',
}: PreviewLinkInput): PreviewLink | null {
  if (!hostname || deployStatus !== 'live') return null;

  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiry)) return null;

  const expired = expiry <= now.getTime();
  const date = formatPreviewExpiry(new Date(expiry).toISOString(), locale);

  return {
    href: `https://${hostname}`,
    hostname,
    label: en['site.link.preview'],
    expiryNote: expired
      ? en['site.preview.expired']
      : en['site.preview.worksUntil'].replace('{date}', date),
    expired,
  };
}
