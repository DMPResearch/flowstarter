/**
 * The worker's acceptable-use scanner: one HTTP call to flowstarter-main.
 *
 * The worker deliberately holds no policy of its own. It has no category list,
 * no thresholds, no prompt and no model key for this; it asks the app, which
 * answers with the same `screenAcceptableUse` the intake and the brief go
 * through. That is the whole point: a gate with two implementations is a gate
 * that will one day disagree with itself, and the disagreement will be
 * discovered by a client whose site got published.
 *
 * Authenticated with the build-worker shared secret, the same credential the
 * deploy callback uses.
 */

import type {
  ContentPolicyScanner,
  ContentPolicyVerdict,
} from '@flowstarter/agentic-codegen/src/flowstarter/acceptable-use';

export interface ContentPolicyConfig {
  /** flowstarter-main's origin, e.g. https://flowstarter.net. */
  flowstarterMainUrl: string;
  sharedSecret: string;
  /**
   * How long the worker waits. Generous next to an ordinary API call and tiny
   * next to a build: the whole run has already cost minutes and real money by
   * the time this is asked, so waiting twenty seconds to find out whether it
   * may be published is not the expensive part.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function isDecision(value: unknown): value is ContentPolicyVerdict['decision'] {
  return value === 'allow' || value === 'review' || value === 'refuse';
}

/**
 * Build the scanner the worker injects into `FullSiteBuildWorker`.
 *
 * Throws on anything that is not a clean, well-formed answer, including a
 * non-200 and a body whose `decision` is not one of the three. The workflow's
 * own rule decides what a throw means: it fails the build where scanning is
 * required, and logs where it is not. Returning a fabricated `allow` here
 * would make an outage look exactly like approval.
 */
export function createContentPolicyScanner(
  config: ContentPolicyConfig,
): ContentPolicyScanner {
  const endpoint =
    config.flowstarterMainUrl.replace(/\/$/, '') + '/api/internal/policy/scan';
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (input) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.sharedSecret}`,
      },
      body: JSON.stringify({
        text: input.text,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      // The body may carry an error message; it never carries the site text,
      // so it is safe to surface to the operator on the ledger.
      const detail = await response.text().catch(() => '');
      throw new Error(
        `the policy endpoint answered ${response.status}${
          detail ? `: ${detail.slice(0, 300)}` : ''
        }`,
      );
    }

    const body = (await response.json()) as Record<string, unknown>;
    if (!isDecision(body.decision)) {
      throw new Error('the policy endpoint returned no usable decision');
    }
    return {
      decision: body.decision,
      categoryId:
        typeof body.categoryId === 'string' ? body.categoryId : 'none',
      categoryLabel:
        typeof body.categoryLabel === 'string' ? body.categoryLabel : 'unknown',
      evidence: typeof body.evidence === 'string' ? body.evidence : '',
      evidenceHash:
        typeof body.evidenceHash === 'string' ? body.evidenceHash : '',
    };
  };
}
