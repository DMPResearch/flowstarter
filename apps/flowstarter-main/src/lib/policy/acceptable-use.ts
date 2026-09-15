/**
 * The acceptable-use policy, as data and one decision function.
 *
 * This module is pure. It imports nothing, opens no socket, reads no database
 * and never calls a model. It owns two things and only two things:
 *
 *   1. THE LISTS. Every prohibited category and every lawful-but-sensitive
 *      category, each with a stable id, a plain-language label, and the reason
 *      we refuse or review. Nothing else in the codebase may hold a second
 *      copy of these ids.
 *   2. THE THRESHOLDS. The confidence bands that turn one classification into
 *      `allow`, `review` or `refuse`, read from config with documented
 *      defaults, so no enforcement point ever writes a number of its own.
 *
 * What it deliberately does NOT own: detection. There is no phrase list, no
 * regular expression, no leetspeak table and no per-language vocabulary here.
 * Those were tried and they are fragile: a matcher loses to a space, a
 * homoglyph or a euphemism it has never seen, and it cannot read intent at
 * all. Detection is a classifier (see `./classifier.ts`); this file is the
 * rule layer, and the rule layer only decides.
 *
 * Rules decide, models phrase.
 */

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * What the platform does with one submission.
 *
 * - `allow`   the work proceeds with no human in the loop.
 * - `review`  the work stops and an operator is asked. Nothing is charged and
 *             nothing is built until a human says so. This is also where every
 *             uncertain answer lands, including a broken classifier.
 * - `refuse`  the work stops, the visitor is told why in plain words, and no
 *             money changes hands.
 */
export type PolicyDecision = 'allow' | 'review' | 'refuse';

/** How the policy treats a category when the classifier names it. */
export type CategoryDisposition = 'prohibited' | 'review' | 'clean';

export interface PolicyCategory {
  /**
   * Stable id. It is written to `project_events`, to the operator board, to
   * the evaluation fixtures and (when the sigma package lands) to its label
   * space. Renaming one is a migration, not an edit.
   */
  id: string;
  /** Plain-language label. Operator-facing and visitor-facing. */
  label: string;
  /**
   * Why we refuse it, or why it needs a human. One sentence, no hedging, in
   * the words we would use to a client on the phone.
   */
  reason: string;
  disposition: CategoryDisposition;
}

/**
 * The id the classifier returns when it finds nothing in either list. It is a
 * real category so that every code path has one id to carry, rather than a
 * null each call site would have to remember to handle.
 */
export const CLEAN_CATEGORY_ID = 'none';

/**
 * Businesses we will not build a site for, at any price.
 *
 * The reasons are the copy an operator reads and, condensed, the copy the
 * visitor reads. They are written to be true rather than defensive: we are a
 * small studio in Romania, these categories carry licensing, payment-processor
 * and criminal exposure we are not equipped to carry, and saying so is more
 * honest than implying a moral judgement on a lawful trader.
 */
export const PROHIBITED_CATEGORIES: readonly PolicyCategory[] = [
  {
    id: 'illegal_drugs',
    label: 'Illegal drugs and controlled substances',
    reason:
      'Selling or sourcing controlled substances is a crime in the countries we work in, and we will not build the shopfront for it.',
    disposition: 'prohibited',
  },
  {
    id: 'sexual_services',
    label: 'Prostitution and escort services',
    reason:
      'Arranging or advertising paid sexual services is illegal in Romania and in most of the markets our clients sell into.',
    disposition: 'prohibited',
  },
  {
    id: 'adult_content',
    label: 'Adult content and its promotion',
    reason:
      'We do not build pornography, cam sites, or creator pages whose purpose is to sell adult content, including OnlyFans-style funnels.',
    disposition: 'prohibited',
  },
  {
    id: 'weapons_sales',
    label: 'Weapons and ammunition sales',
    reason:
      'Selling firearms, ammunition or their components online is licensed trade we are not authorised to help conduct.',
    disposition: 'prohibited',
  },
  {
    id: 'unlicensed_gambling',
    label: 'Gambling without a licence',
    reason:
      'Taking bets or running games of chance needs a gambling licence, and an unlicensed operation is one we cannot put online.',
    disposition: 'prohibited',
  },
  {
    id: 'counterfeit_goods',
    label: 'Counterfeit goods',
    reason:
      'Selling replicas or knock-offs of another company brand is trademark infringement, and it would put your site and ours at risk.',
    disposition: 'prohibited',
  },
  {
    id: 'hate_or_harassment',
    label: 'Hate or harassment',
    reason:
      'We do not publish content that attacks people for who they are, or that exists to target an individual.',
    disposition: 'prohibited',
  },
  {
    id: 'scams_impersonation',
    label: 'Scams and impersonation',
    reason:
      'Sites built to take money under a false identity, or to pass themselves off as another business, are fraud and we will not host one.',
    disposition: 'prohibited',
  },
  {
    id: 'unlicensed_claims',
    label: 'Unlicensed medical or financial claims',
    reason:
      'Promising cures, diagnoses or investment returns without the licence to make those claims exposes your customers and you to real harm.',
    disposition: 'prohibited',
  },
] as const;

