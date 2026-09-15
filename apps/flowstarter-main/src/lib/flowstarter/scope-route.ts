/**
 * Where a visitor goes after the four quick questions: the preview, or a
 * discovery call with DMPResearch.
 *
 * Flowstarter builds one kind of thing well: a site that presents a business.
 * People also arrive asking for the other kind of thing -- a booking platform,
 * a portal their customers log into, a marketplace, an internal tool. That is
 * real work and it is work Darius's studio, DMPResearch, contracts separately
 * after a discovery call. Until this module existed the funnel could not tell
 * the two apart, so it spent a full generation run on a brief no generator
 * could satisfy and then showed the visitor a brochure site for their SaaS.
 *
 * The division of labour is the house one:
 *
 *   rules decide, models phrase.
 *
 * A model (or, later, the local sigma classifier -- see `./scope-classifier`)
 * supplies one verdict, a confidence, and whether IT has already decided --
 * `decided` below. It does not decide anything else. This module is the
 * decision: a pure function over that verdict, `decided`, the acceptable-use
 * gate's answer, and the visitor's own answer to the one clarifying question.
 * Same inputs, same route, every time, with no IO and no import of the
 * classifier.
 *
 * ── `decided`, not `confidence`, is what this module compares to anything ──
 * This was the second bug found alongside the one above. `@flowstarter/
 * sigma-flowstarter`'s embedding head reports its own calibrated margin as
 * `confidence` -- a cosine distance in its own scoring space -- and this
 * module used to compare that number straight to `SCOPE_CUSTOM_CONFIDENCE`
 * and `SCOPE_STANDARD_CONFIDENCE`, bars tuned for a language model's
 * self-reported probability. The two are not on the same scale: a confident
 * sigma verdict reports a margin around 0.07, which never clears a 0.6 or 0.7
 * bar, so every sigma-classified visitor was asked the clarifying question
 * regardless of how sure the embedding tier was. `ScopeClassification.decided`
 * (see `./scope-classifier`) is the fix: each tier reports whether IT has
 * already decided, on its own calibration, and this module honours that flag
 * instead of re-deriving one from a number it did not calibrate. The sigma
 * adapter sets it from the cascade's own guarded outcome; the LLM adapter
 * (`@/lib/ai/classify-scope`) sets it from the thresholds below, which is the
 * one place they are still compared to a `confidence` value. This mirrors
 * `decidedAction` on `PolicyClassification` in `@/lib/policy/acceptable-use`,
 * the same fix for the same defect on the acceptable-use head.
 *
 * ── The visitor's answer is a rule input, not a hint ───────────────────────
 * This used to be the bug. The clarifying question's answer was appended to
 * the classifier's text and nothing else: it changed what the model was shown
 * and never what the rule decided. So when the classifier went down -- and on
 * 2026-09-15 it went down on 100% of calls, every one of them returning
 * `unclear` -- a visitor who tapped "A site that presents my business" was
 * still carrying `scope: "unclear"`, and `unclear` plus any answer routed to
 * a sales call. Nobody could reach a preview, and the screen they got asserted
 * they had described software, which is the opposite of what they had just
 * said.
 *
 * A person answering a direct question about their own business is the best
 * evidence in this system, better than a model reading a paragraph about it.
 * So `visitorAnswer` is a first-class input below, it settles `scope`, and the
 * only thing that can override it is the classifier being confidently certain
 * of the opposite -- which is not a refusal either, it is a disagreement, and
 * a disagreement is a thing for an operator to read while the visitor carries
 * on to their preview.
 *
 * ── Who may be offered a call ──────────────────────────────────────────────
 * Only a scope decision, and only when acceptable use allows. The
 * acceptable-use gate's verdicts route nobody to a calendar: a brief it
 * refused is a business we will not build for, and a brief it held is one
 * nobody has read yet. Sending either to `discovery-call` files a lead row,
 * emails Darius and hands the visitor a prefilled booking link, which on
 * staging is exactly what happened -- a request to sell drugs and unregistered
 * firearms was offered thirty minutes with Darius, name and email already in
 * the URL.
 *
 * ── `review` was two facts wearing one word ───────────────────────────────
 * The fix above sent both of those to `self-serve`, on the reasoning that the
 * preview route screens again and owns the copy. That is true when a
 * classifier has actually spoken. It is false when none has, and the
 * difference is what let the same drugs brief through a second time on
 * 2026-09-15, this time by the front door: the LLM tier was aborted at the
 * cascade's 3 s default budget, the cascade recorded the abort nowhere, the
 * rule layer filed the fallback as `needs_human_flag` with no category, and
 * this table read an uncategorised review as "nothing to act on" and answered
 * `self-serve` -- three times, each of which is a preview being generated.
 *
 * A fail-closed rule that fails open at the route is not a fail-closed rule.
 * So the gate's answer arrives here as four values rather than three, and
 * "we could not classify this" (`hold`) is now its own destination, distinct
 * both from "a person should check this licence" (`review`) and from "the
 * classifier was merely unsure" (`unsettled`).
 *
 * ── The thresholds ────────────────────────────────────────────────────────
 * Two numbers, both overridable by ops without a deploy, and neither of them
 * written at a call site:
 *
 *   SCOPE_CUSTOM_CONFIDENCE    below this, the LLM adapter does not decide a
 *                              `custom` verdict for itself
 *   SCOPE_STANDARD_CONFIDENCE  below this, the LLM adapter does not decide a
 *                              `standard` verdict for itself
 *
 * `custom` is held to the higher bar on purpose. Wrongly routing a standard
 * site to a call costs a sale; wrongly routing custom work to the generator
 * costs a generation run and ends with the visitor being told, after fifteen
 * minutes of watching a progress bar, that we built the wrong thing. The first
 * mistake is recoverable in the call. The second is not recoverable at all.
 *
 * `scopeRouteThresholds()` stays here, exported, because ops overrides one
 * pair of env vars for the whole feature and a second copy of the fallback
 * numbers is how the two silently drift. `decideRoute` below does not call it
 * any more; only the LLM adapter does, at classification time.
 */

