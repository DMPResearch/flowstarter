import 'server-only';

/**
 * The local classifier, as an implementation of `classifyScope`.
 *
 * `@flowstarter/sigma-flowstarter` (PR #160, built output since #167) decides
 * scope from a sentence embedding against committed centroids, with no network
 * call and no tokens. Where it is confident it is free and instant; where it
 * abstains it consults a second tier the caller supplies, and the tier this
 * module supplies is the same bounded model call `./classify-scope` already
 * owns. So the two implementations are not alternatives so much as a cascade:
 * the embedding answers the easy nine cases in ten, the model answers the
 * ambiguous one, and the routing rule in `@/lib/flowstarter/scope-route` reads
 * whichever verdict came back without knowing or caring which tier produced it.
 *
 * ── Off by default, and why ───────────────────────────────────────────────
 * `SCOPE_SIGMA=1` turns it on, the same shape and for the same reason as
 * `ACCEPTABLE_USE_SIGMA` on the other head (`@/lib/policy/classifier`). It is
 * off everywhere until a deployment's image actually carries the encoder model: sigma-core pulls
 * `onnxruntime-node` and reads a model directory, and a slot image without one
 * fails on the first request rather than at boot. Defaulting on would trade a
 * classification that works today for one that throws on a cold start in the
 * middle of somebody's intake.
 *
 * Even with the switch on, a load failure is not fatal: `sigmaScopeClassifier`
 * falls back to the model call rather than to `unclear`, because the visitor
 * should not be asked a clarifying question because of our deployment.
 */
import { SCOPE_PROMPT_VERSION, llmClassifyScope } from './classify-scope';
import {
  verbatimEvidence,
  type ScopeClassification,
} from '@/lib/flowstarter/scope-classifier';
import type { Scope } from '@/lib/flowstarter/scope-route';

/**
 * The one variable, named to pair with `ACCEPTABLE_USE_SIGMA` in
 * `@/lib/policy/classifier`: the two heads come out of the same package and
 * are switched on independently, so they are `<HEAD>_SIGMA` rather than two
 * unrelated names. Absent or anything but `1`/`true` means off.
 */
export function sigmaScopeEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.SCOPE_SIGMA?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * sigma's `ScopeAction` is already this product's three literals, so the map is
 * the identity plus a guard. Written out rather than cast: the day sigma grows
 * a fourth action, this fails to compile instead of routing on a string the
 * rule has never heard of.
 */
function scopeFrom(action: string): Scope {
  if (action === 'standard' || action === 'custom' || action === 'unclear') {
    return action;
  }
  console.warn(`[scope] sigma returned an unknown scope action: ${action}`);
  return 'unclear';
}

/**
 * Evidence an operator can check against the brief.
 *
 * sigma's cascade reports one machine-readable reason per head -- calibration
 * state, head, verdict, tier, e.g. `confident:scope:custom-work:semantic` --
 * safe to log and built never to contain the visitor's text (see `reasons` on
 * `Decision` in `@flowstarter/sigma-flowstarter`'s `gate.ts`). This function
 * used to read that string in here, and #191 shipped an operator email that
 * quoted it as though it were a clause from the brief. That string now goes
 * into `ScopeClassification.trace` and a log line instead (see
 * `sigmaScopeClassifier` below); this function only ever sees `head.evidence`,
 * which is `null` whenever the embedding tier decided on its own -- centroid
 * geometry has no sentence to report -- and is the injected LLM tier's own
 * text (see `llmTier` below) whenever THAT tier is the one that decided.
 *
 * Even the LLM tier's own text is re-checked against `text` here rather than
 * trusted: a model can paraphrase instead of quoting, and a paraphrase in
 * quotation marks reads exactly like the bug above to an operator with no way
 * to tell the two apart short of opening the brief. `text` is what was
 * actually classified, the same string `scopeClassifierText` assembled, so a
 * fragment that survives this really is checkable against it.
 */
function evidenceFrom(
  headEvidence: string | null | undefined,
  text: string
): string[] {
  if (!headEvidence) return [];
  const fragments = headEvidence
    .split('|')
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  return verbatimEvidence(fragments, text);
}

