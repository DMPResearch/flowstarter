/**
 * The two emails a visitor gets when the intake routes them to custom work.
 *
 * They are the first thing anybody has ever sent this person, and they carry
 * an awkward message: the thing they asked for is not the thing this site
 * builds by itself. So the copy does the one thing that makes that land well,
 * which is to say it plainly and immediately, name who does do it, and give
 * them the next step in the same breath. No apology, no "unfortunately", and
 * no pretending a discovery call is a prize.
 *
 * Two templates rather than one with a branch: whether there is a calendar to
 * book is a fact about our configuration, not about them, and an email that
 * says "book a time" with no link is worse than one that says "Darius will
 * write to you". The caller picks by whether `discoveryCallBookingUrl` returned
 * a URL.
 */
import { renderEmail, type RenderedEmail } from './base';
import { verbatimEvidence } from '@/lib/flowstarter/scope-classifier';

/** The studio that contracts the custom work. Named, not implied. */
const STUDIO = 'DMPResearch';

/**
 * The lane this lead lands in, printed in the operator email's letterhead.
 *
 * The same words the board uses, so the email and the board agree, and the
 * same words the "what happens next" sentence below already says out loud.
 */
const OPERATOR_QUEUE = 'Custom work';

function greeting(name?: string | null) {
  const trimmed = (name ?? '').trim();
  return {
    kind: 'greeting' as const,
    text: trimmed ? `Hi ${trimmed},` : 'Hi,',
  };
}

/**
 * What we understood, quoted back.
 *
 * The visitor's own sentence, not a summary of it. Somebody being told their
 * project needs a different process wants to see that the thing was read, and
 * a paraphrase invites an argument about the paraphrase.
 */
function whatTheyAsked(description: string) {
  const trimmed = description.trim();
  return trimmed ? [{ kind: 'quote' as const, text: trimmed }] : [];
}

export function discoveryCallBookedOfferEmail(input: {
  /** Already prefilled with their name and address. */
  bookingUrl: string;
  visitorName?: string | null;
  description: string;
}): RenderedEmail {
  return renderEmail({
    subject: `Your project needs a call with ${STUDIO}`,
    preheader: 'Pick a time and we will scope it properly.',
    blocks: [
      { kind: 'heading', text: 'This one is custom work' },
      greeting(input.visitorName),
      {
        kind: 'paragraph',
        content:
          'Thank you for telling us about your project. Reading it back, what ' +
          'you need is not a site that presents your business, it is software ' +
          `built for it. That is real work and we do not start it from a form.`,
      },
      ...whatTheyAsked(input.description),
      {
        kind: 'paragraph',
        content:
          `Work like this is handled by ${STUDIO}, Darius's studio, and it is ` +
          'contracted after a call rather than bought off a page. The call is ' +
          'thirty minutes, there is nothing to prepare, and you leave it ' +
          'knowing what the work involves and what it costs, whether or not ' +
          'you go ahead with us.',
      },
      { kind: 'button', label: 'Pick a time', href: input.bookingUrl },
      {
        kind: 'note',
        content:
          'Your name and address are already filled in on that page. If none ' +
          'of the times suit you, reply to this email and we will find one.',
      },
    ],
  });
}

export function customWorkEnquiryEmail(input: {
  visitorName?: string | null;
  description: string;
}): RenderedEmail {
  return renderEmail({
    subject: `Your project is with ${STUDIO}`,
    preheader: 'We have it, and Darius will write to you.',
    blocks: [
      { kind: 'heading', text: 'This one is custom work' },
      greeting(input.visitorName),
      {
        kind: 'paragraph',
        content:
          'Thank you for telling us about your project. Reading it back, what ' +
          'you need is not a site that presents your business, it is software ' +
          'built for it. That is real work and we do not start it from a form.',
      },
      ...whatTheyAsked(input.description),
      {
        kind: 'paragraph',
        content:
          `Work like this is handled by ${STUDIO}, Darius's studio. We have ` +
          'your enquiry and Darius will write to you himself to arrange a ' +
          'call. There is nothing for you to do in the meantime.',
      },
      {
        kind: 'note',
        content:
          'If anything has changed, or you want to add something you left ' +
          'out, just reply to this email.',
      },
    ],
  });
}