/** What the classifier can say about a brief. See `./scope-classifier`. */
export type Scope = 'standard' | 'custom' | 'unclear';

/**
 * What the acceptable-use gate says, narrowed to what this decision needs.
 *
 * Declared here rather than imported from `@/lib/policy` so this module stays
 * pure and importable from anywhere: the gate reaches Supabase and a
 * classifier, and a test of the routing table has no business loading either.
 * `runScopeGate` maps `PolicyDecision` onto it at the one place they meet.
 *
 * The gate owns refusal. This owns destination.
 */
export type AcceptableUse =
  /** A tier read the brief and nothing in the policy applies. */
  | 'allowed'
  /**
   * A tier read the brief and NAMED a category -- a licensed pharmacy, a
   * bookmaker, a prohibited category it was not sure enough about to refuse.
   * #180's behaviour stands: the visitor carries on to a self-serve preview
   * and an operator reads the row.
   */
  | 'review'
  /**
   * A `review` with NO category. The classifier worked; it simply was not
   * confident enough to call the brief clean (`needs_human_flag`,
   * `clean_but_abstained`). That is not a statement about the business, so it
   * must not override what the scope head decided -- "I need a website for my
   * business." still earns its one clarifying question rather than
   * disappearing into the acceptable-use branch.
   */
  | 'unsettled'
  /**
   * Nothing classified the brief at all: the tier timed out, threw, or the
   * classifier is down and we fail closed. Distinct from every value above,
   * because it is the ABSENCE of a verdict rather than one.
   */
  | 'hold'
  /** Refused. */
  | 'blocked';

