/**
 * What a string sent by somebody else's website is allowed to be before it is
 * stored under a client's workspace.
 *
 * TWO SOURCES, ONE RULE. A visitor's contact form on a generated site posts to
 * `/api/leads/capture/{token}`; Cal.com posts an attendee's name and address to
 * `/api/integrations/cal/{workspaceId}`. Neither caller is us. Both end up as
 * rows a client reads on their dashboard and as text in an email that lands in
 * their inbox, so both go through the same rule on the way in, and the rule is
 * a pure function of its arguments so it can be argued about without a request.
 *
 * WHAT IT IS NOT. This is not the thing that stops cross-site scripting. React
 * escapes what it renders and `email-templates/base.ts` escapes every block it
 * draws; that is where markup is neutralised, and it is neutralised there
 * whether or not this file exists. Storing pre-escaped text would make the two
 * layers fight — a client would read `&lt;b&gt;` in their own enquiry — so
 * nothing here escapes anything. What it does is narrower and it is the part
 * escaping cannot do:
 *
 *   - A NUL byte is refused outright. Postgres `text` and `jsonb` cannot hold
 *     one; an insert carrying it fails, and on the Cal.com webhook a failed
 *     insert is a 500 and a delivery retried forever. A refusal at the edge is
 *     a bounded answer instead of a poisoned queue.
 *   - Control characters are stripped. They are invisible in every surface
 *     that renders them and are how a name is made to look like two columns in
 *     a CSV export, or a log line like two log lines.
 *   - The invisible formatting characters are stripped: zero width spaces,
 *     the bidirectional overrides, the word joiners, the byte order mark. A
 *     name containing U+202E reads backwards from that point on in every
 *     dashboard and every mail client, and the sender chose it.
 *   - Unicode is normalised to NFC, so the same name compares equal to itself
 *     however the sender's keyboard composed it.
 *   - Lengths are capped from configuration, never from a literal at a call
 *     site.
 *   - Markup is REFUSED in the contact form's own structured fields — a name,
 *     an email address, a phone number, a page path — because an angle bracket
 *     in one of those is never a person and refusing costs nobody anything.
 *     It is KEPT VERBATIM in a free-text message and in everything Cal.com
 *     sends, because a person writing "if a < b" to a small business has done
 *     nothing wrong, and a booking is not worth losing over an attendee's
 *     punctuation. Both are escaped at render, by React and by
 *     `email-templates/base.ts`, which is where they were always going to be
 *     made safe.
 */
import { positiveIntFromEnv, type EnvLike } from '@/lib/net/net-config';

// ─── Limits ────────────────────────────────────────────────────────────────

/**
 * The defaults are the policy. Every one is overridable by an operator so the
 * numbers live in configuration rather than in the parser, which is the same
 * shape `net-config.ts` uses for the byte caps next door.
 */
export const DEFAULT_INBOUND_LIMITS = {
  name: 200,
  email: 320,
  phone: 50,
  message: 5_000,
  page: 300,
  /** A Cal.com event title or slug, and anything else of that kind. */
  title: 500,
} as const;

export const INBOUND_LIMIT_ENV_VARS = {
  name: 'FLOWSTARTER_INBOUND_MAX_NAME',
  email: 'FLOWSTARTER_INBOUND_MAX_EMAIL',
  phone: 'FLOWSTARTER_INBOUND_MAX_PHONE',
  message: 'FLOWSTARTER_INBOUND_MAX_MESSAGE',
  page: 'FLOWSTARTER_INBOUND_MAX_PAGE',
  title: 'FLOWSTARTER_INBOUND_MAX_TITLE',
} as const;

export type InboundLimits = Record<keyof typeof DEFAULT_INBOUND_LIMITS, number>;

