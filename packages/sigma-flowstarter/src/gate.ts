/**
 * The gate: one embedding, two heads, two actions.
 *
 * This is the only file a consumer needs to read. Everything above it is
 * generic (@flowstarter/sigma-core) and everything below it is data
 * (models/, config/).
 *
 *     const decision = await classifyAcceptableUse(brief);
 *     if (decision.acceptableUse === 'refuse') ...
 *     if (decision.scope === 'custom') ...
 *
 * Failure behaviour is the interesting part, so state it plainly: there is no
 * path through this module that throws in production and no path that returns
 * `allow` without a confident `clean`. A missing model, a blown budget, a
 * corrupt centroid file and a text in a language nobody trained all land on
 * `review` / `unclear`, which is a human looking at it — the outcome we are
 * happy to have a hundred times a day and unhappy to have never.
 */

import {
  classify as coreClassify,
  decide as coreDecide,
  CentroidScorer,
  getEncoder,
  loadEncoderConfig,
  type DecisionMapping,
  type DecisionThresholds,
  type DecisionTrace,
  type Encoder,
  type Tier,
} from '@flowstarter/sigma-core';
import {
  ACCEPTABLE_USE_HEAD,
  SCOPE_HEAD,
  categoryClass,
  type AcceptableUseAction,
  type AcceptableUseCategory,
  type ScopeAction,
  type ScopeCategory,
} from './taxonomy.js';
import { loadCentroids, loadPolicy, loadSemanticConfig, type PolicyConfig } from './config.js';

/** What the product is allowed to branch on. */
export interface Decision {
  acceptableUse: AcceptableUseAction;
  scope: ScopeAction;
  /** The acceptable-use category behind the action, or null when nothing decided. */
  category: AcceptableUseCategory | null;
  /** The scope category behind the action, or null when nothing decided. */
  scopeCategory: ScopeCategory | null;
  /** Machine-readable why, safe to log: never contains the user's text. */
  reasons: { acceptableUse: string; scope: string };
  trace: DecisionTrace;
}

export interface GateOptions {
  /**
   * Optional second tier per head, consulted ONLY where the centroid tier
   * abstained. This package never imports the app's llm.ts: pass a function
   * or get a purely local classifier.
   */
  tiers?: { acceptable_use?: Tier; scope?: Tier };
  /** Override the shared encoder (tests, or a second cache). */
  encoder?: Encoder;
  /** Override the per-call embedding budget from config/encoder.json. */
  budgetMs?: number;
  /** Budget for one injected tier call. */
  tierBudgetMs?: number;
  /** Override the policy thresholds. Normally: don't. */
  policy?: PolicyConfig;
}

let scorer: CentroidScorer | undefined;

/** The process-wide scorer over the committed centroids and calibrated band. */
export function getScorer(): CentroidScorer {
  scorer ??= new CentroidScorer(loadCentroids(), loadSemanticConfig());
  return scorer;
}

/** Tests only. */
export function resetScorer(): void {
  scorer = undefined;
}

/**
 * A known-good sentence, classified once at warm-up so a broken pipeline —
 * a model/centroid mismatch, a stale `SIGMA_CORE_ROOT`/`SIGMA_FLOWSTARTER_ROOT`,
 * a runtime that loads but scores nonsense, or a cold-start race that lets
 * traffic in before the encoder has actually finished loading — fails loudly
 * at startup, the same way a missing model cache already does. Without this,
 * "the pipeline loaded" and "the pipeline classifies correctly" are two
 * different facts and only the first one was ever checked: staging 2026-09-15
 * shipped a byte-identical model and centroid set, warmed without error, and
 * still abstained on almost every real request, because nothing ever asked it
 * to prove it could tell a bakery from nothing at all.
 *
 * Deliberately its own sentence, not borrowed from `src/training/phrases.ts`
 * or `test/data/*.json`: those move when the taxonomy or the eval set does,
 * and this must keep meaning "the pipeline is broken" rather than also
 * meaning "somebody edited a fixture". Verified against the committed
 * centroids at margin ~0.19 (acceptable_use) and ~0.13 (scope) — comfortably
 * clear of both calibrated bands, so ordinary platform noise
 * (`platform_noise_allowance` in `models/semantic-config.json`) cannot flip it.
 */