/** The five places the funnel can send somebody at this point. */
export type ScopeRoute =
  | 'self-serve'
  | 'discovery-call'
  | 'ask-one-more-question'
  /**
   * Refused, and told so here rather than one screen later.
   *
   * #180 sent a refusal to `self-serve` on the reasoning that the preview
   * route screens again and owns the refusal copy, and that the second screen
   * "costs nothing, because the classifier is cached". The second half of
   * that is not true, and the first half depends on it.
   *
   * The two screens do not classify the same text. `runScopeGate` composes
   * its subject from the description, the links and the link title;
   * `/api/discovery/preview/live` composes its own from the full spec --
   * `businessName`, `industry`, `targetAudience`, `goal`, `offer`,
   * `services`. Different text is a different content hash, so the second
   * screen MISSES the cache and makes a fresh paid call, which can abstain,
   * fail or time out entirely on its own. Routing a refused brief to
   * `self-serve` therefore hands it to the one component whose job is to
   * start a generation and relies on a second, independent coin flip to stop
   * it.
   *
   * That is the same shape of mistake as the one that put a drugs and
   * firearms shop on `self-serve` three times on 2026-09-15, so it gets the
   * same answer: the funnel stops at the gate. The refusal notice
   * `@/lib/policy` already produced travels with the decision, so the copy is
   * still written in exactly one place -- it is just delivered one screen
   * earlier, by the module that already knows.
   */
  | 'refused'
  /**
   * Nobody has read this brief and nobody may act on it yet.
   *
   * Not `self-serve`, which is this module getting out of the way and letting
   * a generation start. Not `discovery-call`, which is a sales offer. The
   * visitor is told, in their own language, that a person will look at it
   * shortly; `spendsGenerationBudget` is false for it, no booking link is
   * minted, a `policy_reviews` row is already open against it and the
   * classifier-outage alert is already counting.
   *
   * This route exists because `review` did not distinguish "a person should
   * check this licence" from "no classifier answered", and #180's table
   * mapped both to `self-serve`. On staging that turned a fail-closed rule
   * into a fail-OPEN route: a brief asking for a shop selling recreational
   * drugs and unregistered firearms for crypto with no ID checks was routed
   * `self-serve` three times, which is a preview being generated.
   */
  | 'hold';

/**
 * The visitor's answer to "is this a site, or software?", as a decided value
 * rather than as the sentence they tapped.
 *
 * The browser sends the key of the chip, not its English label, so the rule
 * reads an enum instead of matching prose -- a rule that compared the answer
 * to a translated string would decide differently in the second locale the
 * product ships, and would be a string matcher deciding policy, which this
 * codebase does not do. `undefined` means the question has not been answered,
 * and `other` means they chose to type instead, which is evidence for the
 * classifier rather than an answer to this rule.
 */
export type ScopeAnswer = 'site' | 'software' | 'other';

export interface ScopeRouteInput {
  scope: Scope;
  /**
   * 0..1, as the classifier reported it. Kept for the lead row and the
   * operator card, not read by this function any more: see the module doc on
   * why comparing it to a threshold in here was the bug. Values outside 0..1
   * are the classifier's problem, not this one's.
   */
  confidence: number;
  /**
   * The acceptable-use gate's verdict, when there is one.
   *
   * Absent means "no gate ran", which must behave exactly as `allowed` rather
   * than routing every visitor somewhere else. Present and not `allowed`
   * means this module steps aside: see the module doc on why neither a
   * refusal nor a hold is ever offered a calendar.
   */
  acceptableUse?: AcceptableUse;
  /**
   * What the visitor answered, when they have. The rule acts on it.
   */
  visitorAnswer?: ScopeAnswer;
  /**
   * True once the visitor has answered the clarifying question in any form,
   * including by typing something that is neither option. The funnel asks it
   * at most once -- a second "sorry, which is it?" is an interrogation, not a
   * conversation.
   */
  alreadyClarified?: boolean;
  /**
   * True when the tier that produced `scope` has ALREADY decided, on its own
   * calibration, that it is confident enough to act on -- see
   * `ScopeClassification.decided` in `./scope-classifier` for the full story.
   * This module reads the flag and does not know or care which tier set it or
   * how.
   *
   * Absent or false is "not decided": a `custom` or `standard` verdict
   * without it is treated exactly like an `unclear` one everywhere this
   * module would otherwise have acted on it directly -- the visitor is asked,
   * or, in the disagreement check, the verdict does not outrank their answer.
   */
  decided?: boolean;
}

