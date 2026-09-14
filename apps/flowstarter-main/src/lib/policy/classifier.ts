import 'server-only';

/**
 * THE ADAPTER. One door between the enforcement points and whatever classifies.
 *
 * Every gate in the app calls `classifyAcceptableUse(text, ...)` and nothing
 * else. What sits behind this function is free to change without touching a
 * single route:
 *
 * Behind it, a two-tier cascade:
 *
 *   FIRST   `@flowstarter/sigma-flowstarter` (#160), modelled on the Ereno
 *           sigma design: local multilingual embedding centroids with a
 *           calibrated abstention band. No network, no tokens, and it settles
 *           the common case on its own.
 *
 *   THEN    our bounded LLM classification (`./llm-tier.ts`), driven by the
 *           versioned prompt in `./prompt.ts`, INJECTED into the package as
 *           its second tier and therefore consulted only where the embeddings
 *           abstained. That is where the euphemisms and the obfuscations land,
 *           and it is the only place a model is paid for.
 *
 *   ALWAYS  the LLM tier alone, if the package cannot load. The encoder is a
 *           135 MB fetched artefact rather than a committed one, so an
 *           environment without it degrades to the classifier that ran before
 *           the package existed instead of failing every gate.
 *
 * Enforcement points, the rule layer, the prompt and the fixtures did not
 * change when the package landed. That was the point of the seam.
 *
 * Two things this module owns that neither tier should:
 *
 *   - THE CACHE, keyed by content hash. A client who saves the same brief four
 *     times is classified once. The hash is also the only identifier that ever
 *     reaches a log line, so an operator can correlate a refusal with a
 *     submission without the submission being written down.
 *   - THE PER-SUBMISSION CAP. A bounded number of paid calls per submission,
 *     so a retry loop cannot turn into a bill.
 */

import { createHash } from 'node:crypto';

import {
  CLEAN_CATEGORY_ID,
  policyLimits,
  type PolicyClassification,
} from './acceptable-use';
import { classifyWithLlm, unavailableClassification } from './llm-tier';

export interface AcceptableUseClassification extends PolicyClassification {
  /**
   * SHA-256 of the exact text that was classified, truncated for readability.
   * This is what goes in logs and on the timeline. The text never does.
   */
  evidenceHash: string;
  promptVersion: string;
  costEstimateUsd: number | null;
  model: string | null;
  /** True when this answer came from the cache and cost nothing. */
  cached: boolean;
}

const HASH_CHARS = 16;

/**
 * The identifier for a piece of text under the policy.
 *
 * Truncated to 16 hex characters: long enough that two different submissions
 * colliding in one operator's queue is not a thing that happens, short enough
 * to read in a log line, and short enough that the hash cannot be used to
 * confirm a guessed submission the way a full digest could.
 */
export function evidenceHashOf(text: string): string {
  return createHash('sha256')
    .update(text, 'utf8')
    .digest('hex')
    .slice(0, HASH_CHARS);
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** When the stored verdict was produced. Governs reuse. */
  at: number;
  /** When this content hash was first classified. Governs the spend cap. */
  firstAt: number;
  value: AcceptableUseClassification;
  /** Paid calls already spent on this content hash. */
  calls: number;
}

/**
 * In-process, per-content-hash. Deliberately not Redis and not a table: the
 * cost of a miss is one small model call, the win is that a save button held
 * down does not re-bill, and a shared cache would be a new failure mode in
 * front of a safety gate.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Drop entries nobody is spending against any more.
 *
 * Pruned on the SPEND window, not the cache TTL. An entry past its TTL is
 * stale as an answer and still meaningful as a receipt: it is what stops a
 * caller waiting out the TTL and starting the bill over. Dropping it early
 * would make `maxCallsPerSubmission` cap nothing at all.
 */
