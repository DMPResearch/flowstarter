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
 * the URL. Both of those verdicts now step aside to `self-serve`, where the
 * preview route screens again and answers with the copy `@/lib/policy` owns.
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
export type AcceptableUse = 'allowed' | 'review' | 'blocked';

/** The three places the funnel can send somebody at this point. */
export type ScopeRoute =
  | 'self-serve'
  | 'discovery-call'
  | 'ask-one-more-question';

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
 *   acceptable use    a refusal or a hold ends the decision here, at
 *                     `self-serve`, which means "this module has no opinion
 *                     left" and hands the visitor to the preview route that
 *                     owns the policy copy. Neither is ever offered a call.
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
    // `self-serve` here does not mean "build it". It means this module has no
    // opinion left and gets out of the way: the visitor falls through to
    // `/api/discovery/preview/live`, which screens again (the classifier is
    // cached, so the second screen costs nothing) and answers with the refusal
    // notice and the copy that `@/lib/policy` owns. Refusal is written in one
    // place, and it is not this one.
    return decision('acceptableUseRefused', 'self-serve', input.scope);
  }
  if (acceptableUse !== 'allowed') {
    // `review`: lawful but sensitive, or the classifier abstained. Same
    // stepping-aside as a refusal, and for a sharper reason than symmetry.
    // This branch used to route to the discovery call, and on staging the
    // embedding tier abstained on nearly every brief, so nearly every brief
    // became a sales call: a flower shop, and also an escort service and a
    // firearms seller, each handed a prefilled calendar link. The hold is
    // real and it is already recorded -- `screenAcceptableUse` wrote the
    // `policy_reviews` row before this ran -- and the preview route holds the
    // build on the same verdict. What must not happen is a calendar.
    return decision('acceptableUseNeedsAHuman', 'self-serve', input.scope);
  }

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