export interface ScopeRouteDecision {
  route: ScopeRoute;
  /**
   * The scope as the rule settled it, which is not always the scope the
   * classifier reported: the visitor's own answer settles it, and a
   * disagreement between the two settles nothing.
   *
   * This is the value the API returns and the value the copy is chosen from.
   * Returning the classifier's raw verdict here is what let a screen assert
   * "you described software" over a recorded scope of `unclear`.
   */
  scope: Scope;
  /** The rule that produced it, for the lead row and for the tests. */
  rule: ScopeRouteRuleId;
  /** One sentence an operator reads on the pipeline card. */
  reason: string;
  /**
   * True when a person should look at this brief even though the visitor is
   * carrying on. The gate files an acceptable-use review row for it.
   *
   * Distinct from the route on purpose: "somebody should read this" and
   * "where does the visitor go next" are two questions, and the version of
   * this module that answered them with one value is the version that sent a
   * flower shop to a sales call.
   */
  operatorReview: boolean;
}

export type ScopeRouteRuleId =
  | 'acceptableUseNeedsAHuman'
  | 'acceptableUseRefused'
  | 'acceptableUseUnavailable'
  | 'acceptableUseUnsettled'
  | 'customAboveThreshold'
  | 'customBelowThreshold'
  | 'standardAboveThreshold'
  | 'standardBelowThreshold'
  | 'unclear'
  | 'visitorSaysSite'
  | 'visitorSaysSoftware'
  | 'visitorSaysSiteClassifierSaysCustom'
  | 'clarifiedCustom'
  | 'clarifiedStandard'
  | 'clarifiedStillUnclear';

function envConfidence(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : fallback;
}

/**
 * The default bars. Deliberately not equal: see the module doc on why `custom`
 * is held higher than `standard`.
 */
const DEFAULT_CUSTOM_CONFIDENCE = 0.7;
const DEFAULT_STANDARD_CONFIDENCE = 0.6;

/** Read per call rather than frozen at import, so a test can set the env. */
export function scopeRouteThresholds(): {
  customAtOrAbove: number;
  standardAtOrAbove: number;
} {
  return {
    customAtOrAbove: envConfidence(
      'SCOPE_CUSTOM_CONFIDENCE',
      DEFAULT_CUSTOM_CONFIDENCE
    ),
    standardAtOrAbove: envConfidence(
      'SCOPE_STANDARD_CONFIDENCE',
      DEFAULT_STANDARD_CONFIDENCE
    ),
  };
}

