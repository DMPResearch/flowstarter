/**
 * The two hostname families Flowstarter serves, and nothing else.
 *
 * Darius set the model in one sentence: "the publish should be done for the
 * final sites, the preview should have a temporary URL and have the parts
 * blurred and the final site should unlock all the sections." That is two
 * namespaces with two different promises, and until this module existed the
 * code had only one:
 *
 *   PREVIEW   {previewId}.preview.{platformDomain}
 *             Temporary by rule. Unguessable, noindexed, carries the teaser
 *             with its locked sections, and has an `expires_at` the reaper
 *             acts on. Nobody has paid for it and nobody is promised it will
 *             still be there next month.
 *
 *   FINAL     {slug}.{platformDomain}
 *             What a paying client gets. Named after their workspace, indexed,
 *             every section unlocked, and no expiry. `lebadusul.flowstarter.net`
 *             is already live on exactly this shape.
 *
 * A paid site used to be minted under `{slug}.preview.{platformDomain}` — the
 * same namespace as the throwaway funnel previews, in front of the client who
 * had just paid for it, on a hostname whose whole reason for existing is that
 * it gets deleted. Two families, two functions, one module.
 *
 * Pure on purpose: no `server-only`, no Supabase, no network. The wizard, the
 * dashboard, the deploy and the DNS writer all have to agree on what a site is
 * called, and the only way they can is if there is one place that says so.
 */

import { resolvePlatformDomain } from '@flowstarter/platform-config';

/** The label under which every temporary preview hostname sits. */
export const PREVIEW_SUBDOMAIN = 'preview';

/**
 * A DNS label: lowercase letters, digits and inner hyphens, 1 to 63
 * characters, never starting or ending with a hyphen.
 *
 * This is the guard that makes a malformed hostname impossible rather than
 * unlikely. A null slug once reached the DNS writer and asked Cloudflare for
 * `null.preview.flowstarter.net`; an uppercase or dotted slug would ask for
 * a record in somebody else's zone. Both are refusals here.
 */
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The DNS limit, and the same 63 the workspace slug column is sliced to. */
export const MAX_LABEL_LENGTH = 63;

export class SiteHostnameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteHostnameError';
  }
}

/** Env is read through a plain record so every caller can be tested. */
export type HostnameEnv = Record<string, string | undefined>;

export interface HostnameOptions {
  /** Defaults to `process.env`. */
  env?: HostnameEnv;
  /** Skips resolution entirely. Used by callers that pin a zone. */
  platformDomain?: string;
}

function envOf(options: HostnameOptions | undefined): HostnameEnv {
  return options?.env ?? (process.env as HostnameEnv);
}

/** True when `value` is a usable single DNS label. */
export function isValidSiteLabel(value: unknown): value is string {
  return typeof value === 'string' && LABEL_PATTERN.test(value);
}

/**
 * The label, or a refusal naming what was wrong with it.
 *
 * Deliberately not a sanitiser. `requireSiteSlug` in `deploy.ts` strips a
 * workspace slug into shape once, at the point a workspace is allocated;
 * by the time a hostname is being built the value has either survived that
 * or it is a bug, and quietly rewriting it here would hide which.
 */
export function assertSiteLabel(
  value: unknown,
  kind: 'slug' | 'preview id' = 'slug'
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SiteHostnameError(`a site ${kind} is required`);
  }
  if (value.length > MAX_LABEL_LENGTH) {
    throw new SiteHostnameError(
      `${kind} "${value}" is longer than ${MAX_LABEL_LENGTH} characters`
    );
  }
  if (!LABEL_PATTERN.test(value)) {
    throw new SiteHostnameError(
      `${kind} "${value}" is not a valid hostname label ` +
        '(lowercase letters, digits and inner hyphens only)'
    );
  }
  return value;
}