export const READINESS_FIXTURE: {
  text: string;
  acceptableUse: AcceptableUseCategory;
  scope: ScopeCategory;
} = {
  text: 'We run a small neighbourhood bakery and want a simple website with our menu, hours and location.',
  acceptableUse: 'clean',
  scope: 'standard-site',
};

/** Thrown by {@link warmSigma} when the readiness fixture does not classify as expected. */
export class SigmaNotReadyError extends Error {
  constructor(detail: string) {
    super(`sigma readiness check failed: ${detail}`);
    this.name = 'SigmaNotReadyError';
  }
}

/**
 * Pure half of the readiness check, tested without a model: does this trace
 * for {@link READINESS_FIXTURE} land where it must?
 *
 * Requires a CONFIDENT, semantic-tier match on both heads — an injected tier
 * is never consulted here (see `warmSigma`, which classifies with no tiers
 * supplied), so this can only pass if the centroid tier itself is working.
 */
export function checkReadiness(trace: DecisionTrace): void {
  const acceptableUse = trace.heads[ACCEPTABLE_USE_HEAD];
  const scope = trace.heads[SCOPE_HEAD];
  const ok =
    !!acceptableUse &&
    !acceptableUse.semanticAbstained &&
    acceptableUse.label === READINESS_FIXTURE.acceptableUse &&
    !!scope &&
    !scope.semanticAbstained &&
    scope.label === READINESS_FIXTURE.scope;
  if (ok) return;
  throw new SigmaNotReadyError(
    `expected acceptable_use=${READINESS_FIXTURE.acceptableUse} scope=${READINESS_FIXTURE.scope}, ` +
      `got acceptable_use=${JSON.stringify(acceptableUse?.label ?? null)} ` +
      `(abstained=${acceptableUse?.semanticAbstained ?? true}) ` +
      `scope=${JSON.stringify(scope?.label ?? null)} (abstained=${scope?.semanticAbstained ?? true})`,
  );
}

/**
 * Pay the cold ONNX session cost before traffic, then prove the whole
 * pipeline actually works by classifying {@link READINESS_FIXTURE}. Throws
 * when the model cache is missing OR when the fixture does not classify
 * confidently and correctly, on purpose: a process that could only ever fail
 * open should fail at startup rather than send every brief to a human (or,
 * worse, quietly abstain on almost all of them with nothing in the trace to
 * say why).
 */
export async function warmSigma(): Promise<void> {
  getScorer();
  await getEncoder().warm();
  const trace = await classifyRequest(READINESS_FIXTURE.text);
  checkReadiness(trace);
}

/** Both heads, one embedding, full trace. Never throws for a classification reason. */
export async function classifyRequest(
  text: string,
  options: GateOptions = {},
): Promise<DecisionTrace> {
  const encoderConfig = loadEncoderConfig();
  return coreClassify(text, {
    encoder: options.encoder ?? getEncoder(),
    scorer: getScorer(),
    centroids: loadCentroids(),
    config: loadSemanticConfig(),
    encoderConfig,
    decisions: [ACCEPTABLE_USE_HEAD, SCOPE_HEAD],
    ...(options.tiers ? { tiers: options.tiers as Record<string, Tier> } : {}),
    ...(options.tierBudgetMs !== undefined ? { tierBudgetMs: options.tierBudgetMs } : {}),
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  });
}

/* ── the rules half ───────────────────────────────────────────────────── */