const REASONS: Record<ScopeRouteRuleId, string> = {
  acceptableUseNeedsAHuman:
    'The acceptable use check did not clear this brief, so a person reads it before anything is built. It is not custom work and it is not offered a call.',
  acceptableUseRefused:
    'The acceptable use gate refused this brief. It is not custom work and it is not offered a call; the preview route refuses it in its own words.',
  acceptableUseUnavailable:
    'Nothing could classify this brief, so nobody has read it. It is held for a person, no preview is generated and no call is offered.',
  acceptableUseUnsettled:
    'The acceptable use check named no category, so it says nothing about this business and does not override what the brief is for.',
  customAboveThreshold:
    'The brief reads as custom work rather than a site that presents a business.',
  customBelowThreshold:
    'The brief leans custom but not confidently enough to say so without asking.',
  standardAboveThreshold:
    'The brief reads as a standard site that presents a business.',
  standardBelowThreshold:
    'The brief leans standard but not confidently enough to start a build without asking.',
  unclear:
    'The brief could be either a site or a piece of software, so the visitor is asked which.',
  visitorSaysSite:
    'The visitor was asked and said this is a site that presents their business, so the preview continues.',
  visitorSaysSoftware:
    'The visitor was asked and said this is software their customers log into, which is custom work for DMPResearch.',
  visitorSaysSiteClassifierSaysCustom:
    'The visitor says this is a site and the classifier is confident it is software. The visitor continues to their preview and an operator reads the disagreement.',
  clarifiedCustom:
    'After the clarifying question the brief is custom work for DMPResearch.',
  clarifiedStandard:
    'After the clarifying question the brief is a standard site, so the preview continues.',
  clarifiedStillUnclear:
    'The brief is still ambiguous after the clarifying question. The visitor continues to their preview and an operator reads the brief.',
};

function decision(
  rule: ScopeRouteRuleId,
  route: ScopeRoute,
  scope: Scope,
  operatorReview = false
): ScopeRouteDecision {
  return { route, rule, scope, reason: REASONS[rule], operatorReview };
}

/**
 * The routing rule, whole.
 *
 * Pure, synchronous, no IO. Read top to bottom:
 *
 *   acceptable use    four different answers, and they do four different
 *                     things. `blocked` and a CATEGORISED `review` end the
 *                     decision at `self-serve`, which means "this module has
 *                     no opinion left" and hands the visitor to the preview
 *                     route that owns the policy copy. `hold` -- nothing
 *                     classified the brief -- ends it at `hold`, which
 *                     generates nothing. An UNCATEGORISED `review` ends
 *                     nothing at all: it says nothing about the business, so
 *                     the scope rules below decide. None of the four is ever
 *                     offered a call.
 *   visitor answer    an explicit answer settles the scope, unless the
 *                     classifier's own tier has already decided the opposite,
 *                     which is a disagreement rather than a verdict.
 *   clarified, typed  the second classification acts on whatever it reached.
 *   first pass        a verdict its own tier has decided acts, anything else
 *                     asks once.
 */
export function decideRoute(input: ScopeRouteInput): ScopeRouteDecision {
  const acceptableUse = input.acceptableUse ?? 'allowed';
  if (acceptableUse === 'blocked') {
    // Deliberately NOT the discovery call. A refused brief is a business we
    // will not build for, and the last thing it should get is an invitation to
    // a sales call with Darius's studio -- which is exactly what routing it to
    // `discovery-call` would file, email and calendar-invite.
    //
    // And deliberately not `self-serve` either, which is what it used to be.
    // See the `refused` route's own doc: `self-serve` mounts the component
    // that starts a generation, and the second screen it was trusting to stop
    // one classifies DIFFERENT text and can fail on its own. The refusal is
    // final and already written; there is nothing to gain by taking a second
    // opinion from a classifier that might not answer.
    return decision('acceptableUseRefused', 'refused', input.scope);
  }
  if (acceptableUse === 'hold') {
    // Nothing read this brief. Not the embeddings (they abstained, or their
    // verdict missed the guard), and not the model (it timed out, threw, or
    // is down).
    //
    // `self-serve` is the one answer that must not appear here, and it is
    // what this branch used to give. `self-serve` means "this module has no
    // opinion left, let the preview route screen again" -- which is sound
    // when a classifier HAS spoken, because the second screen is cached and
    // reaches the same verdict. It is not sound when no classifier spoke at
    // all: the second screen re-runs against a DIFFERENT composed subject, so
    // it misses the cache, and may time out exactly as the first one did. Two
    // coin flips are not a gate.
    //
    // So the funnel stops here instead, in its own words. The row is already
    // open (`screenAcceptableUse` wrote it before this ran) and the outage
    // alert is already counting.
    return decision('acceptableUseUnavailable', 'hold', input.scope, true);
  }
  if (acceptableUse === 'review') {
    // A tier NAMED a category: a licensed pharmacy, a bookmaker, something
    // prohibited it was not sure enough about to refuse. #180's behaviour,
    // unchanged -- the visitor carries on and an operator reads the row --
    // and deliberately not a calendar. This branch used to route to the
    // discovery call, and on staging the embedding tier abstained on nearly
    // every brief, so nearly every brief became a sales call: a flower shop,
    // and also an escort service and a firearms seller, each handed a
    // prefilled calendar link.
    return decision('acceptableUseNeedsAHuman', 'self-serve', input.scope);
  }
  // `unsettled` falls through to the scope rules on purpose. A review that
  // named no category is not a finding about this business, and letting it
  // end the decision here is what swallowed the clarifying question: the
  // vague brief was screened, came back `review|none`, and the funnel
  // answered the acceptable-use branch instead of asking the one question
  // that would have settled it.
  //
  // It falls through to the rules, though, and NOT to the calendar. See
  // `withoutACalendar` below: "does not override the scope decision" and "may
  // be sold to" are different permissions, and only the first is granted by a
  // verdict that came back uncategorised.
  return acceptableUse === 'unsettled'
    ? withoutACalendar(scopeDecision(input))
    : scopeDecision(input);
}