/**
 * What Darius reads.
 *
 * Separate from the two above because an operator's email is facts and a
 * client's email is a sentence. Except it used to be a dump of the routing
 * machinery instead of facts: a raw cosine margin printed as "Confidence:
 * 0.13" (meaningless outside the classifier that produced it, and not even on
 * a 0-to-1-means-sure scale — see `decided` in `../flowstarter/scope-route`),
 * "Scope: standard" sitting next to "Route: discovery-call" as if they agreed,
 * and a bullet of the classifier's raw evidence fragments underneath the
 * quoted brief as though it were a second thing to read. None of that is a
 * reason to a person; it is the reason encoded for a rule. This function
 * decodes it once, here, into the one plain sentence `REASON_COPY` below
 * carries for each `route_rule`, so an operator learns why the lead landed
 * without opening the board, and only opens it because they chose to, not
 * because the email left it to them to reverse-engineer.
 *
 * `routeRule` selects the sentence; `evidence` supplies the visitor's own
 * words to quote inside it, when the rule has any. Nothing here ever prints a
 * rule id, a tier name or a number — see the tests, which assert exactly that.
 *
 * The primary link is the lead's own place on the pipeline board
 * (`leadUrl`, built by the caller from `publicAppOrigin()`), never the
 * visitor's own site or social profile: an operator reading this email wants
 * the board, and a lead who happens to run an Instagram account is not the
 * navigation this email is for. Their link, when they gave one, is a fact
 * alongside their name and address, labelled for what it is.
 */

/**
 * The plain reason a lead is on the board, and the short phrase for the
 * subject line, keyed by `route_rule` — the one thing `decideRoute` in
 * `../flowstarter/scope-route` already computed deterministically, so this is
 * a lookup, not a second decision.
 *
 * Only the four rules that can actually produce a `discovery-call` route are
 * listed: `visitorSaysSoftware`, `customAboveThreshold` and `clarifiedCustom`
 * from `decideRoute`, and `contactForm` from the discovery-call page's own
 * form. Anything else falls through to `FALLBACK_REASON`, which stays true
 * without naming whatever rule produced it.
 */
interface OperatorReason {
  /** A few words for the subject line. Never a full sentence. */
  subjectSummary: string;
  /**
   * The one sentence the email's body opens with. `brief` is the visitor's
   * own description, passed through so `quotedEvidence` can check a fragment
   * against it before this sentence quotes it -- see that function.
   */
  sentence: (evidence: readonly string[], brief: string) => string;
}

/**
 * How much of one evidence fragment this template will quote.
 *
 * A named constant rather than a literal at the call site, so the bound is
 * one number to change and one thing the tests can pin. Long enough for a
 * short clause ("customers log into their loyalty account"), short enough
 * that a classifier fragment that ran on is not mistaken for a proper quote.
 */
const MAX_QUOTED_EVIDENCE_CHARS = 60;

/**
 * One evidence fragment, trimmed to whole words within
 * `MAX_QUOTED_EVIDENCE_CHARS`. Null when there is nothing usable: the
 * fragment was empty, or even its first word alone would not fit -- a
 * fragment this template cannot shorten honestly is one it does not quote,
 * rather than one it cuts off mid-word.
 */
function wholeWordFragment(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length <= MAX_QUOTED_EVIDENCE_CHARS) return trimmed;
  let out = '';
  for (const word of trimmed.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > MAX_QUOTED_EVIDENCE_CHARS) break;
    out = next;
  }
  return out || null;
}

/**
 * Up to two of the visitor's own fragments, quoted and joined for a sentence.
 * Null when the classifier gave none, none of them are actually in `brief`,
 * or none of them survived `wholeWordFragment`, so the caller falls back to a
 * sentence that asserts nothing it cannot show.
 *
 * The verbatim check against `brief` is the defensive half of the fix for
 * #191: `fix at the source` (see `classify-scope-sigma.ts`) means a correctly
 * behaving classifier never hands this function anything but the visitor's
 * own words, but this function does not trust that. A fragment is quoted only
 * if it occurs, case-insensitively and after whitespace is folded, as a
 * substring of the brief actually sent -- `occursVerbatim` in
 * `@/lib/flowstarter/scope-classifier`. Anything else, a reason code, a prompt
 * version, a paraphrase, is dropped rather than printed as though the visitor
 * wrote it.
 */
