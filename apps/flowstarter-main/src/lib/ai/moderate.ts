import 'server-only';

/**
 * The old moderator, reduced to an adapter over the one acceptable-use gate.
 *
 * ── What used to be here ──────────────────────────────────────────────────
 * Thirteen regular expressions (`/onlyfans?/i`, `/spicy\s+girls?/i`,
 * `/cam(girl|boy)?/i`, `/escort/i`, `/strip(per)?/i`, ...) run against a
 * lowercased concatenation of the description and the services, followed by a
 * second LLM prompt carrying a second, differently-worded taxonomy and its own
 * risk score, its own thresholds and its own JSON contract. It was the
 * product's second guardrail, and it disagreed with the first one -- the
 * classifier in `@/lib/policy` -- about what the categories are, what the
 * bands are, and what happens on an uncertain answer.
 *
 * Two of those disagreements cost real behaviour:
 *
 *   - `POST /api/discovery/intake-graph` ran this BEFORE and INDEPENDENTLY of
 *     the acceptable-use gate, and on a hit ended the visitor's turn silently.
 *     A prohibited brief typed into the browser reached no gate, produced no
 *     notice, and left the wizard stuck; the same brief POSTed straight to
 *     `/api/discovery/scope` was refused correctly, with a category, at the
 *     LLM tier. Filmed twice on 2026-09-15.
 *   - a matcher loses to a space, a homoglyph, a euphemism it has not seen,
 *     and to any language it was not written in. `escort` catches an English
 *     escort agency and not a Romanian one; nothing in the list reads intent
 *     at all.
 *
 * The owner's rule is the reason it is gone rather than extended: "the
 * guardrails should be implemented by a system prompt or inside the classifier
 * instead of friable regexes". Detection is the classifier's job
 * (`@/lib/policy/classifier.ts`); the categories and the bands are the rule
 * layer's (`@/lib/policy/acceptable-use.ts`); the sentence a visitor reads is
 * the copy layer's (`@/lib/policy/copy.ts`). None of the three is duplicated
 * here any more.
 *
 * ── What is here now ──────────────────────────────────────────────────────
 * One call to `screenAcceptableUse` and a translation of its verdict into the
 * `ModerationResult` shape the three remaining callers already read. The
 * translation is lossy on purpose -- `isProhibited` is one bit and a verdict
 * is not -- so `decision`, `categoryId` and `notice` are carried alongside it
 * for any caller that wants to say the true thing rather than just stop.
 *
 * New code should call `screenAcceptableUse` directly. This exists so the
 * callers that predate the gate keep working while they are migrated, not as
 * a second door into it.
 */
import { screenAcceptableUse } from '@/lib/policy/gate';
import { intakeSubject } from '@/lib/policy/subject';
import type { PolicyDecision } from '@/lib/policy/acceptable-use';
import type { PolicyLocale, PolicyNotice } from '@/lib/policy/copy';

export interface ModerationResult {
  /**
   * True when the work must stop -- a refusal OR a review.
   *
   * Both, because both mean "do not build this yet", and because that is what
   * the moderator this replaced already did: it set `isProhibited` on
   * `REVIEW_REQUIRED` as well as on `REQUEST_REJECTED`. A caller that needs
   * to tell the two apart reads `decision` below.
   */
  isProhibited?: boolean;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reasons?: string[];
  riskScore?: number;
  categories?: string[];
  recommendation?: 'APPROVED' | 'REVIEW_REQUIRED' | 'REQUEST_REJECTED';
  /** The gate's own verdict, unflattened. */
  decision?: PolicyDecision;
  /** The acceptable-use category id, or the clean id when none applies. */
  categoryId?: string;
  /**
   * What to say, written by `@/lib/policy/copy` in the visitor's language.
   * Null when the verdict allows. A caller that stops on `isProhibited` and
   * then writes its own sentence is reintroducing the problem this file was.
   */
  notice?: PolicyNotice | null;
}

const RISK_LEVEL: Record<PolicyDecision, ModerationResult['riskLevel']> = {
  allow: 'LOW',
  review: 'MEDIUM',
  refuse: 'HIGH',
};

const RECOMMENDATION: Record<
  PolicyDecision,
  ModerationResult['recommendation']
> = {
  allow: 'APPROVED',
  review: 'REVIEW_REQUIRED',
  refuse: 'REQUEST_REJECTED',
};

export async function aiModerateContent(input: {
  description: string;
  industry?: string;
  businessType?: string;
  goals?: string;
  services?: string;
  /** For the notice only. Classification is language-agnostic. */
  locale?: PolicyLocale;
}): Promise<ModerationResult> {
  // `intakeSubject`, not a hand-rolled concatenation: the composed subject is
  // what the classifier's content-hash cache is keyed on, so a brief screened
  // here and screened again by the scope gate or the preview route costs one
  // classification rather than three.
  const screening = await screenAcceptableUse({
    surface: 'preview',
    text: intakeSubject({
      description: input.description,
      industry: input.industry,
      services: input.services,
      goal: input.goals,
    }),
    // The visitor's own words for the operator review email's quote block,
    // never the composed `text` above -- see `ScreenInput.briefText`. No
    // link: this adapter's callers never had one to pass.
    briefText: input.description,
    locale: input.locale,
    actor: 'ai-moderate',
  });

  const { decision, category, confidence, rule } = screening.verdict;
  return {
    isProhibited: screening.blocked,
    riskLevel: RISK_LEVEL[decision],
    // The rule that decided, not a sentence written here. The visitor-facing
    // words are in `notice`; this field is for a log line and an operator.
    reasons: screening.blocked ? [rule] : [],
    riskScore: Math.round(confidence * 100),
    categories: screening.blocked ? [category.id] : [],
    recommendation: RECOMMENDATION[decision],
    decision,
    categoryId: category.id,
    notice: screening.notice,
  };
}