/**
 * The root domain both families hang off. One resolver, so a preview and the
 * final site it becomes can never end up in different zones by accident.
 *
 * `resolvePlatformDomain` is the shared rule from `@flowstarter/platform-config`:
 * `.net` in production, `.dev` everywhere else, an explicit `PLATFORM_DOMAIN`
 * always winning. It is handed explicit fields rather than left to read
 * `process.env` itself, so a test can describe an environment it is not
 * running in.
 */
export function siteRootDomain(options?: HostnameOptions): string {
  const pinned = options?.platformDomain?.trim();
  if (pinned) return pinned;
  const env = envOf(options);
  const override = env.PLATFORM_DOMAIN || env.NEXT_PUBLIC_PLATFORM_DOMAIN;
  return resolvePlatformDomain({
    ...(override ? { override } : {}),
    ...(env.FLOWSTARTER_ENV ? { flowstarterEnv: env.FLOWSTARTER_ENV } : {}),
    ...(env.NODE_ENV ? { nodeEnv: env.NODE_ENV } : {}),
  });
}

/**
 * `preview.{platformDomain}` — the zone every temporary hostname lives in.
 *
 * `FLOWSTARTER_PREVIEW_DOMAIN_SUFFIX` still overrides it, because the previews
 * host answers a wildcard A record that is pinned to one zone regardless of
 * which domain the app itself is served on.
 */
export function previewZone(options?: HostnameOptions): string {
  const pinned = envOf(options).FLOWSTARTER_PREVIEW_DOMAIN_SUFFIX?.trim();
  if (pinned) return pinned.replace(/^\.+|\.+$/g, '').toLowerCase();
  return `${PREVIEW_SUBDOMAIN}.${siteRootDomain(options)}`;
}

/**
 * `{previewId}.preview.{platformDomain}`.
 *
 * Temporary by definition. Whatever is published here expires, is noindexed,
 * and shows the teaser with its locked sections.
 */
export function previewHostname(
  previewId: string,
  options?: HostnameOptions
): string {
  return `${assertSiteLabel(previewId, 'preview id')}.${previewZone(options)}`;
}

/**
 * `{slug}.{platformDomain}` — the final site.
 *
 * No `preview.` anywhere in it. This is the name a paid deploy writes DNS for
 * and the name the dashboard shows once `deploy_status` is live.
 */
export function finalHostname(slug: string, options?: HostnameOptions): string {
  return `${assertSiteLabel(slug, 'slug')}.${siteRootDomain(options)}`;
}

/** `https://{slug}.{platformDomain}`. */
export function finalSiteUrl(slug: string, options?: HostnameOptions): string {
  return `https://${finalHostname(slug, options)}`;
}

/** `https://{previewId}.preview.{platformDomain}`. */
export function previewSiteUrl(
  previewId: string,
  options?: HostnameOptions
): string {
  return `https://${previewHostname(previewId, options)}`;
}

/** True when `hostname` sits in the preview zone. */
export function isPreviewHostname(
  hostname: string,
  options?: HostnameOptions
): boolean {
  return hostname
    .trim()
    .toLowerCase()
    .endsWith(`.${previewZone(options)}`);
}

/**
 * The label back out of a preview hostname we minted, or null. Teardown needs
 * it, and a hostname from a zone we do not own must not yield one.
 */
export function labelFromPreviewHostname(
  hostname: string,
  options?: HostnameOptions
): string | null {
  const suffix = `.${previewZone(options)}`;
  const host = hostname.trim().toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return isValidSiteLabel(label) ? label : null;
}

/**
 * The label back out of a final hostname, or null.
 *
 * Only a single label counts: `acme.flowstarter.net` is a final site,
 * `p-1234.preview.flowstarter.net` is not, and neither is anything in a zone
 * that is not ours. The deploy agent's TLS ask uses the same rule to decide
 * whether it is allowed to have a certificate minted for a name.
 */
export function labelFromFinalHostname(
  hostname: string,
  options?: HostnameOptions
): string | null {
  const suffix = `.${siteRootDomain(options)}`;
  const host = hostname.trim().toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return isValidSiteLabel(label) ? label : null;
}
