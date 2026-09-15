/**
 * The operator's "A custom work lead" email.
 *
 * PR #162 shipped it as a dump of the routing machinery: a raw cosine margin
 * printed as "Confidence: 0.13" (meaningless outside the classifier that
 * produced it, and not even on a 0-to-1-means-sure scale once #183 replaced it
 * with `decided`), "Scope: standard" sitting next to "Route: discovery-call"
 * as if the two agreed (they did, under the pre-#180 rule; #180 and #185
 * fixed the routing itself), and a bullet of the classifier's raw evidence
 * fragments under the quoted brief. Darius read it and could not tell why the
 * lead was on his board without opening it.
 *
 * What is asserted here: every `route_rule` that can actually reach this
 * template renders one plain sentence and nothing that looks like a rule id,
 * a tier name or a raw number; the primary link and the button both point at
 * the lead's own place on the board, never at the visitor's own site or
 * profile; and the Romanian note appears only when the brief is Romanian.
 */
import { describe, expect, it } from 'vitest';
import { customWorkOperatorEmail } from '../custom-work';

/** Anything that reads as a decimal, the shape a raw confidence took. */
const DECIMAL_NUMBER = /\d+\.\d+/;

/** The columns this template used to print by name. Must never appear again. */
const RAW_FIELD_LABELS = /\bConfidence\b|\bScope\b|\bRoute\b/;

const LEAD_URL =
  'https://flowstarter.net/admin/dashboard/pipeline#custom-work-lead-lead-1';
const THEIR_SITE = 'https://acme.example.com';

const BASE = {
  visitorName: 'Sarah Smith',
  visitorEmail: 'sarah@example.com',
  description: 'A portal my customers log into to track their orders',
  linkUrl: THEIR_SITE,
  linkLabel: 'Their site',
  bookingUrl: 'https://cal.flowstarter.dev/darius/discovery-call?name=Sarah',
  leadUrl: LEAD_URL,
} as const;

describe('customWorkOperatorEmail, one sentence per route_rule', () => {
  it.each([
    {
      routeRule: 'visitorSaysSoftware',
      evidence: [],
      sentence:
        'The visitor told us they need software built for the business, not a site that presents it.',
    },
    {
      routeRule: 'customAboveThreshold',
      evidence: ['customers log into'],
      sentence:
        'The brief mentions "customers log into", which points to software we do not build self-serve.',
    },
    {
      routeRule: 'clarifiedCustom',
      // Must actually occur in `BASE.description` -- see the verbatim check
      // in `quotedEvidence`.
      evidence: ['track their orders'],
      sentence:
        'We asked what they needed, and the brief still mentions "track their orders", which points to software we do not build self-serve.',
    },
    {
      routeRule: 'contactForm',
      evidence: [],
      sentence:
        'The visitor asked directly for a call about custom work, through the contact form.',
    },
  ])(
    '$routeRule reads as one plain sentence, no code, no number',
    ({ routeRule, evidence, sentence }) => {
      const mail = customWorkOperatorEmail({ ...BASE, routeRule, evidence });

      expect(mail.text).toContain(sentence);
      // The plain-text part carries only the blocks' own content, never the
      // inline CSS the HTML part is full of (e.g. `line-height:1.6`), so it is
      // where "no raw number" is actually checkable.
      expect(mail.text).not.toMatch(DECIMAL_NUMBER);
      expect(mail.html).not.toMatch(RAW_FIELD_LABELS);
      expect(mail.text).not.toMatch(RAW_FIELD_LABELS);
      // The rule id itself is a lookup key, never copy.
      expect(mail.html).not.toContain(routeRule);
      expect(mail.text).not.toContain(routeRule);
    }
  );

  it('falls back to a true, unspecific sentence for a rule it does not recognise', () => {
    // Defensive: a rule this template has not been taught yet must still
    // render something true rather than throw or print the id raw.
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'someFutureRule',
      evidence: [],
    });
    expect(mail.text).toContain(
      'The visitor was routed to a discovery call with DMPResearch.'
    );
    expect(mail.text).not.toContain('someFutureRule');
  });

  it('quotes an evidence fragment whole, up to the length bound, never cut mid-word', () => {
    // 60 chars is the bound (`MAX_QUOTED_EVIDENCE_CHARS`). This fragment is
    // longer, so only whole words that fit are kept. The description carries
    // the fragment verbatim, or the verbatim check below would drop it before
    // the truncation logic ever ran.
    const mail = customWorkOperatorEmail({
      ...BASE,
      description:
        'A portal where customers log into their account to track orders and reschedule delivery, all self-service.',
      routeRule: 'customAboveThreshold',
      evidence: [
        'customers log into their account to track orders and reschedule delivery',
      ],
    });
    // The exact string below is the whole proof: the quoted sentence stops
    // at "and", not partway through "reschedule" -- no fragment word was cut
    // in half. (The full brief is quoted separately, verbatim, further down
    // the same email, so "reschedule" legitimately appears there; asserting
    // its absence from `mail.text` as a whole would not be testing this
    // function any more.)
    expect(mail.text).toContain(
      'The brief mentions "customers log into their account to track orders and", which points to software we do not build self-serve.'
    );
    expect(mail.text).not.toContain(
      'and reschedule", which points to software'
    );
  });

  it('falls back to the generic sentence when the fragment is empty', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'customAboveThreshold',
      evidence: ['   ', ''],
    });
    expect(mail.text).toContain(
      'The brief reads like software to build rather than a site that presents the business, which is not something we build self-serve.'
    );
    expect(mail.text).not.toContain('mentions ""');
  });

  it('falls back to the generic sentence when even one whole word is too long to quote', () => {
    // A single "word" (no spaces) longer than the bound cannot be shortened
    // to anything honest, so it is dropped rather than half-quoted. The
    // description is that same word, so the verbatim check is not what drops
    // it here -- the length bound is.
    const mail = customWorkOperatorEmail({
      ...BASE,
      description: 'a'.repeat(61),
      routeRule: 'clarifiedCustom',
      evidence: ['a'.repeat(61)],
    });
    expect(mail.text).toContain(
      'We asked what they needed, and the brief still reads as software to build rather than a site that presents the business.'
    );
  });

  it('never quotes a fragment absent from the brief, even if the classifier handed it one', () => {
    // The defensive half of the fix for #191: the source (`classify-scope-sigma.ts`)
    // no longer produces this, but this template does not trust that either.
    // A fragment that is not actually in the brief is dropped, not quoted.
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'customAboveThreshold',
      evidence: ['confident:scope:custom-work:semantic'],
    });
    expect(mail.text).not.toContain('confident:scope:custom-work:semantic');
    expect(mail.text).toContain(
      'The brief reads like software to build rather than a site that presents the business, which is not something we build self-serve.'
    );
  });

  it('exactly the reason-code string reported in #191 never reaches the rendered email', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'customAboveThreshold',
      evidence: ['confident:scope:custom-work:semantic'],
    });
    expect(mail.text).not.toContain('confident:scope:custom-work:semantic');
    expect(mail.html).not.toContain('confident:scope:custom-work:semantic');
  });
});

