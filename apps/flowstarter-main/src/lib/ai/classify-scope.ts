import 'server-only';

/**
 * Today's implementation of `classifyScope` (see
 * `@/lib/flowstarter/scope-classifier` for the interface and why it is one).
 *
 * One structured-output call through the single LLM seam, and nothing else.
 * The model is asked for exactly three fields and is told, in as many words,
 * that it is not deciding anything: the routing rule in
 * `@/lib/flowstarter/scope-route` reads the verdict and decides. That is not
 * politeness towards the model, it is the reason this file can be replaced by
 * `packages/sigma-classifier` without touching a caller.
 *
 * Four properties this call site owns, none of which belong in the prompt:
 *
 *   temperature 0    a classification that changes between identical requests
 *                    is not a classification. The call site sets it; the model
 *                    is not asked to be consistent.
 *   cost accounted   `callLlmObject` writes the `llm_usage` row and enforces
 *                    the per-action budget. `classify_scope` has its own entry
 *                    in `LLM_BUDGETS`, so ops can retune or re-point it with
 *                    LLM_BUDGET_CLASSIFY_SCOPE / LLM_MODEL_CLASSIFY_SCOPE.
 *   cached           by a hash of the prompt version and the exact text, so a
 *                    visitor who reloads the page, or whose browser retries,
 *                    is not classified (and billed) twice. The cache is keyed
 *                    on the prompt version too: a prompt edit invalidates every
 *                    entry rather than serving verdicts from the old rules.
 *   fails closed     any failure -- provider down, budget exceeded, malformed
 *                    object, no API key at all -- returns `unclear`, never
 *                    `standard`. `unclear` costs the visitor one clarifying
 *                    question. `standard` would cost a full generation run on a
 *                    brief nothing has read, which is the exact failure this
 *                    feature exists to prevent, and it is the failure that
 *                    matters in production where nobody is watching the logs.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { callLlmObject } from './llm';
import {
  UNCLASSIFIED,
  type ScopeClassification,
} from '@/lib/flowstarter/scope-classifier';

/**
 * The prompt's version, bumped by hand whenever SYSTEM_PROMPT changes.
 *
 * It is part of the cache key and it is recorded on every `custom_work_leads`
 * row, so a routing decision can always be read back against the rules that
 * produced it. A prompt edited without bumping this would serve stale verdicts
 * out of the cache and lie about its own provenance in the lead table.
 */
export const SCOPE_PROMPT_VERSION = '2026-09-14.1';

/**
 * What the model is asked. Note what is absent: no thresholds, no mention of
 * discovery calls, no instruction about what to do with the answer. It reports
 * one fact about a brief. The product decision is not its business.
 */
const SYSTEM_PROMPT = [
  'You classify a short business brief into one of three scopes. You do not',
  'make any decision about what happens next; another system does that.',
  '',
  'standard - a website that presents a business to the public: what it does,',
  '  who it is for, what it costs, how to get in touch or book. Brochure sites,',
  '  portfolios, restaurant and salon sites, service businesses, a shop selling',
  '  a catalogue of products, a site with a contact form or a booking calendar.',
  '',
  'custom - software rather than a presentation. Anything where the visitor',
  '  describes accounts their own customers log into, a dashboard, a portal, a',
  '  marketplace with two sides, a mobile app, an internal tool, a booking or',
  '  logistics platform they want built, an integration with a system of their',
  '  own, or a product whose value is the software itself.',
  '',
  'unclear - the brief does not say enough to tell the two apart. Use this',
  '  rather than guessing. It is the correct answer far more often than a low',
  '  confidence on one of the other two.',
  '',
  'confidence is 0 to 1 and is about the brief, not about your own fluency: a',
  'clear brief scores high, a brief that mentions both a shop window and a',
  'customer portal scores low.',
  '',
  'evidence is up to three short fragments quoted from the brief itself, each',
  'under 100 characters. Quote, do not paraphrase, and never invent a fragment',
  'that is not in the text. An operator reads these next to the brief.',
  '',
  'Respond with only the JSON object.',
].join('\n');

const ScopeSchema = z.object({
  scope: z.enum(['standard', 'custom', 'unclear']),
  confidence: z.number(),
  evidence: z.array(z.string()).max(3),
});

/** Longest fragment kept. The prompt asks for less; this enforces it. */
const MAX_EVIDENCE_CHARS = 100;

/**
 * The whole brief the classifier ever sees. Longer than any honest answer to
 * four questions, short enough that the call stays inside its token budget.
 */
export const MAX_SCOPE_INPUT_CHARS = 6_000;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Bounded, in-process, no TTL.
 *
 * No TTL because the answer is a function of the text and the prompt version,
 * both of which are in the key: an entry cannot go stale, it can only stop
 * being useful. Bounded because this is anonymous funnel traffic and an
 * unbounded map keyed on visitor input is a memory leak with a nice name.
 * Insertion-ordered eviction rather than LRU: the traffic this serves is a
 * visitor retrying within a minute, not a long tail worth ranking.
 */
const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, ScopeClassification>();

export function scopeCacheKey(text: string): string {
  return createHash('sha256')
    .update(SCOPE_PROMPT_VERSION)
    .update('\n')
    .update(text)
    .digest('hex');
}

/** For tests, and for anything that edits the prompt at runtime (nothing does). */
export function clearScopeCache(): void {
  cache.clear();
}

function remember(key: string, value: ScopeClassification): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

// ---------------------------------------------------------------------------

function clampConfidence(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}

function cleanEvidence(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const fragment of raw) {
    const trimmed = fragment.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    out.push(trimmed.slice(0, MAX_EVIDENCE_CHARS));
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Classify one brief, or say `unclear` and why in the log.
 *
 * Never throws. Every caller of this is on the visitor's critical path between
 * the last question and the preview, and there is no failure here worth turning
 * into a dead end for somebody who has just answered four questions.
 */
export async function llmClassifyScope(
  text: string
): Promise<ScopeClassification> {
  const trimmed = text.trim().slice(0, MAX_SCOPE_INPUT_CHARS);
  if (!trimmed) return UNCLASSIFIED;

  const key = scopeCacheKey(trimmed);
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    const { object } = await callLlmObject<z.infer<typeof ScopeSchema>>({
      action: 'classify_scope',
      // Anonymous funnel traffic: the ledger column is nullable and there is no
      // workspace yet, by definition -- this runs before anything is claimed.
      workspaceId: null,
      schema: ScopeSchema,
      temperature: 0,
      system: SYSTEM_PROMPT,
      prompt: trimmed,
    });

    const result: ScopeClassification = {
      scope: object.scope,
      confidence: clampConfidence(object.confidence),
      evidence: cleanEvidence(object.evidence ?? []),
      classifier: `llm:${SCOPE_PROMPT_VERSION}`,
    };
    remember(key, result);
    return result;
  } catch (error) {
    // The brief itself is the visitor's own words and never reaches a log line;
    // only the reason does.
    console.warn(
      '[scope] classification failed, routing as unclear:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return UNCLASSIFIED;
  }
}
