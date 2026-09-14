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
import type { ScopeClassification } from '@/lib/flowstarter/scope-classifier';
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

/** Evidence an operator reads. sigma reports one machine-readable reason. */
function evidenceFrom(reason: string): string[] {
  const trimmed = reason.trim();
  return trimmed ? [trimmed] : [];
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
    trace: { heads: Record<string, { confidence?: number }> };
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
    return {
      scope: scopeFrom(decision.scope),
      confidence: Math.min(1, Math.max(0, Number(head?.confidence) || 0)),
      evidence: evidenceFrom(decision.reasons?.scope ?? ''),
      classifier: 'sigma',
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