describe('customWorkOperatorEmail, the primary link', () => {
  it('points the button at the lead on the board, not the visitor’s own site', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'visitorSaysSoftware',
      evidence: [],
    });
    expect(mail.html).toContain(`href="${LEAD_URL}"`);
    expect(mail.text).toContain(`Open this lead: ${LEAD_URL}`);
  });

  it('keeps the visitor’s own link as a secondary fact, never the button target', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'visitorSaysSoftware',
      evidence: [],
    });
    // The site appears once, as a labelled fact, and the button never points
    // at it.
    expect(mail.text).toContain(`Their site: ${THEIR_SITE}`);
    expect(mail.html).not.toContain(`href="${THEIR_SITE}"`);
  });

  it('labels a social profile differently from a website', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'visitorSaysSoftware',
      evidence: [],
      linkUrl: 'https://instagram.com/acmestudio',
      linkLabel: 'Their profile',
    });
    expect(mail.text).toContain(
      'Their profile: https://instagram.com/acmestudio'
    );
  });
});

describe('customWorkOperatorEmail, what happens next', () => {
  it('mentions the visitor can book the call themselves when there is a calendar', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'visitorSaysSoftware',
      evidence: [],
      bookingUrl: 'https://cal.flowstarter.dev/darius/discovery-call',
    });
    expect(mail.text).toContain('They can book the call themselves');
    expect(mail.text).toContain('Custom work lane');
  });

  it('says there is no calendar when the environment has none configured', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'contactForm',
      evidence: [],
      bookingUrl: null,
    });
    expect(mail.text).toContain('There is no calendar for them to book');
    expect(mail.text).toContain('Custom work lane');
  });
});

describe('customWorkOperatorEmail, the brief quoted as it is', () => {
  it('quotes the description verbatim', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'customAboveThreshold',
      evidence: ['customers log into'],
    });
    expect(mail.text).toContain(BASE.description);
  });
});

describe('customWorkOperatorEmail, the subject line', () => {
  it('names the visitor and summarises the reason in one line', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'visitorSaysSoftware',
      evidence: [],
    });
    expect(mail.subject).toBe(
      'Custom work lead: Sarah Smith, needs software built for the business'
    );
  });
});

describe('customWorkOperatorEmail, locale', () => {
  it('renders in English with no locale note by default (snapshot)', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'customAboveThreshold',
      evidence: ['customers log into'],
    });
    expect(mail.text).not.toContain('Romanian');
    expect(mail.text).toMatchSnapshot();
  });

  it('adds a Romanian-brief note, nothing else, when the locale is ro (snapshot)', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'customAboveThreshold',
      // A Romanian fragment, not the English one BASE's description would
      // match: an evidence quote must be verbatim in the brief actually sent,
      // and an English fragment is never in a Romanian one.
      evidence: ['clientii mei se autentifica'],
      locale: 'ro',
      description: 'Un portal in care clientii mei se autentifica',
    });
    expect(mail.text).toContain(
      'The brief is written in Romanian, quoted below exactly as they sent it.'
    );
    expect(mail.text).toContain(
      'Un portal in care clientii mei se autentifica'
    );
    expect(mail.text).toMatchSnapshot();
  });
});

describe('customWorkOperatorEmail, house style', () => {
  it('has no em dash, no emoji, and no marketing tone', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'customAboveThreshold',
      evidence: ['customers log into'],
    });
    expect(mail.html).not.toMatch(/[—–]/);
    expect(mail.text).not.toMatch(/[—–]/);
    expect(mail.html).not.toMatch(/[←-⯿]|️|[\uD83C-\uD83E][\uDC00-\uDFFF]/);
  });

  it('carries the same brand header every operator email uses', () => {
    const mail = customWorkOperatorEmail({
      ...BASE,
      routeRule: 'customAboveThreshold',
      evidence: ['customers log into'],
    });
    expect(mail.html).toContain('Flowstarter');
    expect(mail.html).toContain('<!DOCTYPE html>');
  });
});
