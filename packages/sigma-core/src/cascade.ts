/**
 * The budgeted, fail-open cascade.
 *
 *   one embedding  ->  centroid tier per head  ->  injected tier where that
 *   head abstained  ->  nothing (the policy boundary supplies the default)
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
   * Per-decision second tier, consulted ONLY where the centroid tier
   * abstained. Omit a decision to leave it purely local.
   */
  tiers?: Record<string, Tier>;
  /** Budget for one injected tier call. Over it, the head stays abstained. */
  tierBudgetMs?: number;
  /** Override the encoder budget for this call. */
  budgetMs?: number;
}

const DEFAULT_TIER_BUDGET_MS = 3_000;

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
        evidence: null,
        timings: { semanticMs, injectedMs: 0 },
      };
    } catch (error) {
      errors.push(`semantic:${decision}:${describe(error)}`);
      heads[decision] = blankHead(decision, missingSemantic('artifacts_missing'), semanticMs);
    }
  }

  // Only where the local tier abstained. A confident centroid verdict is
  // never second-guessed by a model: that is what makes the cost bounded.
  const tiers = options.tiers ?? {};
  const abstained = decisions.filter(
    (decision) => (heads[decision] as HeadTrace).semanticAbstained && tiers[decision],
  );
  if (abstained.length > 0) {
    const tierBudget = options.tierBudgetMs ?? DEFAULT_TIER_BUDGET_MS;
    await Promise.all(
      abstained.map(async (decision) => {
        const head = heads[decision] as HeadTrace;
        head.injectedAttempted = true;
        const tierStarted = performance.now();
        const verdict = await runTier(
          tiers[decision] as Tier,
          text,
          decision,
          tierBudget,
          errors,
        );
        head.timings.injectedMs = performance.now() - tierStarted;
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

async function runTier(
  tier: Tier,
  text: string,
  decision: string,
  budgetMs: number,
  errors: string[],
): Promise<TierVerdict | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolvePromise) => {
      timer = setTimeout(() => {
        controller.abort();
        resolvePromise(null);
      }, Math.max(1, budgetMs));
    });
    const work = tier(text, decision, controller.signal);
    work.catch(() => undefined);
    const verdict = await Promise.race([work, timeout]);
    if (verdict === null) return null;
    if (
      typeof verdict.label !== 'string' ||
      typeof verdict.confidence !== 'number' ||
      !Number.isFinite(verdict.confidence)
    ) {
      errors.push(`tier:${decision}:malformed_verdict`);
      return null;
    }
    return {
      label: verdict.label,
      confidence: Math.min(1, Math.max(0, verdict.confidence)),
      evidence: typeof verdict.evidence === 'string' ? verdict.evidence : '',
    };
  } catch (error) {
    errors.push(`tier:${decision}:${describe(error)}`);
    return null;
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
