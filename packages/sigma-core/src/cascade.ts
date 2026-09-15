/**
 * The budgeted, fail-open cascade.
 *
 *   one embedding  ->  centroid tier per head  ->  injected tier where that
 *   head did not settle it  ->  nothing (the policy boundary supplies the
 *   default)
 *
 * Three rules, taken from Ereno sigma and kept:
 *
 *   1. **No tier may break the request.** Every tier runs inside a budget and
 *      a try/catch; a failure falls through to the next one and is recorded
 *      in the trace as a string. The core has no opinion about what "safe"
 *      means — it never invents a label — so the last thing in the chain is
 *      an abstention, and `decide()` turns that into the platform's default.
 *   2. **The expensive part runs once.** Every head is scored from the same
 *      embedding. Adding a head costs a few hundred multiply-adds.
 *   3. **The second tier is an argument.** The core never imports an LLM
 *      client. A consumer that passes nothing gets a pure-local classifier
 *      that still works offline.
 */

import type { CentroidScorer } from './semantic.js';
import { embedWithinBudget, type Encoder } from './encoder.js';
import type { CentroidsFile, EncoderConfig, SemanticConfigFile } from './artifacts.js';
import type {
  DecisionTrace,
  HeadTrace,
  SemanticResult,
  Tier,
  TierOutcome,
  TierVerdict,
} from './types.js';

export interface ClassifyOptions {
  encoder: Encoder;
  scorer: CentroidScorer;
  centroids: Pick<CentroidsFile, 'version'>;
  config: Pick<SemanticConfigFile, 'version' | 'encoder'>;
  encoderConfig: Pick<EncoderConfig, 'model' | 'revision' | 'budgetMs'>;
  /** Which heads to score. Defaults to every decision the scorer knows. */
  decisions?: string[];
  /**
   * Per-decision second tier, consulted where the centroid tier did not
   * settle the decision. Omit a decision to leave it purely local.
   */
  tiers?: Record<string, Tier>;
  /**
   * Per-decision: "does this centroid verdict settle the decision?"
   *
   * Defaults to "yes, unless the band abstained", which is the cheapest
   * possible reading and was the only one available until 2026-09-15. It is
   * not the whole truth: a platform's policy boundary can have a HIGHER bar
   * for a particular action than the band has for answering at all, and a
   * verdict that clears the band and then fails that bar is an answer nobody
   * may act on. Before this hook existed the cascade had already returned by
   * the time anything discovered that, so the injected tier — the one thing
   * that could have produced an actionable answer — was never asked, and the
   * unactionable verdict was recorded as if it were a decision.
   *
   * The core still learns nothing about labels or actions: the caller passes
   * a predicate over its own `SemanticResult`. See `semanticSettles` in
   * policy.ts, which is what a caller with a `DecisionMapping` should hand in.
   */
  settles?: Record<string, (semantic: SemanticResult) => boolean>;
  /** Budget for one injected tier call. Over it, the head stays abstained. */
  tierBudgetMs?: number;
  /** Override the encoder budget for this call. */
  budgetMs?: number;
}

/**
 * The budget for one injected tier call, when the caller does not say.
 *
 * Sized for a LOCAL tier — a rules pass, a lookup, a second scorer — and for
 * nothing else. **A tier that opens a socket must pass its own
 * `tierBudgetMs`**, because three seconds is not a network budget: it is
 * roughly one round trip plus a small model's own generation time, with
 * nothing left for a slow moment at the provider.
 *
 * This default is the reason the drugs brief reached `self-serve` on staging
 * on 2026-09-15. The consumer injected a paid `openai/gpt-4o-mini` call and
 * never overrode the budget, so the app's own 15 s classifier timeout
 * (`ACCEPTABLE_USE_TIMEOUT_MS`) was silently replaced by this 3 s one the
 * moment the embedding tier was switched on — a 5x cut nothing in either
 * file's diff showed. Measured against OpenRouter with the real prompt, that
 * call runs 0.7 s to 2.2 s of model time BEFORE the consumer's own usage
 * ledger round trips, so the budget bit on the slow briefs and held on the
 * fast ones. See `ACCEPTABLE_USE_LLM_TIER_BUDGET_MS` in the app's
 * `policy/acceptable-use.ts` for the number a real model call is given.
 *
 * Exported so a consumer can see what it is inheriting rather than discover
 * it from a trace.
 */