/**
 * Lawful but sensitive. These are real businesses run by real people, and the
 * right answer to them is a human, not a refusal.
 *
 * A pharmacy, a licensed dispensary, a range that teaches firearm safety, a
 * sexual health clinic, a licensed bookmaker and a lingerie shop all sit close
 * enough to a prohibited category that a classifier will reach for one. So the
 * policy gives them their own ids and routes them to the operator board, where
 * someone can look at the licence and say yes. Refusing them by reflex would
 * be the more expensive mistake: it turns paying customers away, and it
 * teaches the studio to distrust its own gate.
 */
export const REVIEW_CATEGORIES: readonly PolicyCategory[] = [
  {
    id: 'licensed_pharmacy',
    label: 'Licensed pharmacy or medicine retail',
    reason:
      'A pharmacy is a lawful business with a licence behind it, so an operator checks the licence rather than the gate refusing it.',
    disposition: 'review',
  },
  {
    id: 'legal_cannabis',
    label: 'Cannabis where it is legal',
    reason:
      'Cannabis is lawful in some of the markets we serve and not in others, so the jurisdiction is a question for a person.',
    disposition: 'review',
  },
  {
    id: 'firearms_training',
    label: 'Firearms training and ranges',
    reason:
      'Teaching safe handling is not selling a weapon, and an operator confirms the site stays on the training side.',
    disposition: 'review',
  },
  {
    id: 'sexual_health_clinic',
    label: 'Sexual health clinics and education',
    reason:
      'Clinical and educational work about sex is legitimate healthcare, and an operator confirms that is what the site is.',
    disposition: 'review',
  },
  {
    id: 'licensed_betting',
    label: 'Licensed betting and lottery',
    reason:
      'A licensed bookmaker is lawful trade, and an operator checks the licence number before the build starts.',
    disposition: 'review',
  },
  {
    id: 'adult_adjacent_lawful',
    label: 'Lawful adult-adjacent retail and services',
    reason:
      'Lingerie, dating and similar lawful trades are often mistaken for adult content, so a person looks before we say no.',
    disposition: 'review',
  },
] as const;

/** The clean verdict, as a category, so every path carries one shape. */
export const CLEAN_CATEGORY: PolicyCategory = {
  id: CLEAN_CATEGORY_ID,
  label: 'No policy category',
  reason: 'Nothing in this submission falls under the acceptable-use policy.',
  disposition: 'clean',
};

/** Every category the classifier may return, clean included. */
export const ALL_CATEGORIES: readonly PolicyCategory[] = [
  ...PROHIBITED_CATEGORIES,
  ...REVIEW_CATEGORIES,
  CLEAN_CATEGORY,
];

const BY_ID = new Map<string, PolicyCategory>(
  ALL_CATEGORIES.map((category) => [category.id, category])
);

/** The category for an id, or `null` when the id is not one of ours. */
export function categoryById(
  id: string | null | undefined
): PolicyCategory | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

/** Every id, in declaration order. The classifier prompt is built from this. */
export const CATEGORY_IDS: readonly string[] = ALL_CATEGORIES.map((c) => c.id);

// ---------------------------------------------------------------------------
// Thresholds (config, never a literal at a call site)
// ---------------------------------------------------------------------------