function prune(
  now: number,
  limits: { spendWindowMs: number; cacheMaxEntries: number }
): void {
  // `forEach` rather than `for..of`: the app's tsconfig targets ES5 without
  // downlevelIteration, so iterating a Map directly does not compile.
  const stale: string[] = [];
  cache.forEach((entry, key) => {
    if (now - entry.firstAt > limits.spendWindowMs) stale.push(key);
  });
  stale.forEach((key) => cache.delete(key));

  while (cache.size > limits.cacheMaxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Test seam. Also called by the operator board after a manual decision. */
export function clearAcceptableUseCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// The sigma seam
// ---------------------------------------------------------------------------

/**
 * The app's category ids, in the package's label space.
 *
 * The two lists say the same thing and spell six of the fifteen differently.
 * Neither side gets renamed: our ids are already on `policy_reviews` rows and
 * in `project_events` payloads, so renaming one is a migration (the policy
 * module says so), and the package's are its trained centroid keys. The
 * translation lives here, which is the one place that knows both.
 */
const SIGMA_TO_APP: Readonly<Record<string, string>> = {
  illegal_drugs: 'illegal_drugs',
  prostitution_escort: 'sexual_services',
  adult_content: 'adult_content',
  weapons_ammunition: 'weapons_sales',
  unlicensed_gambling: 'unlicensed_gambling',
  counterfeit_goods: 'counterfeit_goods',
  hate_harassment: 'hate_or_harassment',
  scams_impersonation: 'scams_impersonation',
  unlicensed_medical_financial_claims: 'unlicensed_claims',
  licensed_pharmacy: 'licensed_pharmacy',
  legal_cannabis: 'legal_cannabis',
  firearms_training: 'firearms_training',
  sexual_health: 'sexual_health_clinic',
  licensed_betting: 'licensed_betting',
  adult_adjacent_retail: 'adult_adjacent_lawful',
  clean: CLEAN_CATEGORY_ID,
};

const APP_TO_SIGMA: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SIGMA_TO_APP).map(([sigma, app]) => [app, sigma])
);

/**
 * Whether the embedding tier runs.
 *
 * OFF unless `ACCEPTABLE_USE_SIGMA=true`. The package is a real dependency
 * again as of #167, which made `sigma-core` and `sigma-flowstarter` ship built
 * JS and declarations with proper exports and the native binding declared;
 * that removed every packaging reason this app had for keeping it at arm's
 * length (the Next build could not trace raw TypeScript with ESM `.js`
 * specifiers, and `tsc` needed `downlevelIteration` bolted onto the whole app
 * to compile a training file no consumer calls).
 *
 * What remains is deployment, and it is one thing: the encoder is a 135 MB
 * artefact that is fetched rather than committed, and the slot image does not
 * carry it yet. So the switch defaults off and is flipped per environment once
 * the image does. A failure to load flips it back for the life of the process
 * rather than failing every request.
 *
 * Measured against the real package over the 65 shared fixtures: the embedding
 * tier alone agreed with the policy on 54 and let through ZERO prohibited
 * businesses, with ten of the eleven misses being it abstaining with nothing
 * behind it, which is exactly what the injected LLM tier fills.
 */
export function sigmaTierAvailable(): boolean {
  if (process.env.ACCEPTABLE_USE_SIGMA !== 'true') return false;
  return !sigmaUnavailable;
}

/**
 * Set the first time loading or warming the package fails, so a missing model
 * costs one failed import for the life of the process rather than one per
 * request. It is not a silent downgrade: the fallback is the LLM tier, which
 * is the same classifier that ran before the package existed, and the reason
 * is logged once.
 */
let sigmaUnavailable = false;

/** Test seam: the flag above is module state. */
export function resetSigmaAvailability(): void {
  sigmaUnavailable = false;
}

/**
 * The slice of `@flowstarter/sigma-flowstarter` this adapter calls.
 *
 * Deliberately narrow. It is a description of a dependency, not a copy of one.
 */
export interface SigmaTierVerdict {
  label: string;
  confidence: number;
  evidence: string;
}

interface SigmaHeadTrace {
  tier: 'semantic' | 'injected' | 'default';
  confidence: number;
  evidence: string | null;
}

export interface SigmaDecision {
  acceptableUse: 'allow' | 'review' | 'refuse';
  category: string | null;
  reasons: { acceptableUse: string };
  trace: { heads: Record<string, SigmaHeadTrace | undefined> };
}

interface SigmaModule {
  classifyAcceptableUse(
    text: string,
    options: {
      tiers?: {
        acceptable_use?: (
          text: string,
          decision: string,
          signal: AbortSignal
        ) => Promise<SigmaTierVerdict | null>;
      };
    }
  ): Promise<SigmaDecision>;
}

/**
 * The embedding tier, with the LLM tier injected as its fallback.
 *
 * `@flowstarter/sigma-flowstarter` (#160) scores the text against multilingual
 * centroids and consults the injected tier ONLY where its own bands abstain,
 * which is the whole point of the cascade: the common case never reaches a
 * model at all, and the ambiguous case gets the one that reads intent.
 *
 * Imported dynamically on purpose. The package pulls in `onnxruntime-node`, a
 * native module: a static import would put it in the Next.js server bundle of
 * every route that touches the gate, and would make an environment without the
 * fetched encoder fail at module load rather than at a place that can fall
 * back. `classifyAcceptableUse` is already async, so this costs nothing.
 */
