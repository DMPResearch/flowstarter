import 'server-only';

/**
 * The gate between the last quick question and the first token of generation.
 *
 * This is the impure half of the feature: it reads the page behind the
 * visitor's link, asks `classifyScope` what the brief is, asks `decideRoute`
 * where that means the visitor goes, and -- only when the answer is the
 * discovery call -- files a `custom_work_leads` row and sends the two emails.
 *
 * It decides nothing itself. Every judgement in here is a call into
 * `./scope-route`, which is pure and has the thresholds. The reason for the
 * split is the reason for the whole feature: the expensive thing downstream is
 * a generation run, and "when do we spend one" must be a rule somebody can read
 * in one file, not a condition spread across a route handler.
 *
 * The one property worth stating out loud, because it is what the tests assert:
 * nothing in this module starts a generation, and the funnel does not call the
 * live preview route until this has answered `self-serve`.
 */
import { publicAppOrigin } from '@flowstarter/platform-config';
import { resolveOperatorNotifyEmail, sendEmail } from '@/lib/email';
import { screenAcceptableUse } from '@/lib/policy/gate';
import type { PolicyLocale, PolicyNotice } from '@/lib/policy/copy';
import { intakeSubject } from '@/lib/policy/subject';
import {
  customWorkEnquiryEmail,
  customWorkOperatorEmail,
  discoveryCallBookedOfferEmail,
} from '@/lib/email-templates';
import { discoveryCallBookingUrl } from './discovery-call';
import {
  markConfirmationSent,
  recordCustomWorkLead,
  type CustomWorkLeadSource,
} from './custom-work-leads';
import { fetchProfileReading } from './profile-fetch';
import { parseProfileLinks } from './profile-signals';
import {
  classifyScope,
  scopeClassifierText,
  type ScopeClassification,
} from './scope-classifier';
import {
  decideRoute,
  scopeOfferCopy,
  HOLD_COPY,
  type AcceptableUse,
  type Scope,
  type ScopeAnswer,
  type ScopeOfferCopy,
  type ScopeRoute,
} from './scope-route';
import {
  CLEAN_CATEGORY,
  classifierUnavailable,
  reviewNamesCategory,
  type PolicyRule,
  type PolicyVerdict,
} from '@/lib/policy/acceptable-use';
import { recordPolicyOutcome } from '@/lib/policy/review';
import { createHash } from 'node:crypto';

/**
 * The clarifying question, as a locale key.
 *
 * The question itself lives in `src/locales/en.ts` like every other visible
 * string. This module names the key because it is the module that decides the
 * question gets asked, and a route handler that returned English would be the
 * copy living in two places.
 */
export const SCOPE_QUESTION_KEY = 'landing.discovery.scope.question';

export interface ScopeGateInput {
  fullName: string;
  email: string;
  description: string;
  instagramUrl?: string;
  linkedinUrl?: string;
  websiteUrl?: string;
  /** Present on the second pass only. Its presence is what "clarified" means. */
  clarification?: string;
  /**
   * Which answer the visitor chose, when they chose one of the two offered.
   *
   * The key, not the sentence: the browser sends `site` or `software`, so the
   * routing rule reads a decided value instead of matching the English label
   * back out of the clarification text. A visitor who typed their own answer
   * sends `other` (or nothing), and that text reaches the classifier as
   * evidence rather than this rule as an answer.
   */
  answerKey?: ScopeAnswer;
  /**
   * Overrides the acceptable-use screen this module would run itself. Only
   * tests pass it; the funnel lets `runScopeGate` do the screening so there is
   * one call and one cached verdict per brief.
   */
  acceptableUse?: AcceptableUse;
  /**
   * The visitor's language, for the acceptable-use screen's notice only --
   * `decideRoute` and the route table stay locale-blind on purpose. Defaults
   * to `'en'` inside `screenAcceptableUse` when this is left unset.
   */
  locale?: PolicyLocale;
}