/** The length policy, read from the environment it is handed. */
export function inboundLimits(env: EnvLike = process.env): InboundLimits {
  const out = {} as InboundLimits;
  for (const field of Object.keys(DEFAULT_INBOUND_LIMITS) as Array<
    keyof InboundLimits
  >) {
    out[field] = positiveIntFromEnv(
      env[INBOUND_LIMIT_ENV_VARS[field]],
      DEFAULT_INBOUND_LIMITS[field]
    );
  }
  return out;
}

// ─── The rule ──────────────────────────────────────────────────────────────

export type InboundRejection = 'null_byte' | 'markup' | 'too_long';

export type InboundOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: InboundRejection };

export interface InboundRule {
  /** Characters, after normalisation and stripping. From configuration. */
  limit: number;
  /**
   * `reject` for a field markup can only ever be an attack in; `text` for one
   * a person writes prose into, where angle brackets survive as characters and
   * the renderer is what keeps them from being tags.
   */
  markup: 'reject' | 'text';
  /** True only for a message. A name is one line, whatever was pasted in. */
  multiline?: boolean;
  /** What an over-long value gets. A page path is trimmed; a name is refused. */
  onOverflow?: 'reject' | 'truncate';
}

/**
 * Every character that is either invisible or changes the direction of what
 * follows it. Stripped rather than refused: a sender who pasted a name out of
 * a web page should get their name, not an error about U+200B.
 *
 * Written as ranges rather than a `\p{C}` class on purpose — `\p{Cf}` would
 * also take the Arabic and Indic joiners, which are letters doing their job in
 * a real name.
 */
const INVISIBLE =
  /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/**
 * C0 (keeping tab and the newlines for now), DEL, and the whole of C1.
 *
 * `no-control-regex` exists to catch a control character that ended up in a
 * pattern by accident. This one is the subject: a rule whose whole job is to
 * find control characters cannot be written without naming them.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const MARKUP = /[<>]/;

/**
 * A string as it is allowed to be stored, or the reason it is not.
 *
 * Anything that is not a string is an absent field and comes back as the empty
 * string: whether empty is acceptable is the caller's rule, not this one's,
 * because "a message is required" and "a phone number is optional" are facts
 * about the form, not about the characters.
 */
export function sanitiseInbound(
  input: unknown,
  rule: InboundRule
): InboundOutcome {
  if (typeof input !== 'string') return { ok: true, value: '' };

  // First, before anything measures or normalises: a NUL is not a character
  // this product stores, and `String.prototype.normalize` would happily carry
  // it through to the insert that fails.
  if (input.includes('\u0000')) return { ok: false, reason: 'null_byte' };

  let value = input.normalize('NFC');
  // \r\n and a lone \r both become \n before the control sweep, so a message
  // pasted from Windows keeps its paragraphs instead of losing them.
  value = value.replace(/\r\n?/g, '\n');
  value = value.replace(CONTROL, '');
  value = value.replace(INVISIBLE, '');
  if (!rule.multiline) value = value.replace(/[\n\t]+/g, ' ');
  value = value.trim();

  if (rule.markup === 'reject' && MARKUP.test(value)) {
    return { ok: false, reason: 'markup' };
  }

  if (value.length > rule.limit) {
    if (rule.onOverflow === 'truncate') {
      return { ok: true, value: value.slice(0, rule.limit).trim() };
    }
    return { ok: false, reason: 'too_long' };
  }

  return { ok: true, value };
}

/**
 * The same rule for a caller that cannot refuse the request.
 *
 * The Cal.com webhook is one: the delivery is signed, so it genuinely is
 * Cal.com, and refusing the booking because an attendee typed an angle bracket
 * into their name would lose the client a meeting over a cosmetic problem. So
 * a field that fails the rule becomes null — the booking is stored, the
 * dashboard says "No name given", and nothing hostile is written.
 */
export function sanitiseInboundOrNull(
  input: unknown,
  rule: InboundRule
): string | null {
  const outcome = sanitiseInbound(input, rule);
  if (!outcome.ok) return null;
  return outcome.value || null;
}
