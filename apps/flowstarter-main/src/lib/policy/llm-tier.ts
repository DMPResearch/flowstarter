import 'server-only';

/**
 * The LLM tier of the acceptable-use gate.
 *
 * One bounded, budgeted, temperature-zero call through `src/lib/ai/llm.ts`,
 * which is the only seam in the app allowed to talk to a model. That wrapper
 * owns the token budget, the `llm_usage` ledger row and the cost estimate, so
 * every policy classification is accounted for by construction rather than by
 * remembering to account for it here.
 *
 * This module returns a {@link PolicyClassification} and never a verdict. It
 * does not know what `refuse` means; `acceptable-use.ts` does.
 */

import { z } from 'zod';

import { callLlmObject } from '@/lib/ai/llm';
import {
  noteClassifierFailure,
  noteClassifierSuccess,
} from '@/lib/ai/classifier-health';

import {
  CATEGORY_IDS,
  CLEAN_CATEGORY_ID,
  categoryById,
  policyLimits,
  type PolicyClassification,
} from './acceptable-use';
import {
  ACCEPTABLE_USE_PROMPT_VERSION,
  ACCEPTABLE_USE_SYSTEM_PROMPT,
  buildAcceptableUsePrompt,
} from './prompt';

/**
 * The structured answer. `category` is a plain string rather than an enum so
 * that a model which invents a label produces a parseable object we can route
 * to review, instead of a schema error we would have to treat as an outage.
 */
const AnswerSchema = z.object({
  category: z.string(),
  confidence: z.number(),
  evidence: z.string(),
  needs_human: z.boolean(),
});

export interface LlmTierResult extends PolicyClassification {
  /** The prompt version that produced this answer. Shown on the board. */
  promptVersion: string;
  /** USD estimate for this call, when the model is in the price table. */
  costEstimateUsd: number | null;
  model: string | null;
}

const MAX_EVIDENCE_CHARS = 200;

function tidyEvidence(raw: string): string {
  const single = raw.replace(/\s+/g, ' ').trim();
  if (single.length <= MAX_EVIDENCE_CHARS) return single;
  return `${single.slice(0, MAX_EVIDENCE_CHARS - 1)}…`;
}

/**
 * A failed tier, as a classification. It carries `failed` so the rule layer
 * applies the fail-closed rule rather than reading a fabricated `none`.
 */
export function unavailableClassification(
  evidence: string,
  failureReason = evidence
): LlmTierResult {
  return {
    categoryId: CLEAN_CATEGORY_ID,
    confidence: 0,
    evidence,
    needsHuman: true,
    tier: 'unavailable',
    failed: true,
    failureReason,
    promptVersion: ACCEPTABLE_USE_PROMPT_VERSION,
    costEstimateUsd: null,
    model: null,
  };
}

export interface ClassifyWithLlmInput {
  /** What is being judged, for the prompt's SURFACE line. */
  surface: string;
  /** Already composed and already capped by the caller. */
  text: string;
  workspaceId?: string | null;
  projectId?: string | null;
  signal?: AbortSignal;
}

/**
 * Classify one piece of text.
 *
 * Never throws. Every failure mode (no key, provider error, budget breach,
 * timeout, unparseable answer) becomes {@link unavailableClassification}, and
 * the rule layer decides what a failure means. That split is deliberate: a
 * throw here would have every one of the six enforcement points writing its
 * own catch, and one of them would eventually get it wrong and allow.
 */
export async function classifyWithLlm(
  input: ClassifyWithLlmInput
): Promise<LlmTierResult> {
  const limits = policyLimits();
  const text = input.text.slice(0, limits.maxInputChars);
  if (!text.trim()) {
    // Nothing to judge is not a clean bill of health, but it is also not an
    // outage. An empty subject means the caller found no text worth reading,
    // which the rule layer turns into a review through `needs_human`.
    return {
      categoryId: CLEAN_CATEGORY_ID,
      confidence: 0,
      evidence: 'The submission carried no text to classify.',
      needsHuman: true,
      tier: 'llm',
      promptVersion: ACCEPTABLE_USE_PROMPT_VERSION,
      costEstimateUsd: null,
      model: null,
    };
  }

  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;

  try {
    const result = await callLlmObject<z.infer<typeof AnswerSchema>>({
      action: 'acceptable_use',
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      schema: AnswerSchema,
      temperature: 0,
      abortSignal: signal,
      messages: [
        { role: 'system', content: ACCEPTABLE_USE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildAcceptableUsePrompt({
            surface: input.surface,
            text,
          }),
        },
      ],
    });

    const answer = result.object;
    const known = categoryById(answer.category);
    return {
      // An id outside the policy's own list is passed through verbatim. The
      // rule layer recognises it as unknown and routes to review; rewriting it
      // to `none` here would launder a model's mistake into an allow.
      categoryId: known ? known.id : String(answer.category ?? '').trim(),
      confidence: answer.confidence,
      evidence: tidyEvidence(answer.evidence ?? ''),
      needsHuman: answer.needs_human === true,
      tier: 'llm',
      promptVersion: ACCEPTABLE_USE_PROMPT_VERSION,
      costEstimateUsd: result.costEstimate,
      model: result.model,
    };
  } catch (error) {
    // The submission itself is never logged. The caller logs the evidence
    // hash; this line says only that the tier could not answer.
    //
    // `signal.reason` first: when this call is the sigma cascade's injected
    // tier, the thing that killed it is usually that cascade's own budget,
    // and `@flowstarter/sigma-core` now aborts with a
    // `TierBudgetExpiredError` naming the head and the budget. A bare
    // "This operation was aborted" -- which is all staging's log line said on
    // 2026-09-15 -- does not tell an operator whose budget expired.
    const cause = signal.reason;
    const reason =
      cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : error instanceof Error
        ? error.message
        : 'unknown error';
    console.warn(
      `[policy] acceptable-use classifier unavailable (surface=${input.surface})`,
      reason
    );
    return unavailableClassification(
      'The classifier could not be reached for this submission.',
      reason
    );
  }
}