export const DEFAULT_TIER_BUDGET_MS = 3_000;

/**
 * Why an `AbortSignal` from this cascade fired.
 *
 * `controller.abort()` with no argument gives the tier an `AbortError` that
 * says nothing about who aborted it or why, so a tier's own catch block
 * cannot tell "the cascade's budget expired" from "the caller cancelled the
 * request" from "the provider hung up". Aborting with a cause makes the
 * reason readable at `signal.reason` inside the tier, which is where the code
 * that has to log it actually runs.
 */
export class TierBudgetExpiredError extends Error {
  readonly decision: string;
  readonly budgetMs: number;
  constructor(decision: string, budgetMs: number) {
    super(`tier for "${decision}" exceeded its ${budgetMs}ms budget`);
    this.name = 'TierBudgetExpiredError';
    this.decision = decision;
    this.budgetMs = budgetMs;
  }
}

/** What `runTier` hands back: the verdict, and always what happened. */
interface TierRun {
  verdict: TierVerdict | null;
  outcome: TierOutcome;
}

function missingSemantic(reason: SemanticResult['reason']): SemanticResult {
  return {
    label: null,
    runnerUp: null,
    similarity: 0,
    margin: 0,
    abstained: true,
    reason,
  };
}

function blankHead(decision: string, semantic: SemanticResult, semanticMs: number): HeadTrace {
  return {
    decision,
    tier: 'default',
    label: null,
    confidence: 0,
    semantic,
    semanticAbstained: true,
    injectedAttempted: false,
    injectedAbstained: false,
    injectedOutcome: null,
    evidence: null,
    timings: { semanticMs, injectedMs: 0 },
  };
}

/** One text, every head, one trace. Never throws for a classification reason. */
export async function classify(
  text: string,
  options: ClassifyOptions,
): Promise<DecisionTrace> {
  const started = performance.now();
  const decisions = options.decisions ?? options.scorer.decisionNames;
  const errors: string[] = [];
  const heads: Record<string, HeadTrace> = {};

  const budgetMs = options.budgetMs ?? options.encoderConfig.budgetMs;
  const embedded = await embedWithinBudget(options.encoder, text, budgetMs);
  if (embedded.error) errors.push(`encoder:${embedded.error}`);

  const semanticMs = embedded.ms;
  for (const decision of decisions) {
    if (!embedded.vector) {
      heads[decision] = blankHead(
        decision,
        missingSemantic(
          embedded.error === 'encoder_timeout' ? 'encoder_timeout' : 'encoder_error',
        ),
        semanticMs,
      );
      continue;
    }
    try {
      const semantic = options.scorer.score(decision, embedded.vector);
      heads[decision] = {
        decision,
        tier: semantic.abstained ? 'default' : 'semantic',
        label: semantic.abstained ? null : semantic.label,
        confidence: semantic.abstained ? 0 : semantic.margin,
        semantic,
        semanticAbstained: semantic.abstained,
        injectedAttempted: false,
        injectedAbstained: false,
        injectedOutcome: null,
        evidence: null,
        timings: { semanticMs, injectedMs: 0 },
      };
    } catch (error) {
      errors.push(`semantic:${decision}:${describe(error)}`);
      heads[decision] = blankHead(decision, missingSemantic('artifacts_missing'), semanticMs);
    }
  }

  // Only where the local tier did not settle it: it abstained, or the caller
  // says its verdict is not strong enough to act on. A SETTLED centroid
  // verdict is never second-guessed by a model, which is what makes the cost
  // bounded; an unsettled one is exactly what the second tier is for.
  const tiers = options.tiers ?? {};
  const settles = options.settles ?? {};
  const unsettled = decisions.filter((decision) => {
    if (!tiers[decision]) return false;
    const head = heads[decision] as HeadTrace;
    const settled = settles[decision];
    return settled ? !settled(head.semantic) : head.semanticAbstained;
  });
  if (unsettled.length > 0) {
    const tierBudget = options.tierBudgetMs ?? DEFAULT_TIER_BUDGET_MS;
    await Promise.all(
      unsettled.map(async (decision) => {
        const head = heads[decision] as HeadTrace;
        head.injectedAttempted = true;
        const tierStarted = performance.now();
        const { verdict, outcome } = await runTier(
          tiers[decision] as Tier,
          text,
          decision,
          tierBudget,
          errors,
        );
        head.timings.injectedMs = performance.now() - tierStarted;
        head.injectedOutcome = outcome;
        if (!verdict) {
          head.injectedAbstained = true;
          return;
        }
        head.tier = 'injected';
        head.label = verdict.label;
        head.confidence = verdict.confidence;
        head.evidence = verdict.evidence;
      }),
    );
  }

  return {
    heads,
    totalMs: performance.now() - started,
    embedMs: embedded.ms,
    embedCacheHit: embedded.cacheHit,
    errors,
    encoder: {
      model: options.encoderConfig.model,
      revision: options.encoderConfig.revision,
    },
    centroidsVersion: options.centroids.version,
    configVersion: options.config.version ?? 'unversioned',
  };
}