/**
 * Strip the discovery call out of a decision the scope rules reached.
 *
 * The invariant #180 established, and the one thing that must survive
 * `unsettled` falling through: **only a clean acceptable-use verdict may
 * produce a calendar.** `discovery-call` is not a neutral destination. It
 * files a `custom_work_leads` row with the visitor's name and address, emails
 * Darius, and hands back a booking URL with both already in the query string.
 * Doing that on the strength of a verdict that named no category means doing
 * it for a brief the classifier was not confident was clean -- and on staging
 * an uncategorised review is exactly what a request to sell drugs and
 * unregistered firearms produced.
 *
 * So the scope rules still decide what the brief IS (which is why the vague
 * brief still gets its one question, and a standard site still reaches its
 * preview); they just cannot spend a sales motion on it. `self-serve` is the
 * substitute for the same reason it substitutes for a refusal: it means this
 * module has no opinion left, and the preview route screens again and owns
 * whatever copy is due.
 */
function withoutACalendar(scoped: ScopeRouteDecision): ScopeRouteDecision {
  if (scoped.route !== 'discovery-call') return scoped;
  return {
    ...decision('acceptableUseUnsettled', 'self-serve', scoped.scope, true),
    // Keep the scope the rules settled: an operator reading the row should
    // see that this WAS custom work, and that the only reason no call was
    // offered is that acceptable use came back uncategorised.
    scope: scoped.scope,
  };
}