function quotedEvidence(
  evidence: readonly string[],
  brief: string
): string | null {
  const fragments = verbatimEvidence(evidence, brief)
    .map((fragment) => wholeWordFragment(fragment))
    .filter((fragment): fragment is string => fragment !== null)
    .slice(0, 2);
  if (fragments.length === 0) return null;
  return fragments.map((fragment) => `"${fragment}"`).join(' and ');
}

const REASON_COPY: Record<string, OperatorReason> = {
  visitorSaysSoftware: {
    subjectSummary: 'needs software built for the business',
    sentence: () =>
      'The visitor told us they need software built for the business, not a site that presents it.',
  },
  customAboveThreshold: {
    subjectSummary: 'reads like software to build, not a site',
    sentence: (evidence, brief) => {
      const quoted = quotedEvidence(evidence, brief);
      return quoted
        ? `The brief mentions ${quoted}, which points to software we do not build self-serve.`
        : 'The brief reads like software to build rather than a site that presents the business, which is not something we build self-serve.';
    },
  },
  clarifiedCustom: {
    subjectSummary: 'still reads as software after the question',
    sentence: (evidence, brief) => {
      const quoted = quotedEvidence(evidence, brief);
      return quoted
        ? `We asked what they needed, and the brief still mentions ${quoted}, which points to software we do not build self-serve.`
        : 'We asked what they needed, and the brief still reads as software to build rather than a site that presents the business.';
    },
  },
  contactForm: {
    subjectSummary: 'asked for a call through the contact form',
    sentence: () =>
      'The visitor asked directly for a call about custom work, through the contact form.',
  },
};

const FALLBACK_REASON: OperatorReason = {
  subjectSummary: 'was routed to a discovery call',
  sentence: () =>
    'The visitor was routed to a discovery call with DMPResearch.',
};

function operatorReasonFor(routeRule: string): OperatorReason {
  return REASON_COPY[routeRule] ?? FALLBACK_REASON;
}

export function customWorkOperatorEmail(input: {
  visitorName: string;
  visitorEmail: string;
  description: string;
  /** The visitor's own site or social link, when they gave one. Never the primary link. */
  linkUrl?: string | null;
  /** What `linkUrl` is, so the fact row reads right. Defaults to a neutral label. */
  linkLabel?: string;
  /** Which rule in `decideRoute` produced the route. Selects the reason sentence. */
  routeRule: string;
  /** The classifier's own quoted fragments, when it has any. */
  evidence: readonly string[];
  /** The brief's language. A Romanian brief gets a one-line note, nothing else changes. */
  locale?: 'en' | 'ro';
  /** Null when this environment has no calendar configured; changes the next-step line. */
  bookingUrl?: string | null;
  /** The lead's own place on the pipeline board. The primary link and the button's target. */
  leadUrl: string;
}): RenderedEmail {
  const reason = operatorReasonFor(input.routeRule);
  const sentence = reason.sentence(input.evidence, input.description);
  const briefNote =
    input.locale === 'ro'
      ? ' The brief is written in Romanian, quoted below exactly as they sent it.'
      : '';
  const nextStep = input.bookingUrl
    ? 'They can book the call themselves at the link we sent them. Until then, or until you reach out, this sits in the Custom work lane.'
    : 'There is no calendar for them to book, so this sits in the Custom work lane until you write to them.';

  return renderEmail({
    subject: `Custom work lead: ${input.visitorName}, ${reason.subjectSummary}`,
    preheader: `${input.visitorEmail} was routed to a discovery call.`,
    // Two operator queues reach the same inbox from the same address. The
    // letterhead says which one this is before the eye reaches the heading.
    masthead: OPERATOR_QUEUE,
    blocks: [
      { kind: 'heading', text: 'A custom work lead' },
      // The reason is the standfirst, not a first paragraph: it is the one
      // sentence that decides whether this gets opened now or after lunch,
      // and setting it at the same rank as "this sits in the Custom work
      // lane" was the whole reason the email read as a wall.
      { kind: 'lede', content: `${sentence}${briefNote}` },
      { kind: 'paragraph', content: nextStep },
      { kind: 'quote', text: input.description },
      {
        kind: 'facts',
        rows: [
          { label: 'Name', value: input.visitorName },
          { label: 'Email', value: input.visitorEmail },
          ...(input.linkUrl
            ? [{ label: input.linkLabel ?? 'Their link', value: input.linkUrl }]
            : []),
        ],
      },
      { kind: 'button', label: 'Open this lead', href: input.leadUrl },
    ],
  });
}