/**
 * Category class decides the action, and nothing else does. `prohibited` is
 * the only route to a refusal, `clean` the only route to an allow, and
 * everything sensitive goes to a person because a licence — not a sentence —
 * is what makes it lawful.
 */
export const ACCEPTABLE_USE_MAPPING: DecisionMapping<
  AcceptableUseCategory,
  AcceptableUseAction
> = {
  decision: ACCEPTABLE_USE_HEAD,
  action: (label) => {
    switch (categoryClass(label)) {
      case 'prohibited':
        return 'refuse';
      case 'clean':
        return 'allow';
      default:
        return 'review';
    }
  },
  fallback: 'review',
};

export const SCOPE_MAPPING: DecisionMapping<ScopeCategory, ScopeAction> = {
  decision: SCOPE_HEAD,
  action: (label) =>
    label === 'custom-work' ? 'custom' : label === 'standard-site' ? 'standard' : 'unclear',
  fallback: 'unclear',
};

export function acceptableUseThresholds(
  policy: PolicyConfig,
): DecisionThresholds<AcceptableUseAction> {
  return {
    guards: {
      refuse: {
        minSimilarity: policy.acceptableUse.refuseMinSimilarity,
        minMargin: policy.acceptableUse.refuseMinMargin,
        minTierConfidence: policy.acceptableUse.refuseMinLlmConfidence,
      },
      allow: {
        minSimilarity: policy.acceptableUse.allowMinSimilarity,
        minMargin: policy.acceptableUse.allowMinMargin,
        // An injected model may never hand out an allow on its own: the
        // semantic tier abstaining is exactly the case where we want a human,
        // and a model that says "clean, 0.9" is not evidence of a licence.
        semanticOnly: true,
      },
    },
    failClosedInProduction: policy.failClosedInProduction,
  };
}

export function scopeThresholds(policy: PolicyConfig): DecisionThresholds<ScopeAction> {
  return {
    guards: {
      custom: {
        minSimilarity: policy.scope.customMinSimilarity,
        minMargin: policy.scope.customMinMargin,
        minTierConfidence: policy.scope.customMinLlmConfidence,
      },
      standard: {
        minSimilarity: policy.scope.standardMinSimilarity,
        minMargin: policy.scope.standardMinMargin,
      },
    },
    failClosedInProduction: policy.failClosedInProduction,
  };
}

/** The deterministic boundary. Pure: same trace in, same decision out. */
export function decide(trace: DecisionTrace, policy: PolicyConfig = loadPolicy()): Decision {
  const acceptableUse = coreDecide<AcceptableUseCategory, AcceptableUseAction>(
    trace,
    acceptableUseThresholds(policy),
    ACCEPTABLE_USE_MAPPING,
  );
  const scope = coreDecide<ScopeCategory, ScopeAction>(
    trace,
    scopeThresholds(policy),
    SCOPE_MAPPING,
  );
  return {
    acceptableUse: acceptableUse.action,
    scope: scope.action,
    category: acceptableUse.label,
    scopeCategory: scope.label,
    reasons: {
      acceptableUse: `${acceptableUse.reason}:${acceptableUse.detail}`,
      scope: `${scope.reason}:${scope.detail}`,
    },
    trace,
  };
}

/* ── the two adapters ─────────────────────────────────────────────────── */

/**
 * The acceptable-use gate's entry point.
 *
 * Returns the whole Decision rather than one field, because both heads come
 * out of the same embedding and throwing half of it away would only make the
 * caller run the encoder twice. A caller that wants one field reads one field.
 */
export async function classifyAcceptableUse(
  text: string,
  options: GateOptions = {},
): Promise<Decision> {
  return decide(await classifyRequest(text, options), options.policy ?? loadPolicy());
}

/** The self-serve / studio routing entry point. Same trace, same Decision. */
export async function classifyScope(
  text: string,
  options: GateOptions = {},
): Promise<Decision> {
  return decide(await classifyRequest(text, options), options.policy ?? loadPolicy());
}
