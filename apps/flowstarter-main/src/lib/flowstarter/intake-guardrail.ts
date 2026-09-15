import 'server-only';

/**
 * The acceptable-use gate, at the moment the visitor says what they do.
 *
 * ── What this replaces ────────────────────────────────────────────────────
 * The intake had a guardrail of its own: `aiModerateContent`, a list of
 * thirteen regular expressions (`/onlyfans?/i`, `/cam(girl|boy)?/i`,
 * `/escort/i`, ...) followed by a second LLM prompt carrying a second,
 * differently-worded taxonomy. It ran inside
 * `POST /api/discovery/intake-graph`, before and independently of the real
 * gate, and on a hit it ended the turn quietly -- `status: 'complete'`,
 * `ask: null`, `reason: 'error'`, and the visitor's answer discarded. On
 * 2026-09-15 the showcase recorder filmed the result twice: a prohibited
 * brief typed into the browser produced no refusal, no review, no notice and
 * no `/api/discovery/scope` call at all. The pane still read "You do: Not
 * yet" and the wizard sat at "2 of 5 questions answered" forever. The same
 * two briefs POSTed straight to the scope route were refused correctly, in
 * the right category, at the LLM tier.
 *
 * Two guardrails is the defect. One of them detected with string matching,
 * which the owner's rule rejects outright -- "the guardrails should be
 * implemented by a system prompt or inside the classifier instead of friable
 * regexes" -- and the one that worked was never reached. So the intake now
 * asks the same question the scope gate asks, of the same classifier, and
 * reads the answer through the same narrowing.
 *
 * ── Rules decide, models phrase ───────────────────────────────────────────
 * Nothing in this module decides anything. `screenAcceptableUse` owns the
 * classification, the thresholds, the audit row and the notice;
 * `acceptableUseFrom` owns the narrowing; `decideRoute` owns what each verdict
 * means for the funnel. `intakeStopFor` below does not restate that table, it
 * ASKS it -- which is the only way two surfaces stay in agreement without a
 * person remembering to change both.
 */
import { screenAcceptableUse } from '@/lib/policy/gate';
import { intakeLink, intakeSubject } from '@/lib/policy/subject';
import type { PolicyLocale, PolicyNotice } from '@/lib/policy/copy';
import { acceptableUseFrom } from './acceptable-use-verdict';
import { decideRoute, type AcceptableUse } from './scope-route';

/**
 * The two verdicts that end an intake, named with the scope gate's own words
 * so the browser can render one screen for both surfaces.
 */
export type IntakeGuardrailStop = 'refused' | 'hold';

export interface IntakeGuardrailInput {
  /** What the visitor said their business does. Empty means nothing to screen. */
  description: string;
  websiteUrl?: string;
  instagramUrl?: string;
  linkedinUrl?: string;
  /** The visitor's language, for the notice only. Classification is blind to it. */
  locale?: PolicyLocale;
}

export interface IntakeGuardrailResult {
  /** `null` when the conversation carries on. */
  stop: IntakeGuardrailStop | null;
  /** The notice `@/lib/policy/copy` wrote, on a stop. Never written here. */
  notice: PolicyNotice | null;
}

/**
 * What the funnel's routing rule does with this verdict, asked rather than
 * restated.
 *
 * `decideRoute` is pure and its acceptable-use branches run before it looks
 * at the scope half at all, so handing it a settled standard verdict
 * (`decided: true`) isolates exactly the half this module cares about: every
 * answer other than `refused`/`hold` comes back `self-serve`, which is the
 * gate having no opinion left. The alternative -- a `switch` over the five
 * `AcceptableUse` values written out again here -- is a second decision table,
 * and a second decision table is how `review` came to mean three things.
 *
 * So the mapping is, and can only be, the scope gate's:
 *
 *   blocked    -> `refused`  the intake ends, the refusal notice is shown
 *   hold       -> `hold`     the intake ends, the hold notice is shown
 *   review     -> continue   a tier named a category; an operator reads the
 *                            row `screenAcceptableUse` already opened, and the
 *                            visitor carries on
 *   unsettled  -> continue   the classifier named no category, so it has said
 *                            nothing about this business
 *   allowed    -> continue
 */
export function intakeStopFor(
  acceptableUse: AcceptableUse
): IntakeGuardrailStop | null {
  const { route } = decideRoute({
    scope: 'standard',
    confidence: 1,
    decided: true,
    acceptableUse,
  });
  return route === 'refused' || route === 'hold' ? route : null;
}

/**
 * Screen the description the visitor just gave, and say whether the intake
 * may carry on.
 *
 * Never throws: `screenAcceptableUse` does not, by contract, and an
 * enforcement point that needed a try/catch around it would eventually be the
 * one that forgot. An empty description is not screened -- there is nothing to
 * read, and classifying the empty string would file a row about nobody.
 *
 * The subject is composed by `intakeSubject`, the same helper `runScopeGate`
 * and `/api/discovery/preview/live` use, so the classifier's content-hash
 * cache is shared across the three and the scope gate's screen a moment later
 * is free when the brief has not changed.
 */
export async function screenIntakeDescription(
  input: IntakeGuardrailInput
): Promise<IntakeGuardrailResult> {
  if (!input.description.trim()) return { stop: null, notice: null };

  const link = intakeLink(input);
  const screening = await screenAcceptableUse({
    surface: 'preview',
    text: intakeSubject({
      description: input.description,
      websiteUrl: input.websiteUrl,
      instagramUrl: input.instagramUrl,
      linkedinUrl: input.linkedinUrl,
    }),
    // The visitor's own words for the operator review email's quote block,
    // never the composed `text` above -- see `ScreenInput.briefText`.
    briefText: input.description,
    linkUrl: link?.url,
    linkLabel: link?.label,
    locale: input.locale,
    actor: 'intake-graph',
  });

  const stop = intakeStopFor(acceptableUseFrom(screening.verdict));
  // The notice only travels with a stop. A `review` that a tier categorised
  // carries on, and handing the visitor a "one of us needs to look at this"
  // card while the conversation continues underneath it would be two
  // contradictory statements on one screen.
  return { stop, notice: stop ? screening.notice ?? null : null };
}