export interface PolicyThresholds {
  /**
   * At or above this confidence, a prohibited category is refused outright.
   * Below it the answer is not certain enough to tell a stranger no by
   * machine, so a person decides.
   */
  refuseConfidence: number;
  /**
   * At or above this confidence, a named category is worth a human's time.
   * Below it the classifier is guessing, and a guess is not evidence.
   */
  reviewConfidence: number;
  /**
   * The floor for trusting a `clean` answer. A classifier that says "nothing
   * here" with low confidence has abstained, and an abstention is a review,
   * not an allow. This is the abstention band.
   */
  cleanConfidence: number;
}

/**
 * The defaults, and the only place they are written.
 *
 * They are deliberately asymmetric. `refuseConfidence` is high because a
 * refusal is the one verdict the visitor cannot appeal in the moment.
 * `cleanConfidence` is lower than `refuseConfidence` because most submissions
 * are a dentist or a coffee roaster, and holding those for review would drown
 * the operator board, which is how a review queue stops being read.
 */
export const DEFAULT_THRESHOLDS: PolicyThresholds = {
  refuseConfidence: 0.75,
  reviewConfidence: 0.35,
  cleanConfidence: 0.5,
};

function envConfidence(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

/**
 * The thresholds in force, after config.
 *
 *   ACCEPTABLE_USE_REFUSE_CONFIDENCE
 *   ACCEPTABLE_USE_REVIEW_CONFIDENCE
 *   ACCEPTABLE_USE_CLEAN_CONFIDENCE
 *
 * An out-of-range or unparseable value falls back to the default rather than
 * disabling the gate, because a typo in an env var must not open the door.
 */
export function policyThresholds(): PolicyThresholds {
  return {
    refuseConfidence: envConfidence(
      'ACCEPTABLE_USE_REFUSE_CONFIDENCE',
      DEFAULT_THRESHOLDS.refuseConfidence
    ),
    reviewConfidence: envConfidence(
      'ACCEPTABLE_USE_REVIEW_CONFIDENCE',
      DEFAULT_THRESHOLDS.reviewConfidence
    ),
    cleanConfidence: envConfidence(
      'ACCEPTABLE_USE_CLEAN_CONFIDENCE',
      DEFAULT_THRESHOLDS.cleanConfidence
    ),
  };
}

// ---------------------------------------------------------------------------
// Operational limits (the other half of "no numbers at a call site")
// ---------------------------------------------------------------------------

export interface PolicyLimits {
  /**
   * How much text one classification may read. Everything past it is dropped,
   * not truncated silently: the caller composes the subject so the most
   * telling fields come first (see `subject.ts`).
   */
  maxInputChars: number;
  /**
   * How many classifier calls one submission may pay for, across retries and
   * re-saves inside the cache window. The cap is what stops a visitor holding
   * the save button from becoming a bill.
   */
  maxCallsPerSubmission: number;
  /** How long a classification stays valid for the same content hash. */
  cacheTtlMs: number;
  /**
   * How long the SPEND against one content hash is remembered.
   *
   * Longer than the cache TTL on purpose, and the two answer different
   * questions. The TTL asks "is this verdict still fresh enough to reuse?";
   * this asks "how much have we already spent classifying this exact text?".
   * If they were the same number, a caller could wait out the TTL and start
   * the bill again, and `maxCallsPerSubmission` would cap nothing.
   */
  spendWindowMs: number;
  /** Entries kept in the in-process cache before the oldest is evicted. */
  cacheMaxEntries: number;
  /** Wall-clock ceiling for one classifier call. A timeout is a failure. */
  timeoutMs: number;
  /**
   * The ceiling on how much of a built site the post-build scan reads. A site
   * is far larger than any submission, so the scan reads a bounded, ordered
   * sample rather than the whole tree.
   */
  scanMaxChars: number;
}

/** The defaults, and the only place they are written. */
export const DEFAULT_LIMITS: PolicyLimits = {
  maxInputChars: 12_000,
  maxCallsPerSubmission: 2,
  cacheTtlMs: 30 * 60 * 1000,
  spendWindowMs: 6 * 60 * 60 * 1000,
  cacheMaxEntries: 500,
  timeoutMs: 15_000,
  scanMaxChars: 60_000,
};

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * The limits in force, after config. Same fallback discipline as the
 * thresholds: a bad value is ignored, never treated as "off".
 */
export function policyLimits(): PolicyLimits {
  return {
    maxInputChars: envInteger(
      'ACCEPTABLE_USE_MAX_INPUT_CHARS',
      DEFAULT_LIMITS.maxInputChars
    ),
    maxCallsPerSubmission: envInteger(
      'ACCEPTABLE_USE_MAX_CALLS_PER_SUBMISSION',
      DEFAULT_LIMITS.maxCallsPerSubmission
    ),
    cacheTtlMs: envInteger(
      'ACCEPTABLE_USE_CACHE_TTL_MS',
      DEFAULT_LIMITS.cacheTtlMs
    ),
    spendWindowMs: envInteger(
      'ACCEPTABLE_USE_SPEND_WINDOW_MS',
      DEFAULT_LIMITS.spendWindowMs
    ),
    cacheMaxEntries: envInteger(
      'ACCEPTABLE_USE_CACHE_MAX_ENTRIES',
      DEFAULT_LIMITS.cacheMaxEntries
    ),
    timeoutMs: envInteger(
      'ACCEPTABLE_USE_TIMEOUT_MS',
      DEFAULT_LIMITS.timeoutMs
    ),
    scanMaxChars: envInteger(
      'ACCEPTABLE_USE_SCAN_MAX_CHARS',
      DEFAULT_LIMITS.scanMaxChars
    ),
  };
}

// ---------------------------------------------------------------------------
// The classification the rule layer decides on
// ---------------------------------------------------------------------------

/** Which tier produced this answer. Recorded so the board can be read later. */
export type ClassifierTier = 'embedding' | 'llm' | 'unavailable';

/**
 * One classification, from whichever tier produced it.
 *
 * This is the whole contract between detection and the rule layer. When the
 * sigma package lands, its `DecisionTrace` is adapted into this shape and
 * nothing below changes.
 */
export interface PolicyClassification {
  /** One of {@link CATEGORY_IDS}. An unknown id is treated as unusable. */
  categoryId: string;
  /** 0..1. Values outside the range are clamped. */
  confidence: number;
  /**
   * One sentence, in the classifier's words, naming what it saw. It is shown
   * to the operator and never to the visitor, and it is never written to a log
   * line: logs carry the evidence hash instead.
   */
  evidence: string;
  /**
   * The classifier's own abstention flag. Set when it can see the answer is
   * close, the jurisdiction matters, or the text is too thin to judge. It can
   * only ever make the verdict stricter.
   */
  needsHuman: boolean;
  tier: ClassifierTier;
  /** True when no tier could answer at all (error, timeout, no key). */
  failed?: boolean;
  /**
   * An action a tier has ALREADY decided, on its own calibrated bands.
   *
   * Set only by the sigma tier. Its bands are calibrated against cosine
   * margins between embedding centroids; `confidence` below is a model's
   * self-reported probability. The two numbers are not on the same scale, and
   * re-deriving a verdict from one using thresholds tuned for the other would
   * silently loosen or tighten the gate with nothing in the diff to show it.
   *
   * So when a tier that owns its own calibration has decided, `decide()`
   * honours it. The thresholds below still govern every tier that has not.
   */
  decidedAction?: PolicyDecision;
}

export type PolicyRule =
  | 'tier_decided'
  | 'clean_confident'
  | 'clean_but_abstained'
  | 'needs_human_flag'
  | 'prohibited_confident'
  | 'prohibited_uncertain'
  | 'prohibited_below_floor'
  | 'sensitive_lawful'
  | 'sensitive_below_floor'
  | 'classifier_failed_closed'
  | 'classifier_failed_open'
  | 'unknown_category'
  /**
   * The two the scope gate opens a review under (`@/lib/flowstarter/
   * scope-route`). Nothing in `decide()` produces them: the scope decision is
   * a different rule layer, and these exist so that "a person should read this
   * brief" has one queue rather than two. The acceptable-use verdict on such a
   * row is `allow` -- what is in question is what we are being asked to build,
   * not whether we may build it.
   */
  | 'scope_visitor_disagrees_with_classifier'
  | 'scope_unresolved_after_question';

export interface PolicyVerdict {
  decision: PolicyDecision;
  category: PolicyCategory;
  confidence: number;
  /**
   * Why the rule layer landed here, in machine words. Stable enough to assert
   * on in a test and to group by on the board.
   */
  rule: PolicyRule;
  tier: ClassifierTier;
  needsHuman: boolean;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * True when a failed classifier must yield `review` rather than `allow`.
 *
 * Production fails closed: a broken model is not a licence to build a drug
 * shop. Every other environment fails open, because a developer without an API
 * key must still be able to run the funnel, and a local machine is not where a
 * stranger's site gets published. `ACCEPTABLE_USE_FAIL_CLOSED` overrides both
 * ways, which is what staging uses to rehearse the production behaviour.
 */
export function failsClosed(): boolean {
  if (process.env.ACCEPTABLE_USE_FAIL_CLOSED === 'true') return true;
  if (process.env.ACCEPTABLE_USE_FAIL_CLOSED === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

/**
 * The rule layer. One classification in, one verdict out, no I/O.
 *
 * The order of the checks is the order of the policy's priorities:
 *
 *   1. A classifier that could not answer never yields `allow` in production.
 *   2. An id we do not recognise is an abstention, not a clean bill: a model
 *      that invented a label has not read the policy.
 *   3. A prohibited category above the refuse bar is refused.
 *   4. Anything else the classifier flagged, or was unsure about, is a review.
 *   5. Only a confident `clean` is allowed.
 */
export function decide(
  classification: PolicyClassification,
  thresholds: PolicyThresholds = policyThresholds()
): PolicyVerdict {
  const confidence = clamp01(classification.confidence);
  const tier = classification.tier;
  const needsHuman = classification.needsHuman === true;

  if (classification.failed) {
    const closed = failsClosed();
    return {
      decision: closed ? 'review' : 'allow',
      category: CLEAN_CATEGORY,
      confidence: 0,
      rule: closed ? 'classifier_failed_closed' : 'classifier_failed_open',
      tier,
      needsHuman: true,
    };
  }

  const category = categoryById(classification.categoryId);

  // A tier with its own calibration has already decided. Honoured before the
  // bands below, and deliberately BEFORE the unknown-category check too: the
  // sigma tier can decide `review` having settled on no category at all
  // (its embedding tier abstained and nothing overruled it), and that is a
  // decision, not a model inventing a label.
  if (classification.decidedAction) {
    return {
      decision: classification.decidedAction,
      category: category ?? CLEAN_CATEGORY,
      confidence,
      rule: 'tier_decided',
      tier,
      needsHuman: classification.decidedAction !== 'allow',
    };
  }

  if (!category) {
    return {
      decision: 'review',
      category: CLEAN_CATEGORY,
      confidence,
      rule: 'unknown_category',
      tier,
      needsHuman: true,
    };
  }

  if (category.disposition === 'prohibited') {
    if (confidence >= thresholds.refuseConfidence) {
      return {
        decision: 'refuse',
        category,
        confidence,
        rule: 'prohibited_confident',
        tier,
        needsHuman,
      };
    }
    if (confidence >= thresholds.reviewConfidence || needsHuman) {
      return {
        decision: 'review',
        category,
        confidence,
        rule: 'prohibited_uncertain',
        tier,
        needsHuman,
      };
    }
    // The classifier named a prohibited category and then told us it barely
    // believes its own answer. That is noise, not evidence, and treating it as
    // a review would fill the board with dentists.
    return {
      decision: 'allow',
      category: CLEAN_CATEGORY,
      confidence,
      rule: 'prohibited_below_floor',
      tier,
      needsHuman,
    };
  }

  if (category.disposition === 'review') {
    if (confidence >= thresholds.reviewConfidence || needsHuman) {
      return {
        decision: 'review',
        category,
        confidence,
        rule: 'sensitive_lawful',
        tier,
        needsHuman,
      };
    }
    return {
      decision: 'allow',
      category: CLEAN_CATEGORY,
      confidence,
      rule: 'sensitive_below_floor',
      tier,
      needsHuman,
    };
  }

  if (needsHuman) {
    return {
      decision: 'review',
      category: CLEAN_CATEGORY,
      confidence,
      rule: 'needs_human_flag',
      tier,
      needsHuman: true,
    };
  }
  if (confidence >= thresholds.cleanConfidence) {
    return {
      decision: 'allow',
      category: CLEAN_CATEGORY,
      confidence,
      rule: 'clean_confident',
      tier,
      needsHuman: false,
    };
  }
  return {
    decision: 'review',
    category: CLEAN_CATEGORY,
    confidence,
    rule: 'clean_but_abstained',
    tier,
    needsHuman: true,
  };
}

/** True when the verdict stops the flow. Read at every enforcement point. */
export function blocks(verdict: PolicyVerdict): boolean {
  return verdict.decision !== 'allow';
}
