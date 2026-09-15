/**
 * The origins the app is allowed to put inside an iframe, derived from the
 * same variables that produce the URLs it frames.
 *
 * The booking calendar is the case this exists for. `CAL_BASE_URL` names the
 * Cal.com the platform hosts itself, `DMPRESEARCH_DISCOVERY_CAL_URL` names a
 * whole booking page when an operator writes one out, and the funnel's custom
 * work branch embeds whichever of those it resolved. A CSP that allow-listed
 * `cal.com` by hand was correct for exactly one deployment and blocked the
 * embed on every other one: a self-hosted instance at `cal.flowstarter.dev`
 * rendered as "This content is blocked", on the one screen whose only call to
 * action is that calendar.
 *
 * So the allow-list is derived rather than written. One rule, one place, and
 * an operator who repoints `CAL_BASE_URL` gets a CSP that follows without
 * anybody remembering to edit a second list.
 *
 * Pure, and takes its environment as an argument, like the rest of this
 * package: a CSP test has to be able to describe an environment it is not
 * running in.
 *
 * ── What is refused ───────────────────────────────────────────────────────
 * Only `https:` origins. A CSP entry is a standing permission to frame
 * somebody, and a plain-http value in a deployment's environment is either a
 * mistake or a downgrade attack on the one screen we ask a visitor to hand
 * over a calendar booking on. A value that is not a URL at all yields nothing
 * rather than a literal, because a malformed allow-list entry is silently
 * ignored by the browser and would look like it worked.
 */

/** The environment variables that name a calendar this app may frame. */
export interface CalEmbedEnvInput {
  /** The platform's own Cal.com, e.g. `https://cal.flowstarter.dev`. */
  CAL_BASE_URL?: string;
  /** A whole booking page, when an operator names one explicitly. */
  DMPRESEARCH_DISCOVERY_CAL_URL?: string;
}

/**
 * The Cal.com origins every deployment may frame regardless of configuration.
 *
 * Kept because the Astro templates embed a client's own cal.com booking link,
 * which is a different URL from the platform's instance and is not named by
 * any environment variable.
 */
export const HOSTED_CAL_FRAME_ORIGINS: readonly string[] = [
  'https://cal.com',
  'https://*.cal.com',
];

function httpsOrigin(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(
      trimmed.includes('://') ? trimmed : `https://${trimmed}`,
    );
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Every origin a booking calendar can be served from in this environment.
 *
 * The hosted cal.com entries first, then whatever the two variables resolve
 * to, de-duplicated and in a stable order so the CSP header is the same string
 * on every request.
 */
export function calEmbedOrigins(
  env: CalEmbedEnvInput = {} as CalEmbedEnvInput,
): string[] {
  const derived = [
    httpsOrigin(env.CAL_BASE_URL),
    httpsOrigin(env.DMPRESEARCH_DISCOVERY_CAL_URL),
  ].filter((origin): origin is string => origin !== null);

  const out: string[] = [];
  for (const origin of [...HOSTED_CAL_FRAME_ORIGINS, ...derived]) {
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}