export interface ScopeGateResult {
  route: ScopeRoute;
  /**
   * The scope as the routing rule settled it, not as the classifier reported
   * it. The visitor's own answer settles it; a classifier that could not
   * answer does not override one.
   */
  scope: Scope;
  /** What the classifier said on its own, kept for the operator's card. */
  classifiedScope: Scope;
  confidence: number;
  evidence: string[];
  /** Which rule in `decideRoute` produced the route. */
  rule: string;
  /** True when an acceptable-use review row was opened for an operator. */
  operatorReview: boolean;
  /** The locale key of the clarifying question, on `ask-one-more-question`. */
  questionKey?: string;
  /**
   * Which copy the discovery-call screen may show, chosen by the rule from the
   * settled scope. Only present on `discovery-call`.
   */
  offerCopy?: ScopeOfferCopy;
  /**
   * Where the visitor books, prefilled. Null on `discovery-call` means this
   * environment has no Cal.com configured and the page will show the contact
   * form instead. Absent on the other two routes.
   */
  bookingUrl?: string | null;
  /** The filed lead, when one was filed. */
  leadId?: string | null;
  /**
   * The policy notice, on `refused` and `hold` only.
   *
   * Carried so the funnel can say the true sentence at the point it stops,
   * rather than routing the visitor onward to a step that would screen again
   * to rediscover it. `@/lib/policy/copy` still writes every word of it.
   */
  notice?: PolicyNotice | null;
}

/**
 * The title of the page behind the visitor's link.
 *
 * Best effort and bounded, with the website preferred over the social profiles:
 * a business's own `<title>` is the single most informative short string about
 * what it is ("Acme -- Client Portal Login" settles a brief on its own), while
 * Instagram's is usually the handle again. Any failure is silent and yields no
 * title, because a link that will not load is not a reason to stop somebody
 * reaching a preview.
 *
 * Injectable so no unit test in this tree makes a network request.
 */
export async function readLinkTitle(
  input: {
    instagramUrl?: string;
    linkedinUrl?: string;
    websiteUrl?: string;
  },
  deps: { read?: typeof fetchProfileReading } = {}
): Promise<string> {
  const read = deps.read ?? fetchProfileReading;
  const links = parseProfileLinks(input);
  const preferred =
    links.find((link) => link.network === 'website') ?? links[0] ?? null;
  if (!preferred) return '';
  try {
    const reading = await read(preferred);
    return reading.status === 'exposed' ? reading.title ?? '' : '';
  } catch {
    return '';
  }
}

/**
 * Where the operator's email points. Through `publicAppOrigin` and not through
 * the site-url environment variable directly: PR #168 made that helper the
 * app's one rule for its own origin, and
 * `__tests__/single-public-origin-rule.test.ts` enforces it by grepping for the
 * variable's name, comments included -- which is why this one spells it out.
 */
/**
 * The acceptable-use verdict for this brief, as the routing rule reads it.
 *
 * `screenAcceptableUse` owns the classification, the thresholds, the audit row
 * and the refusal copy; all this does is compose the subject the same way the
 * preview route does (through `intakeSubject`, never by hand) and narrow the
 * three-valued answer onto `./scope-route`'s own three values.
 *
 * `skipRecord` is NOT set: a refusal here is the first time the product sees
 * this business, and the operator's review queue should have the row whether
 * or not the visitor ever reaches the preview route that would file it too.
 * The partial unique index in `policy_reviews` makes the second write a no-op.
 */
async function screenedVerdict(
  input: ScopeGateInput,
  linkTitle: string
): Promise<{ acceptableUse: AcceptableUse; notice: PolicyNotice | null }> {
  const screening = await screenAcceptableUse({
    surface: 'preview',
    text: intakeSubject({
      description: input.description,
      websiteUrl: input.websiteUrl,
      instagramUrl: input.instagramUrl,
      linkedinUrl: input.linkedinUrl,
      linkTitle,
    }),
    locale: input.locale,
  });
  // The notice travels with the verdict so a `refused` or `hold` route can
  // show the visitor the real sentence here, instead of routing them to the
  // preview step and having it screen again to rediscover the same answer.
  // `@/lib/policy/copy` is still the only place that WRITES it.
  return {
    acceptableUse: acceptableUseFrom(screening.verdict),
    notice: screening.notice ?? null,
  };
}