/**
 * One sigma `Decision`, as the classification the rule layer reads.
 *
 * Pure, exported and tested on its own. The I/O half below is four lines of
 * dynamic import that cannot run without the package; this is the part with
 * the judgement in it, and it must not go untested just because the tier is
 * dormant.
 */
export function classificationFromSigmaDecision(
  decision: SigmaDecision
): PolicyClassification {
  const head = decision.trace.heads.acceptable_use;
  const categoryId = decision.category
    ? SIGMA_TO_APP[decision.category] ?? decision.category
    : CLEAN_CATEGORY_ID;

  return {
    categoryId,
    confidence: head?.confidence ?? 0,
    // The package's reason string is machine-readable and carries no user text
    // by construction, which is what an operator card needs.
    evidence: head?.evidence ?? decision.reasons.acceptableUse,
    needsHuman: decision.acceptableUse !== 'allow',
    tier: head?.tier === 'injected' ? 'llm' : 'embedding',
    // Authoritative: see `decidedAction` in acceptable-use.ts. The package's
    // bands are calibrated against cosine margins, ours against a model's
    // self-reported probability, and re-deciding across those scales would
    // change the gate with nothing in the diff to show it.
    decidedAction: decision.acceptableUse,
  };
}

/**
 * Our LLM classification, in the package's label space, as its second tier.
 *
 * Pure over an injected classifier so it is testable without the package.
 * Returning null is an abstention, which the package treats as "nothing
 * overruled the embeddings" rather than as an error.
 */
export function sigmaTierFromLlm(
  classify: (text: string, signal: AbortSignal) => Promise<PolicyClassification>
) {
  return async (
    text: string,
    _decision: string,
    signal: AbortSignal
  ): Promise<SigmaTierVerdict | null> => {
    const answer = await classify(text, signal);
    if (answer.failed) return null;
    const label = APP_TO_SIGMA[answer.categoryId];
    // A label the package does not know is an abstention, not a guess. Its
    // own fallback is `review`, which is where an unreadable answer belongs.
    if (!label) return null;
    return {
      label,
      confidence: answer.confidence,
      evidence: answer.evidence,
    };
  };
}

/**
 * The embedding tier, with the LLM tier injected as its fallback.
 *
 * `@flowstarter/sigma-flowstarter` scores the text against multilingual
 * centroids and consults the injected tier ONLY where its own bands abstain,
 * which is the point of the cascade: the common case never reaches a model at
 * all, and the ambiguous case gets the one that reads intent.
 *
 * Imported dynamically, with a literal specifier so the bundler traces it
 * properly. Dynamic rather than static because the package loads a native ONNX
 * runtime and a 135 MB encoder: a static import would pay that cost in every
 * route that touches the gate, including the ones where the tier is switched
 * off.
 */
async function callSigmaClassifier(
  input: ClassifyAcceptableUseInput,
  text: string
): Promise<PolicyClassification> {
  const sigma = (await import(
    '@flowstarter/sigma-flowstarter'
  )) as unknown as SigmaModule;

  const decision = await sigma.classifyAcceptableUse(text, {
    tiers: {
      acceptable_use: sigmaTierFromLlm((tierText, signal) =>
        classifyWithLlm({
          surface: input.surface,
          text: tierText,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          signal,
        })
      ),
    },
  });

  return classificationFromSigmaDecision(decision);
}

// ---------------------------------------------------------------------------
// The one public entry point
// ---------------------------------------------------------------------------

/**
 * The test-only classifier.
 *
 * Hundreds of suites in this app drive a route that happens to sit behind the
 * gate while testing something else entirely: a rate limit, a Stripe session,
 * a teardown path. Left to themselves they would each load a 135 MB ONNX
 * encoder, reach a genuine verdict on a two-word fixture, and then try to
 * write a `policy_reviews` row against whatever Supabase double they set up.
 * Slow, and non-deterministic in tests that have no opinion about policy.
 *
 * So `ACCEPTABLE_USE_CLASSIFIER=stub` short-circuits to a confident clean
 * answer, and `apps/flowstarter-main/test/setup.ts` sets it for every suite.
 * The suites that ARE about the policy turn it back off for themselves.
 *
 * It cannot be switched on in production: the check below ignores it and says
 * so, loudly, every time. A stub that could answer a stranger's submission is
 * not a test seam, it is the gate removed.
 */