/**
 * Which classifier the failure run belongs to. One key per head, so the
 * acceptable-use tier going down does not reset or mask the scope
 * classifier's count (`SCOPE_CLASSIFIER_HEALTH_KEY`), or the other way round.
 */
export const ACCEPTABLE_USE_CLASSIFIER_HEALTH_KEY = 'acceptable_use';

/** A classification really landed. The run of failures, if any, is over. */
export function noteAcceptableUseClassifierSuccess(): void {
  noteClassifierSuccess(ACCEPTABLE_USE_CLASSIFIER_HEALTH_KEY);
}

/**
 * Tell an operator once the failures stop looking like a blip.
 *
 * The same rule, threshold and shape as the scope classifier's alert (#180),
 * for the same reason: this branch fails CLOSED, so an outage is invisible
 * from the outside. Every enforcement point keeps answering, every submission
 * becomes a `review` in production, and the only symptom is an operator queue
 * filling up with ordinary businesses — which reads like traffic, not like a
 * failure. `[policy] acceptable-use classifier unavailable` in a log nobody
 * is tailing is not an alert.
 *
 * Awaited rather than fired and forgotten, unlike the scope head's: the
 * counter has to be incremented before the next classification reads it, and
 * `sendOpsAlert` does not throw. The try/catch is here because the dynamic
 * import itself can fail where Supabase is not configured, and an alert
 * failing is never a reason for a classification to fail differently.
 *
 * ── Why the caller counts, and not this module ───────────────────────────
 * This used to be called from `classifyWithLlm`'s own catch block, which is
 * the wrong altitude for two reasons, both of which cost us on 2026-09-15.
 *
 * First, the count was wrong. `classifyWithLlm` runs BOTH as the cascade's
 * injected tier and as the standalone fallback, so one submission could
 * report two failures, and a failure the cascade had already abandoned still
 * incremented a counter nothing was reading.
 *
 * Second and worse, a run of failures is per SUBMISSION, not per model call.
 * `classifyAcceptableUse` is the only layer that sees whether the submission
 * as a whole ended up classified, and it is the only layer that can see a
 * cascade whose deciding tier died without the model call itself throwing.
 * So the accounting moved up there, where success and failure are one
 * decision instead of two.
 */
export async function noteAcceptableUseClassifierFailure(
  reason: string
): Promise<void> {
  const { consecutiveFailures, shouldAlert } = noteClassifierFailure(
    ACCEPTABLE_USE_CLASSIFIER_HEALTH_KEY
  );
  if (!shouldAlert) return;
  try {
    const { sendOpsAlert } = await import('@/lib/ops/send-ops-alert');
    await sendOpsAlert({
      event: 'acceptable_use_classifier_failed',
      // One run of failures is one thing happening, whatever the submission
      // count: the discriminator names the classifier, not the request.
      discriminator: ACCEPTABLE_USE_CLASSIFIER_HEALTH_KEY,
      title: 'The acceptable-use classifier is not answering',
      detail: {
        consecutiveFailures,
        reason,
        promptVersion: ACCEPTABLE_USE_PROMPT_VERSION,
        effect:
          'Every submission fails closed to review in production, so no visitor reaches a preview and the operator queue fills with businesses nobody needed to read.',
      },
    });
  } catch (error) {
    console.error(
      '[policy] could not raise the classifier outage alert:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }
}

/** The category ids the prompt offers, for the evaluation harness. */
export const CLASSIFIER_CATEGORY_IDS = CATEGORY_IDS;