/**
 * One `PolicyVerdict`, narrowed onto the four things the routing table needs.
 *
 * The one place the policy's vocabulary and the funnel's meet, exported so
 * the table-driven test can replay a verdict through both halves without a
 * classifier. The narrowing is where the 2026-09-15 defect lived: `review`
 * collapsed three unrelated facts into one value, and the route table could
 * only act on the word.
 */
export function acceptableUseFrom(verdict: PolicyVerdict): AcceptableUse {
  if (verdict.decision === 'refuse') return 'blocked';
  if (verdict.decision !== 'review') return 'allowed';
  // Order matters: a classifier that never answered has no category either,
  // so the unavailable check has to come first or every hold would be read as
  // a merely-unsure review and fall through to the scope rules.
  if (classifierUnavailable(verdict)) return 'hold';
  return reviewNamesCategory(verdict) ? 'review' : 'unsettled';
}

function boardUrl(): string {
  return `${publicAppOrigin()}/admin/dashboard/pipeline`;
}

/**
 * The lead's own place on the pipeline board -- the operator email's primary
 * link, and the only thing its button points to.
 *
 * `#custom-work-lead-<id>` matches the `id` `CustomWorkLeadCard` renders in
 * `admin/dashboard/pipeline/CustomWorkLane.tsx`, so the link actually lands on
 * the card rather than just the page. Falls back to the bare board when there
 * is no id to anchor to -- `recordCustomWorkLead` failing is logged and does
 * not stop the operator email from going, and a link to the board beats no
 * link at all.
 */
function leadBoardUrl(leadId: string | null): string {
  const base = boardUrl();
  return leadId ? `${base}#custom-work-lead-${leadId}` : base;
}

/**
 * File the lead and tell both sides about it.
 *
 * The visitor's email and the operator's are sent independently: Darius must
 * hear about a lead even if the visitor's address bounced, and the visitor must
 * get their confirmation even if `OPERATOR_ALERT_EMAIL` is unset on this
 * deployment. Neither send can fail the caller -- `sendEmail` never throws and
 * a false result is logged, not raised.
 */
