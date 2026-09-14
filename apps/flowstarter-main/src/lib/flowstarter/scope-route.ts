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
 * supplies one verdict and a confidence. It does not decide anything. This
 * module is the decision: a pure function over that verdict, the confidence,
 * the acceptable-use gate's answer, and whether the visitor has already been
 * asked the one clarifying question. Same inputs, same route, every time, with
 * no IO and no import of the classifier.
 *
 * ── The thresholds ────────────────────────────────────────────────────────
 * Two numbers, both overridable by ops without a deploy, and neither of them
 * written at a call site:
 *
 *   SCOPE_CUSTOM_CONFIDENCE    below this, a `custom` verdict is not acted on
 *   SCOPE_STANDARD_CONFIDENCE  below this, a `standard` verdict is not acted on
 *
 * `custom` is held to the higher bar on purpose. Wrongly routing a standard
 * site to a call costs a sale; wrongly routing custom work to the generator
 * costs a generation run and ends with the visitor being told, after fifteen
 * minutes of watching a progress bar, that we built the wrong thing. The first
 * mistake is recoverable in the call. The second is not recoverable at all.
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

export interface ScopeRouteInput {
  scope: Scope;
  /** 0..1, as the classifier reported it. Values outside are clamped. */
  confidence: number;
  /**
   * The acceptable-use gate's verdict, when there is one.
   *
   * Absent means "no gate ran", which is the state of `main` until the
   * acceptable-use branch lands, and it must behave exactly as today rather
   * than routing every visitor to a call. Present and not `allowed` means a
   * human looks at it: whatever the gate decides to refuse, it refuses at its
   * own enforcement points, and nothing this module returns can spend a
   * generation on content the gate was unhappy with.
   */
  acceptableUse?: AcceptableUse;
  /**
   * True once the visitor has answered the clarifying question. The funnel
   * asks it at most once -- a second "sorry, which is it?" is an interrogation,
   * not a conversation.
   */
  alreadyClarified?: boolean;
}

export interface ScopeRouteDecision {
  route: ScopeRoute;
  /** The rule that produced it, for the lead row and for the tests. */
  rule: ScopeRouteRuleId;
  /** One sentence an operator reads on the pipeline card. */
  reason: string;
}

export type ScopeRouteRuleId =
  | 'acceptableUseNeedsAHuman'
  | 'acceptableUseRefused'
  | 'customAboveThreshold'
  | 'customBelowThreshold'
  | 'standardAboveThreshold'
  | 'standardBelowThreshold'
  | 'unclear'
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
    'The acceptable use check did not clear this brief, so it goes to a person rather than to the generator.',
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
  clarifiedCustom:
    'After the clarifying question the brief is custom work for DMPResearch.',
  clarifiedStandard:
    'After the clarifying question the brief is a standard site, so the preview continues.',
  clarifiedStillUnclear:
    'The brief is still ambiguous after the clarifying question, so a person picks it up rather than the generator.',
};

function decision(
  rule: ScopeRouteRuleId,
  route: ScopeRoute
): ScopeRouteDecision {
  return { route, rule, reason: REASONS[rule] };
}

/**
 * The routing rule, whole.
 *
 * Pure, synchronous, no IO. Read top to bottom: the acceptable-use gate wins
 * over everything, then the clarified pass acts on whatever verdict it has,
 * then the first pass acts only on a confident verdict and otherwise asks.
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
    return decision('acceptableUseRefused', 'self-serve');
  }
  if (acceptableUse !== 'allowed') {
    // `review`: lawful but sensitive, or the classifier could not settle it.
    // A person should read it, and the discovery call is how a person reads it.
    return decision('acceptableUseNeedsAHuman', 'discovery-call');
  }

  const confidence = Math.min(1, Math.max(0, Number(input.confidence) || 0));
  const thresholds = scopeRouteThresholds();

  if (input.alreadyClarified) {
    // The question has been asked and answered. Act on the verdict as it
    // stands, at whatever confidence: asking again is not an option, and a
    // brief that survives the question still ambiguous is exactly the brief a
    // person should be reading, not the generator.
    if (input.scope === 'custom')
      return decision('clarifiedCustom', 'discovery-call');
    if (input.scope === 'standard')
      return decision('clarifiedStandard', 'self-serve');
    return decision('clarifiedStillUnclear', 'discovery-call');
  }

  if (input.scope === 'custom') {
    return confidence >= thresholds.customAtOrAbove
      ? decision('customAboveThreshold', 'discovery-call')
      : decision('customBelowThreshold', 'ask-one-more-question');
  }

  if (input.scope === 'standard') {
    return confidence >= thresholds.standardAtOrAbove
      ? decision('standardAboveThreshold', 'self-serve')
      : decision('standardBelowThreshold', 'ask-one-more-question');
  }

  return decision('unclear', 'ask-one-more-question');
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
