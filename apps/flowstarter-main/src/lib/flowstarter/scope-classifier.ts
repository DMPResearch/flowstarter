/**
 * `classifyScope`: is this a site that presents a business, or custom work?
 *
 * One narrow interface with one implementation today and a different one
 * tomorrow. Everything in the funnel calls `classifyScope(text)` and nothing in
 * the funnel knows what answers it. Today that is a single bounded
 * structured-output model call (`@/lib/ai/classify-scope`).
 *
 * `@flowstarter/sigma-flowstarter` (PR #160, built output since #167) is the
 * other implementation and it is wired: `@/lib/ai/classify-scope-sigma` maps
 * its `Decision` onto `ScopeClassification` and hands it the model call above
 * as its injected second tier, so the embedding answers what it is sure about
 * and the model answers the rest. It is behind `SCOPE_SIGMA` and
 * OFF by default until a deployment's image carries the encoder model; see
 * that module for why, and for what happens when it is on and cannot load.
 *
 * Note what did not change to make that true: no caller, no signature, and no
 * threshold. That was the point of the seam.
 *
 * The interface is deliberately smaller than either implementation:
 *
 *   (text) -> { scope, confidence, evidence }
 *
 * No options, no model id, no thresholds. A caller that could pass a threshold
 * would eventually pass a different one than the routing rule uses, and then
 * the rule would be in two places. The thresholds live in `./scope-route`,
 * which is the only thing allowed to decide anything.
 *
 * `evidence` is short quoted fragments of the visitor's own words, not prose
 * about them. It is what an operator reads on the pipeline card to see why a
 * lead was routed to a call, so it has to be checkable against the brief.
 */
import type { Scope } from './scope-route';

export interface ScopeClassification {
  scope: Scope;
  /** 0..1. Implementations clamp. Not compared to a threshold by `decideRoute` any more -- see `decided`. */
  confidence: number;
  /** Short fragments of the visitor's own words that decided it. */
  evidence: string[];
  /**
   * Which implementation answered, recorded on the lead row so a routing
   * decision made months ago can still be read back against the thing that
   * made it. `llm:<prompt version>` today, `sigma:<model version>` later.
   */
  classifier: string;
  /**
   * True when THIS implementation has already decided, on its own
   * calibration, that `scope` is confident enough to act on -- not a number
   * for `@/lib/flowstarter/scope-route`'s `decideRoute` to compare against a
   * threshold.
   *
   * `confidence` above is whatever scale the tier that produced it uses: a
   * cosine margin from `@flowstarter/sigma-flowstarter`'s embedding centroids,
   * or a language model's self-reported probability, and the two are not
   * interchangeable. Comparing sigma's margin (around 0.07 for a confident
   * verdict) to the bars tuned for the model's probability (0.6/0.7) is
   * exactly the defect this flag exists to make impossible: every
   * sigma-classified visitor cleared neither bar and was asked the
   * clarifying question regardless of how sure the embedding tier was.
   *
   * Set by `@/lib/ai/classify-scope-sigma`'s adapter from the sigma cascade's
   * own guarded outcome (see that module) and by `@/lib/ai/classify-scope`'s
   * adapter from `scopeRouteThresholds()` -- the same bars `decideRoute` used
   * to compare `confidence` to directly. Absent or false means "not decided":
   * `decideRoute` treats a `custom`/`standard` verdict exactly like `unclear`
   * everywhere it would otherwise have acted on it. Mirrors `decidedAction` on
   * `PolicyClassification` in `@/lib/policy/acceptable-use`.
   */
  decided?: boolean;
}

export type ScopeClassifier = (text: string) => Promise<ScopeClassification>;

/**
 * The answer given when nothing can be asked.
 *
 * `unclear` and not `standard`: the routing rule turns `unclear` into one
 * clarifying question, which is a fine outcome for a visitor, whereas guessing
 * `standard` would start a build on a brief nothing has read.
 */
export const UNCLASSIFIED: ScopeClassification = {
  scope: 'unclear',
  confidence: 0,
  evidence: [],
  classifier: 'none',
  decided: false,
};

let override: ScopeClassifier | null = null;

/**
 * Swap the implementation. The seam the sigma package will use, and the seam
 * the tests use so that no unit test in this tree reaches a model.
 */
export function setScopeClassifier(classifier: ScopeClassifier): void {
  override = classifier;
}

export function resetScopeClassifier(): void {
  override = null;
}

/**
 * Which implementation answers when nothing has been injected.
 *
 * Resolved per call rather than memoised: the env switch is read at request
 * time so an operator can turn sigma on or off without a redeploy, and both
 * branches are cheap (`classify-scope-sigma` memoises its own heavy load).
 *
 * Imported lazily so that this module stays importable from anywhere -- both
 * implementations are `server-only` and pull in the LLM seam, which a pure
 * test of the routing rule has no business loading.
 */
async function defaultClassifier(): Promise<ScopeClassifier> {
  const { sigmaScopeEnabled, sigmaScopeClassifier } = await import(
    '@/lib/ai/classify-scope-sigma'
  );
  if (sigmaScopeEnabled()) return sigmaScopeClassifier;
  const { llmClassifyScope } = await import('@/lib/ai/classify-scope');
  return llmClassifyScope;
}

/** Classify one brief. */
export async function classifyScope(
  text: string
): Promise<ScopeClassification> {
  if (override) return override(text);
  return (await defaultClassifier())(text);
}

// ---------------------------------------------------------------------------
// The input
// ---------------------------------------------------------------------------

/** The four quick answers, plus the title of the link the visitor pasted. */
export interface ScopeClassifierInput {
  fullName: string;
  email: string;
  /** What they said their business does. The quick intake's third question. */
  description: string;
  /** The link answer, already parsed into its three fields by the script. */
  instagramUrl?: string;
  linkedinUrl?: string;
  websiteUrl?: string;
  /**
   * The `<title>` of the page behind the link, when we could read one. Real
   * evidence and cheap: "Acme -- Client Portal Login" settles a brief that the
   * description left open.
   */
  linkTitle?: string;
  /**
   * The visitor's answer to the one clarifying question, when it has been
   * asked. Part of the text so the second classification sees it, rather than
   * a flag the classifier would have to be told how to weigh.
   */
  clarification?: string;
}

/** Longest any one field may contribute. A paste bomb is not more evidence. */
const MAX_FIELD_CHARS = 2_000;

function field(label: string, value: string | undefined): string | null {
  const trimmed = (value ?? '').trim().slice(0, MAX_FIELD_CHARS);
  return trimmed ? `${label}: ${trimmed}` : null;
}

/**
 * The classifier's input, assembled deterministically.
 *
 * One function, so the text that is classified and the text that is hashed for
 * the cache are the same string by construction, and so that swapping the
 * implementation cannot quietly change what it is shown. The email is
 * deliberately absent: it is not evidence about scope, and it would make every
 * brief's hash unique and the cache useless.
 */
export function scopeClassifierText(input: ScopeClassifierInput): string {
  const links = [input.instagramUrl, input.linkedinUrl, input.websiteUrl]
    .map((url) => (url ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return [
    field('What the business does', input.description),
    field('Links', links),
    field('Title of the linked page', input.linkTitle),
    field('Answer to "site or software?"', input.clarification),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