/**
 * The injected second tier: this product's own bounded model call, wrapped in
 * the shape `@flowstarter/sigma-core` expects.
 *
 * Returning `null` is an abstention and is always allowed, so a model failure
 * (which `llmClassifyScope` already swallows into `unclear`) hands the decision
 * back to sigma's own default rather than pretending to a verdict.
 */
async function llmTier(
  text: string,
  _decision: string,
  signal: AbortSignal
): Promise<{ label: string; confidence: number; evidence: string } | null> {
  if (signal.aborted) return null;
  const result = await llmClassifyScope(text);
  if (result.scope === 'unclear' && result.confidence === 0) return null;
  return {
    label: result.scope,
    confidence: result.confidence,
    evidence: result.evidence.join(' | ') || `llm:${SCOPE_PROMPT_VERSION}`,
  };
}

/**
 * Loaded once, lazily, and never retried in this process once it has failed.
 *
 * A missing model directory does not become reachable between two requests, and
 * retrying the import on every intake would put a multi-second filesystem probe
 * on the visitor's critical path for as long as the deployment is misbuilt.
 */
type SigmaGate = {
  classifyScope: (
    text: string,
    options?: Record<string, unknown>
  ) => Promise<{
    scope: string;
    reasons: { scope: string };
    trace: {
      heads: Record<string, { confidence?: number; evidence?: string | null }>;
    };
  }>;
};

let gate: Promise<SigmaGate | null> | undefined;

function loadGate(): Promise<SigmaGate | null> {
  gate ??= (async () => {
    try {
      const mod = await import('@flowstarter/sigma-flowstarter');
      return mod as unknown as SigmaGate;
    } catch (error) {
      console.warn(
        '[scope] sigma is enabled but could not be loaded, using the model call:',
        error instanceof Error ? error.message : 'unknown error'
      );
      return null;
    }
  })();
  return gate;
}

/** Test seam, and the only thing that clears the memoised load. */
export function __resetSigmaScopeForTest(): void {
  gate = undefined;
}

/** sigma's version of `classifyScope`, with the model call behind it. */
export async function sigmaScopeClassifier(
  text: string
): Promise<ScopeClassification> {
  const loaded = await loadGate();
  if (!loaded) return llmClassifyScope(text);

  try {
    const decision = await loaded.classifyScope(text, {
      tiers: { scope: llmTier },
    });
    const head = decision.trace?.heads?.scope;
    const scope = scopeFrom(decision.scope);
    // The reason code, kept for a log line only -- see `trace` on
    // `ScopeClassification` and the doc on `evidenceFrom` above for why it
    // must never reach `evidence`.
    const trace = decision.reasons?.scope || undefined;
    if (trace) {
      console.debug(`[scope] sigma decided ${scope}: ${trace}`);
    }
    return {
      scope,
      confidence: Math.min(1, Math.max(0, Number(head?.confidence) || 0)),
      evidence: evidenceFrom(head?.evidence, text),
      classifier: 'sigma',
      trace,
      // `@flowstarter/sigma-core`'s `decide()` maps every head to its
      // platform action through a guard on that head's OWN calibration
      // (cosine similarity/margin for the embedding tier, its own confidence
      // for an injected one -- see `packages/sigma-core/src/policy.ts`), and
      // the fallback for a guard that does not clear is always `unclear` (see
      // `SCOPE_MAPPING` in `packages/sigma-flowstarter/src/gate.ts`). So
      // `scope` can only be `custom` or `standard` here because that guard
      // already passed: the cascade has decided, on its own scale, and
      // `confidence` above is that scale's number, not a probability
      // `scopeRouteThresholds()` was tuned for. This is what makes a raw
      // margin around 0.07 for a confident verdict route correctly instead of
      // failing every threshold comparison `decideRoute` used to make.
      decided: scope !== 'unclear',
    };
  } catch (error) {
    // Same direction as everywhere else in this feature: degrade to the thing
    // that works, never to a verdict nothing produced.
    console.warn(
      '[scope] sigma classification failed, using the model call:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return llmClassifyScope(text);
  }
}