function stubClassifierEnabled(): boolean {
  if (process.env.ACCEPTABLE_USE_CLASSIFIER !== 'stub') return false;
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[policy] ACCEPTABLE_USE_CLASSIFIER=stub is set in production and is ' +
        'being ignored. The acceptable-use gate is running for real.'
    );
    return false;
  }
  return true;
}

export interface ClassifyAcceptableUseInput {
  /** What is being judged, e.g. 'quick intake'. Prompt context, not policy. */
  surface: string;
  text: string;
  workspaceId?: string | null;
  projectId?: string | null;
  signal?: AbortSignal;
}

/**
 * Classify one submission. Never throws.
 *
 * The order is fixed: cache, then the embedding tier when it exists, then the
 * LLM tier, then a recorded failure. A caller that wants a verdict passes the
 * result to `decide()`; nothing here interprets it.
 */
export async function classifyAcceptableUse(
  input: ClassifyAcceptableUseInput
): Promise<AcceptableUseClassification> {
  const limits = policyLimits();
  const text = input.text.slice(0, limits.maxInputChars);
  const evidenceHash = evidenceHashOf(text);
  const now = Date.now();

  if (stubClassifierEnabled()) {
    return {
      categoryId: CLEAN_CATEGORY_ID,
      confidence: 1,
      evidence: 'The stub classifier is enabled; nothing was classified.',
      needsHuman: false,
      tier: 'unavailable',
      evidenceHash,
      promptVersion: 'stub',
      costEstimateUsd: null,
      model: null,
      cached: false,
    };
  }

  prune(now, limits);
  const hit = cache.get(evidenceHash);
  if (hit && now - hit.at <= limits.cacheTtlMs) {
    return { ...hit.value, cached: true };
  }

  const spent = hit?.calls ?? 0;
  if (spent >= limits.maxCallsPerSubmission) {
    // The cap is reached and the cached answer has aged out. Refusing to spend
    // again is the right call, but pretending the submission is clean is not:
    // this is a failure, and the rule layer fails it closed in production.
    const capped: AcceptableUseClassification = {
      ...unavailableClassification(
        'The classification budget for this submission is spent.'
      ),
      evidenceHash,
      cached: false,
    };
    cache.set(evidenceHash, {
      at: now,
      firstAt: hit?.firstAt ?? now,
      value: capped,
      calls: spent,
    });
    return capped;
  }

  let classification: PolicyClassification | null = null;
  if (sigmaTierAvailable()) {
    try {
      classification = await callSigmaClassifier(input, text);
    } catch (error) {
      // A missing encoder, a corrupt centroid file, a native module that will
      // not load. None of those is a verdict, and none of them may stop the
      // gate: the LLM tier below is the same classifier that ran before the
      // package existed. Logged once, then not retried for the life of the
      // process.
      sigmaUnavailable = true;
      console.warn(
        '[policy] the sigma embedding tier is unavailable; falling back to the ' +
          'LLM tier for the rest of this process. Fetch the encoder with ' +
          '`pnpm --filter @flowstarter/sigma-core fetch-model`.',
        error instanceof Error ? error.message : error
      );
    }
  }
  if (!classification) {
    classification = await classifyWithLlm({
      surface: input.surface,
      text,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      signal: input.signal,
    });
  }

  const withMeta = classification as PolicyClassification & {
    promptVersion?: string;
    costEstimateUsd?: number | null;
    model?: string | null;
  };
  const value: AcceptableUseClassification = {
    categoryId: classification.categoryId,
    confidence: classification.confidence,
    evidence: classification.evidence,
    needsHuman: classification.needsHuman,
    tier: classification.tier,
    failed: classification.failed,
    decidedAction: classification.decidedAction,
    evidenceHash,
    promptVersion: withMeta.promptVersion ?? '',
    costEstimateUsd: withMeta.costEstimateUsd ?? null,
    model: withMeta.model ?? null,
    cached: false,
  };

  // A failure is cached too, and it counts against the cap. Otherwise an
  // outage turns every retry into another paid attempt at a provider that is
  // already down.
  cache.set(evidenceHash, {
    at: now,
    firstAt: hit?.firstAt ?? now,
    value,
    calls: spent + 1,
  });
  return value;
}
