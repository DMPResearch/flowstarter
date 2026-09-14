/**
 * The DMPResearch discovery call: where it is booked, and what happens when it
 * is not configured.
 *
 * Custom work is not a Flowstarter product. It is contracted through
 * DMPResearch, Darius's studio, after a call -- so the funnel's custom branch
 * ends at a booking page belonging to a person, not at a checkout. That page
 * is an event type on the Cal.com the platform hosts itself (see
 * `docs/operations/cal.md` and `./cal-provisioning`), and this module is the
 * one place that knows its address.
 *
 * Two variables, in the house shape: a pure function over an env record,
 * defaulting to `process.env`, with the defaults written down.
 *
 *   DMPRESEARCH_DISCOVERY_CAL_URL   the whole URL, when Darius wants to name it
 *   CAL_BASE_URL                    the platform's own Cal.com, already read by
 *                                   `./cal-link` and `./cal-provisioning`
 *
 * With neither set there is no booking page, and that is a supported state
 * rather than a broken one: `/discovery-call` shows a contact form, the form
 * files a `custom_work_leads` row exactly as a booking would, and Darius gets
 * the same lead by email. A laptop and a fresh preview deploy both land here.
 * What must never happen is the funnel promising a call it cannot offer, which
 * is what the marketing pages did until this shipped.
 *
 * ── Why the URL is parsed rather than concatenated ────────────────────────
 * The result is put in an iframe and in an anchor on a page we serve. A value
 * that is almost a booking link -- an http one, a settings page, a paste with a
 * path three segments deep -- is not a calendar, it is somebody else's page
 * inside ours. `parseCalLink` already owns that judgement for client-supplied
 * links and it owns it here too. A malformed value yields null, which shows the
 * contact form: failing to the form is always better than embedding a 404.
 */
import { calLinkHosts, parseCalLink, type CalHostEnv } from './cal-link';

/** The Cal.com user the call belongs to. Darius's own, not a workspace's. */
export const DISCOVERY_CALL_HANDLE = 'darius';
/** The event type's slug on that user. */
export const DISCOVERY_CALL_SLUG = 'discovery-call';

export interface DiscoveryCallEnv extends CalHostEnv {
  DMPRESEARCH_DISCOVERY_CAL_URL?: string;
}

/**
 * The booking page, or null when this environment has none.
 *
 * An explicit `DMPRESEARCH_DISCOVERY_CAL_URL` wins and is trusted on its own
 * host: an operator writing out a whole URL is making the allow-list decision
 * themselves, and refusing it because `CAL_BASE_URL` happens to name a
 * different instance would be this module second-guessing the person who
 * configured it. The shape is still checked -- https, a booking path, not a
 * Cal.com settings page -- because a typo is not a decision.
 *
 * Without it, the default is the platform's own Cal.com plus Darius's event
 * type, which is exactly what `CAL_BASE_URL` already means everywhere else.
 */
export function discoveryCallUrl(
  env: DiscoveryCallEnv = process.env as DiscoveryCallEnv
): string | null {
  const explicit = env.DMPRESEARCH_DISCOVERY_CAL_URL?.trim();
  if (explicit) {
    let host: string;
    try {
      host = new URL(
        explicit.includes('://') ? explicit : `https://${explicit}`
      ).hostname.toLowerCase();
    } catch {
      console.warn(
        '[discovery-call] DMPRESEARCH_DISCOVERY_CAL_URL is not a URL; falling back to the contact form'
      );
      return null;
    }
    const parsed = parseCalLink(explicit, { hosts: [host] });
    if (!parsed.ok) {
      console.warn(
        `[discovery-call] DMPRESEARCH_DISCOVERY_CAL_URL is not a booking page (${parsed.reason}); falling back to the contact form`
      );
      return null;
    }
    return parsed.link.url;
  }

  const base = env.CAL_BASE_URL?.trim();
  if (!base) return null;
  const candidate = `${base.replace(
    /\/+$/,
    ''
  )}/${DISCOVERY_CALL_HANDLE}/${DISCOVERY_CALL_SLUG}`;
  const parsed = parseCalLink(candidate, { hosts: calLinkHosts(env) });
  return parsed.ok ? parsed.link.url : null;
}

/** True when a visitor can be shown a calendar rather than a form. */
export function isDiscoveryCallConfigured(
  env: DiscoveryCallEnv = process.env as DiscoveryCallEnv
): boolean {
  return discoveryCallUrl(env) !== null;
}

export interface DiscoveryCallVisitor {
  name?: string;
  email?: string;
}

/**
 * Cal.com's prefill parameters. Both are documented query params on a booking
 * page and neither is a secret: they arrive from the visitor's own answers and
 * go back onto the visitor's own screen.
 */
const PREFILL_NAME = 'name';
const PREFILL_EMAIL = 'email';

/** Longer than any real name or address; short enough that a paste is refused. */
const MAX_PREFILL_CHARS = 320;

function prefillValue(raw: string | undefined): string | null {
  const trimmed = (raw ?? '').trim().slice(0, MAX_PREFILL_CHARS);
  return trimmed || null;
}

/**
 * The booking URL with the visitor's name and email already filled in, or null
 * when there is no booking page in this environment.
 *
 * Prefilling is the whole reason this is a function and not a constant: the
 * visitor has just typed their name and address into the intake, and asking
 * for them again on the very next screen is how a funnel loses somebody who
 * had already said yes.
 */
export function discoveryCallBookingUrl(
  visitor: DiscoveryCallVisitor = {},
  env: DiscoveryCallEnv = process.env as DiscoveryCallEnv
): string | null {
  const base = discoveryCallUrl(env);
  if (!base) return null;

  const url = new URL(base);
  const name = prefillValue(visitor.name);
  const email = prefillValue(visitor.email);
  if (name) url.searchParams.set(PREFILL_NAME, name);
  if (email) url.searchParams.set(PREFILL_EMAIL, email);
  return url.toString();
}

/**
 * The embed source for the booking page, when there is one.
 *
 * Cal.com serves `<booking page>/embed` for exactly this, and the prefill
 * parameters survive the suffix, so a visitor sees the calendar with their own
 * details already in it without a second form.
 */
export function discoveryCallEmbedSrc(
  visitor: DiscoveryCallVisitor = {},
  env: DiscoveryCallEnv = process.env as DiscoveryCallEnv
): string | null {
  const booking = discoveryCallBookingUrl(visitor, env);
  if (!booking) return null;
  const url = new URL(booking);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/embed`;
  url.searchParams.set('layout', 'month_view');
  return url.toString();
}

/** The page both the funnel and the marketing copy send people to. */
export const DISCOVERY_CALL_PATH = '/discovery-call';