/** The scope half, after acceptable use has had its say. */
function scopeDecision(input: ScopeRouteInput): ScopeRouteDecision {
  const classifierIsSureItIsCustom =
    input.scope === 'custom' && input.decided === true;

  if (input.visitorAnswer === 'software') {
    // Nothing outranks this. Somebody who has just said their customers log
    // in has told us more than a paragraph about their business ever will.
    return decision('visitorSaysSoftware', 'discovery-call', 'custom');
  }

  if (input.visitorAnswer === 'site') {
    if (classifierIsSureItIsCustom) {
      // The one case an answer does not settle. Two sources disagree and both
      // are credible, so the rule refuses to invent a verdict: `unclear` is
      // recorded, an operator is given the brief to read, and the visitor --
      // who has told us plainly what they want -- carries on to their
      // preview rather than being told they said something else.
      return decision(
        'visitorSaysSiteClassifierSaysCustom',
        'self-serve',
        'unclear',
        true
      );
    }
    return decision('visitorSaysSite', 'self-serve', 'standard');
  }

  if (input.alreadyClarified) {
    // The question was asked and answered with neither option, so the answer
    // went to the classifier as evidence and this acts on what came back, at
    // whatever confidence. Asking again is not an option.
    if (input.scope === 'custom')
      return decision('clarifiedCustom', 'discovery-call', 'custom');
    if (input.scope === 'standard')
      return decision('clarifiedStandard', 'self-serve', 'standard');
    // Still nothing. The visitor answered in good faith and we cannot tell,
    // which is our problem and not theirs: they continue, and an operator
    // reads the brief. Routing this to a sales call, as it used to, sold to
    // somebody who had asked for a website.
    return decision('clarifiedStillUnclear', 'self-serve', 'unclear', true);
  }

  if (input.scope === 'custom') {
    return classifierIsSureItIsCustom
      ? decision('customAboveThreshold', 'discovery-call', 'custom')
      : decision('customBelowThreshold', 'ask-one-more-question', 'unclear');
  }

  if (input.scope === 'standard') {
    return input.decided === true
      ? decision('standardAboveThreshold', 'self-serve', 'standard')
      : decision('standardBelowThreshold', 'ask-one-more-question', 'unclear');
  }

  return decision('unclear', 'ask-one-more-question', 'unclear');
}

/**
 * True when this route must not start a generation.
 *
 * The one property the whole feature exists to guarantee, written down once so
 * the funnel and the tests read the same rule rather than each spelling out
 * `route !== 'self-serve'` and drifting.
 */
export function spendsGenerationBudget(route: ScopeRoute): boolean {
  return route === 'self-serve';
}

/**
 * Which copy a `hold` shows, as locale keys.
 *
 * Its own pair rather than reusing `landing.discovery.scope.review.*`,
 * because the two say different things and only one of them is true here.
 * The review copy tells a visitor their business "sits close enough to our
 * acceptable-use policy that a person checks it" -- a sentence about their
 * business, which we are in no position to write when nothing read it. The
 * hold copy says what actually happened: we could not finish checking, a
 * person will look shortly, and nothing has been charged.
 */
export const HOLD_COPY: ScopeOfferCopy = {
  titleKey: 'landing.discovery.scope.hold.title',
  bodyKey: 'landing.discovery.scope.hold.body',
};

// ---------------------------------------------------------------------------
// The copy the decision is allowed to show
// ---------------------------------------------------------------------------

/**
 * Which locale keys the discovery-call screen may use for this scope.
 *
 * The rule picks the copy, the client renders it. That is the same division as
 * everywhere else here, and it exists because the alternative shipped: the
 * screen had one hard-coded sentence -- "what you have described is not a site
 * that presents your business, it is software built for it" -- and rendered it
 * for every visitor that reached the offer, including the ones the gate had
 * recorded as `unclear` and the ones who had just tapped the opposite. A
 * screen asserting a verdict nothing reached is worse than no screen.
 *
 * `custom` is the only scope allowed the assertion, and `custom` is only ever
 * reached from a verdict: a confident classification, or the visitor's own
 * answer that their customers log in.
 */
export interface ScopeOfferCopy {
  titleKey: string;
  bodyKey: string;
}

const OFFER_COPY: Record<Scope, ScopeOfferCopy> = {
  custom: {
    titleKey: 'landing.discovery.scope.offer.title',
    bodyKey: 'landing.discovery.scope.offer.body',
  },
  // Neither of these asserts anything about what the visitor described. They
  // say what we know, which is that we could not settle it, and what happens
  // next.
  unclear: {
    titleKey: 'landing.discovery.scope.review.title',
    bodyKey: 'landing.discovery.scope.review.body',
  },
  standard: {
    titleKey: 'landing.discovery.scope.review.title',
    bodyKey: 'landing.discovery.scope.review.body',
  },
};

export function scopeOfferCopy(scope: Scope): ScopeOfferCopy {
  return OFFER_COPY[scope] ?? OFFER_COPY.unclear;
}