async function fileCustomWorkLead(input: {
  gate: ScopeGateInput;
  classification: ScopeClassification;
  route: ScopeRoute;
  rule: string;
  linkTitle: string;
  bookingUrl: string | null;
  source: CustomWorkLeadSource;
  /** The verdict the gate actually screened, not the caller's guess at one. */
  acceptableUse: AcceptableUse | null;
}): Promise<string | null> {
  const { gate, classification } = input;
  const linkUrl =
    gate.websiteUrl?.trim() ||
    gate.instagramUrl?.trim() ||
    gate.linkedinUrl?.trim() ||
    null;
  // What the link above actually is, so the operator email's fact row reads
  // right instead of a bare, unlabelled URL. A website is "their site"; a
  // social profile is "their profile" -- neither is ever the email's primary
  // link (see `leadBoardUrl`), just a fact next to their name and address.
  const linkLabel = gate.websiteUrl?.trim()
    ? 'Their site'
    : gate.instagramUrl?.trim() || gate.linkedinUrl?.trim()
    ? 'Their profile'
    : undefined;

  const leadId = await recordCustomWorkLead({
    name: gate.fullName,
    email: gate.email,
    description: gate.description,
    linkUrl,
    linkTitle: input.linkTitle,
    clarification: gate.clarification ?? null,
    scope: classification.scope,
    confidence: classification.confidence,
    evidence: classification.evidence,
    classifier: classification.classifier,
    route: input.route,
    routeRule: input.rule,
    acceptableUse: input.acceptableUse,
    source: input.source,
    // A visitor with a calendar in front of them has been offered something; a
    // visitor without one has filed an enquiry. The board reads the difference.
    bookingStatus: input.bookingUrl ? 'offered' : 'enquiry',
  });

  const visitorEmail = gate.email.trim();
  if (visitorEmail) {
    const rendered = input.bookingUrl
      ? discoveryCallBookedOfferEmail({
          bookingUrl: input.bookingUrl,
          visitorName: gate.fullName,
          description: gate.description,
        })
      : customWorkEnquiryEmail({
          visitorName: gate.fullName,
          description: gate.description,
        });
    const sent = await sendEmail({
      to: visitorEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (sent.success && leadId) {
      await markConfirmationSent(leadId);
    } else if (!sent.success) {
      console.warn(
        `[custom-work] the visitor confirmation did not send: ${
          sent.error ?? 'unknown error'
        }`
      );
    }
  }

  const operator = resolveOperatorNotifyEmail();
  if (operator) {
    const rendered = customWorkOperatorEmail({
      visitorName: gate.fullName.trim() || 'Not given',
      visitorEmail: visitorEmail || 'Not given',
      description: gate.description,
      linkUrl,
      linkLabel,
      routeRule: input.rule,
      evidence: classification.evidence,
      locale: gate.locale,
      bookingUrl: input.bookingUrl,
      leadUrl: leadBoardUrl(leadId),
    });
    const sent = await sendEmail({
      to: operator,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: visitorEmail || undefined,
    });
    if (!sent.success) {
      console.warn(
        `[custom-work] the operator notification did not send: ${
          sent.error ?? 'unknown error'
        }`
      );
    }
  }

  return leadId;
}

/**
 * Run the gate once.
 *
 * Called twice at most per visitor: once when the quick questions run out, and
 * once more with `clarification` set if the first pass could not tell. The
 * second pass is what `alreadyClarified` means to `decideRoute`, and it is why
 * a visitor is never asked the same question twice.
 */
export async function runScopeGate(
  input: ScopeGateInput,
  deps: { read?: typeof fetchProfileReading } = {}
): Promise<ScopeGateResult> {
  const linkTitle = await readLinkTitle(input, deps);

  /**
   * Acceptable use first, scope second.
   *
   * Order matters and it is not about cost. A brief the policy gate refuses
   * must never reach the custom-work branch, because that branch files a lead
   * row, emails Darius and offers a calendar invitation -- an invitation to
   * sell to a business we have already decided we will not build for. The
   * generation path has been screened since PR #158; this path is newer than
   * that PR and had to screen for itself.
   *
   * `screenAcceptableUse` never throws and its classifier is cached by content
   * hash, so the second screen the preview route runs is free.
   */
  const screened = input.acceptableUse
    ? { acceptableUse: input.acceptableUse, notice: null }
    : await screenedVerdict(input, linkTitle);
  const acceptableUse = screened.acceptableUse;

  const classifierText = scopeClassifierText({
    fullName: input.fullName,
    email: input.email,
    description: input.description,
    instagramUrl: input.instagramUrl,
    linkedinUrl: input.linkedinUrl,
    websiteUrl: input.websiteUrl,
    linkTitle,
    clarification: input.clarification,
  });
  const classification = await classifyScope(classifierText);

  const decision = decideRoute({
    scope: classification.scope,
    confidence: classification.confidence,
    decided: classification.decided,
    acceptableUse,
    visitorAnswer: input.answerKey,
    alreadyClarified:
      Boolean(input.clarification?.trim()) || Boolean(input.answerKey),
  });

  if (decision.operatorReview) {
    await openScopeReview({
      rule:
        decision.rule === 'visitorSaysSiteClassifierSaysCustom'
          ? 'scope_visitor_disagrees_with_classifier'
          : 'scope_unresolved_after_question',
      classification,
      subject: classifierText,
      // The gate's own fields, not the classifier text: the operator email
      // quotes the brief the visitor actually typed, and `scopeClassifierText`
      // is a longer prompt built for a model, link title and all.
      briefText: input.description,
      contactName: input.fullName,
      contactEmail: input.email,
    });
  }

  const base: ScopeGateResult = {
    route: decision.route,
    scope: decision.scope,
    classifiedScope: classification.scope,
    confidence: classification.confidence,
    evidence: classification.evidence,
    rule: decision.rule,
    operatorReview: decision.operatorReview,
  };

  if (decision.route === 'ask-one-more-question') {
    return { ...base, questionKey: SCOPE_QUESTION_KEY };
  }
  if (decision.route === 'self-serve') {
    return base;
  }
  if (decision.route === 'hold') {
    // Deliberately before the booking branch below, and returning with no
    // `bookingUrl` and no `leadId`. A held brief has been read by nobody, so
    // there is nothing to sell against and nobody to email: `fileCustomWorkLead`
    // would put a stranger's name and address in a lead row and a prefilled
    // calendar link in their inbox on the strength of a classifier timeout.
    //
    // No `policy_reviews` row is written here either, because one already
    // exists: `screenAcceptableUse` above writes it for every blocking
    // verdict, and `classifier_unavailable` is one.
    return { ...base, offerCopy: HOLD_COPY, notice: screened.notice };
  }
  if (decision.route === 'refused') {
    // Same shape, different sentence, and the same two absences that matter:
    // no `bookingUrl` and no lead row. The notice is the one `@/lib/policy`
    // already wrote for this verdict, in the visitor's own language.
    return { ...base, notice: screened.notice };
  }

  const bookingUrl = discoveryCallBookingUrl({
    name: input.fullName,
    email: input.email,
  });
  const leadId = await fileCustomWorkLead({
    gate: input,
    classification,
    route: decision.route,
    rule: decision.rule,
    linkTitle,
    bookingUrl,
    source: 'funnel',
    acceptableUse,
  });

  return {
    ...base,
    bookingUrl,
    leadId,
    offerCopy: scopeOfferCopy(decision.scope),
  };
}

/**
 * Open an acceptable-use review row for a brief nobody could settle.
 *
 * The queue is the acceptable-use one on purpose. "Somebody should read this
 * before we build it" is one question with one answer surface, and a second
 * table for the scope version of it would be a second queue for an operator to
 * remember to check. What is in question here is not whether we may build --
 * the acceptable-use verdict on these rows allows -- it is what we are being
 * asked to build.
 *
 * Never fails the caller. `recordPolicyOutcome` already swallows its own
 * errors, and a visitor whose review row could not be written must still
 * reach their preview: this exists so an operator sees the disagreement, not
 * so the funnel can stop on it.
 */
async function openScopeReview(input: {
  rule: PolicyRule;
  classification: ScopeClassification;
  subject: string;
  briefText: string;
  contactName: string;
  contactEmail: string;
}): Promise<void> {
  const tier = input.classification.classifier.startsWith('sigma')
    ? ('embedding' as const)
    : input.classification.classifier.startsWith('llm')
    ? ('llm' as const)
    : ('unavailable' as const);
  await recordPolicyOutcome({
    surface: 'preview',
    verdict: {
      decision: 'review',
      // No policy category applies: the brief is unobjectionable, it is the
      // scope of the work that nobody could settle.
      category: CLEAN_CATEGORY,
      confidence: input.classification.confidence,
      rule: input.rule,
      tier,
      needsHuman: true,
    },
    classification: {
      // The visitor's own words, capped by `scopeClassifierText`, are what an
      // operator needs to read to settle this by hand.
      evidence: input.classification.evidence.join(' | '),
      // The hash identifies the brief without storing it twice, and it is
      // what the partial unique index dedupes a reloading visitor on.
      evidenceHash: createHash('sha256').update(input.subject).digest('hex'),
      promptVersion: input.classification.classifier,
    },
    briefText: input.briefText,
    contactName: input.contactName,
    contactEmail: input.contactEmail,
    actor: 'scope-gate',
  });
}

/**
 * The contact form on `/discovery-call`, when there is no calendar to show.
 *
 * It files the same row as the funnel does, with `source: 'contact_form'`, so
 * the operator's lane is one list rather than two. Nothing is classified here:
 * somebody who reached this page and typed out their project has already told
 * us what it is, and running a model over it to reach the conclusion we have
 * already reached would be spending money to agree with the visitor.
 */
export async function fileCustomWorkEnquiry(input: {
  name: string;
  email: string;
  description: string;
  linkUrl?: string | null;
}): Promise<string | null> {
  return fileCustomWorkLead({
    gate: {
      fullName: input.name,
      email: input.email,
      description: input.description,
      websiteUrl: input.linkUrl ?? undefined,
    },
    classification: {
      scope: 'custom',
      confidence: 1,
      evidence: [],
      classifier: 'visitor',
    },
    route: 'discovery-call',
    rule: 'contactForm',
    linkTitle: '',
    bookingUrl: null,
    source: 'contact_form',
    // Nothing screened this: it is a form somebody filled in on a page that
    // only exists because no calendar is configured, and it reaches a person
    // rather than a generator. Null is the honest value, and it is a different
    // fact from `allowed`.
    acceptableUse: null,
  });
}