/**
 * Run one injected tier inside its budget, and always say what happened.
 *
 * Three things here are load-bearing, and all three were missing until
 * 2026-09-15:
 *
 *   1. **The abort carries a cause.** `controller.abort(new
 *      TierBudgetExpiredError(...))` rather than `controller.abort()`, so the
 *      tier's own catch block can read `signal.reason` and log why its call
 *      died instead of reporting a bare `AbortError`.
 *   2. **A timeout is recorded in `errors`.** It used to resolve `null` and
 *      push nothing, which made a blown budget byte-for-byte identical to a
 *      consumer that had supplied no tier at all. A trace that cannot tell
 *      those apart cannot be the basis of a safety decision, and a caller
 *      reading it had no way to know its only intent-reading tier was down.
 *   3. **The outcome comes back with the verdict.** `errors` is a flat list
 *      for the whole cascade; a caller that needs to know whether THE HEAD IT
 *      IS ABOUT TO ACT ON failed should not have to parse strings out of it.
 */
async function runTier(
  tier: Tier,
  text: string,
  decision: string,
  budgetMs: number,
  errors: string[],
): Promise<TierRun> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    const timeout = new Promise<null>((resolvePromise) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort(new TierBudgetExpiredError(decision, budgetMs));
        resolvePromise(null);
      }, Math.max(1, budgetMs));
    });
    const work = tier(text, decision, controller.signal);
    // The loser of the race is still a live promise; swallowing its rejection
    // here keeps a slow tier that eventually throws from becoming an
    // unhandled rejection that kills the process.
    work.catch(() => undefined);
    const verdict = await Promise.race([work, timeout]);
    if (verdict === null) {
      // The two ways to arrive here are NOT the same fact, and conflating
      // them is the bug this function was rewritten to fix.
      if (expired) {
        errors.push(`tier:${decision}:timeout:${budgetMs}ms`);
        return { verdict: null, outcome: 'timeout' };
      }
      return { verdict: null, outcome: 'abstained' };
    }
    if (
      typeof verdict.label !== 'string' ||
      typeof verdict.confidence !== 'number' ||
      !Number.isFinite(verdict.confidence)
    ) {
      errors.push(`tier:${decision}:malformed_verdict`);
      return { verdict: null, outcome: 'malformed' };
    }
    return {
      verdict: {
        label: verdict.label,
        confidence: Math.min(1, Math.max(0, verdict.confidence)),
        evidence: typeof verdict.evidence === 'string' ? verdict.evidence : '',
      },
      outcome: 'verdict',
    };
  } catch (error) {
    errors.push(`tier:${decision}:${describe(error)}`);
    return { verdict: null, outcome: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  // Names and codes only: a trace is a log line, and a user's text must not
  // travel inside an error message into one.
  if (error instanceof Error) return error.name;
  return 'error';
}
