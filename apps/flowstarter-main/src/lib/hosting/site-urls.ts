/**
 * Where a deployed site can actually be opened.
 *
 * In production every paid site is reached by hostname: its own custom domain,
 * or the `{slug}.{platform domain}` record `deploySite` claims for it. On a
 * laptop there is no wildcard DNS and no certificate, so the local deploy-agent
 * also serves what it extracted over plain HTTP, keyed by path:
 * `http://localhost:8788/{slug}/`.
 *
 * `FLOWSTARTER_LOCAL_SITE_BASE_URL` is what switches this on. It is unset in
 * production, so the hostname answer is the only one that can be given there.
 *
 * Nothing here returns a `preview.` name. A preview is a different thing with
 * a different lifetime, and it is reached through `previewSiteUrl` in
 * `site-hostnames.ts`.
 */

import { finalHostname } from './site-hostnames';

/** `process.env` is typed narrowly here; callers also pass plain literals. */
export type EnvLike = Record<string, string | undefined>;

export function localSiteBaseUrl(env: EnvLike = process.env): string | null {
  if (env.NODE_ENV === 'production') return null;
  const base = env.FLOWSTARTER_LOCAL_SITE_BASE_URL?.trim();
  return base ? base.replace(/\/$/, '') : null;
}

/**
 * The URL a human should be given for a freshly deployed workspace.
 *
 * Prefers a custom primary domain (that is what the client paid for), then the
 * local path-served URL when running against a local deploy-agent, and falls
 * back to the site's final hostname on the platform domain.
 */
export function deployedSiteUrl(input: {
  slug: string;
  primaryDomain?: string | null;
  env?: EnvLike;
}): string {
  if (input.primaryDomain) return `https://${input.primaryDomain}`;
  const local = localSiteBaseUrl(input.env ?? process.env);
  if (local) return `${local}/${input.slug}/`;
  return `https://${finalHostname(input.slug, {
    env: input.env ?? process.env,
  })}`;
}
