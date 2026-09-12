/**
 * The two hostname templates an agent can be configured with, and the one
 * rule for reading them in both directions.
 *
 * A site host is written as a template rather than a suffix so the whole
 * hostname is visible in the env file an operator edits:
 *
 *   DEPLOY_AGENT_SITE_DOMAIN_TEMPLATE={slug}.flowstarter.net
 *   DEPLOY_AGENT_PREVIEW_DOMAIN_TEMPLATE={slug}.preview.flowstarter.net
 *
 * Building a host from a slug is the easy direction and the agent has always
 * done it. The other direction matters just as much: `/tls-ask` is what stands
 * between this box and an open certificate-minting service, and it can only
 * answer honestly if "is this a name I serve?" is decided by the same template
 * that produced the name in the first place.
 */

/** The placeholder every template must contain exactly once. */
export const SLUG_PLACEHOLDER = '{slug}';

/** Same grammar the router uses for a slug in a path. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * The hostname this template gives `slug`, or null when the template is unset
 * or unusable. An unset template is normal: an agent with no site domain
 * configured simply does not add one to the snippet.
 */
export function hostFromTemplate(
  template: string | undefined | null,
  slug: string,
): string | null {
  const clean = template?.trim();
  if (!clean || !clean.includes(SLUG_PLACEHOLDER)) return null;
  if (!isValidSlug(slug)) return null;
  return clean.replaceAll(SLUG_PLACEHOLDER, slug).toLowerCase();
}

/**
 * The slug a hostname would have come from under this template, or null.
 *
 * Split on the placeholder rather than matching a suffix: a template is free
 * to have a prefix one day, and a rule that only ever checked the tail would
 * quietly start accepting names it should not.
 */
export function slugFromTemplateHost(
  template: string | undefined | null,
  hostname: string,
): string | null {
  const clean = template?.trim().toLowerCase();
  if (!clean || !clean.includes(SLUG_PLACEHOLDER)) return null;
  const parts = clean.split(SLUG_PLACEHOLDER);
  // Exactly one placeholder. Two would make the split ambiguous, and there is
  // no hostname shape we want that needs it.
  if (parts.length !== 2) return null;
  const [prefix, suffix] = parts as [string, string];

  const host = hostname.trim().toLowerCase();
  if (!host.startsWith(prefix) || !host.endsWith(suffix)) return null;
  if (host.length <= prefix.length + suffix.length) return null;

  const slug = host.slice(prefix.length, host.length - suffix.length);
  return isValidSlug(slug) ? slug : null;
}
