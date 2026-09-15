/**
 * The four properties the call site owns, each asserted rather than assumed:
 * temperature 0, cost accounted through the one seam, cached by content hash,
 * and failing closed to `unclear`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const callLlmObject = vi.fn();
vi.mock('../llm', () => ({
  callLlmObject: (...args: unknown[]) => callLlmObject(...args),
}));

/** The alert path reaches Supabase and Resend; neither belongs in a unit test. */
interface OpsAlertCall {
  event: string;
  discriminator: string;
  detail: Record<string, unknown>;
}
const sendOpsAlert =
  vi.fn<(input: OpsAlertCall) => Promise<{ sent: boolean }>>();
vi.mock('@/lib/ops/send-ops-alert', () => ({
  sendOpsAlert: (input: OpsAlertCall) => sendOpsAlert(input),
}));

import {
  CLASSIFIER_FAILURE_ALERT_THRESHOLD,
  resetClassifierHealth,
} from '../classifier-health';
import {
  MAX_SCOPE_INPUT_CHARS,
  SCOPE_PROMPT_VERSION,
  clearScopeCache,
  llmClassifyScope,
  scopeCacheKey,
} from '../classify-scope';

function answers(object: {
  scope: string;
  confidence: number;
  evidence?: string[];
}) {
  callLlmObject.mockResolvedValue({ object: { evidence: [], ...object } });
}

beforeEach(() => {
  clearScopeCache();
  resetClassifierHealth();
  callLlmObject.mockReset();
  sendOpsAlert.mockReset();
  sendOpsAlert.mockResolvedValue({ sent: true });
});

describe('llmClassifyScope', () => {
  it('goes through the one budgeted seam, at temperature 0, on its own action', async () => {
    answers({ scope: 'standard', confidence: 0.9 });
    await llmClassifyScope('A bakery in Cluj');

    expect(callLlmObject).toHaveBeenCalledTimes(1);
    const options = callLlmObject.mock.calls[0][0];
    expect(options.action).toBe('classify_scope');
    expect(options.temperature).toBe(0);
    // Anonymous funnel traffic: there is no workspace at this point by
    // construction, and the ledger column is nullable for exactly this.
    expect(options.workspaceId).toBeNull();
    expect(options.schema).toBeDefined();
    expect(options.system).toContain('standard');
    expect(options.system).toContain('custom');
    expect(options.system).toContain('unclear');
  });

  it('reports the verdict with the prompt version it was reached under', async () => {
    answers({
      scope: 'custom',
      confidence: 0.88,
      evidence: ['customers log in', 'a dashboard'],
    });
    const result = await llmClassifyScope('A portal my clients log into');
    expect(result).toEqual({
      scope: 'custom',
      confidence: 0.88,
      evidence: ['customers log in', 'a dashboard'],
      classifier: `llm:${SCOPE_PROMPT_VERSION}`,
    });
  });

  it('caches by content hash, so a reload is not billed twice', async () => {
    answers({ scope: 'standard', confidence: 0.8 });
    const first = await llmClassifyScope('A bakery in Cluj');
    const second = await llmClassifyScope('A bakery in Cluj');
    expect(second).toEqual(first);
    expect(callLlmObject).toHaveBeenCalledTimes(1);

    await llmClassifyScope('A law firm in Cluj');
    expect(callLlmObject).toHaveBeenCalledTimes(2);
  });

  it('keys the cache on the prompt version too', () => {
    // Not a behaviour test so much as a statement of the key's shape: two
    // different versions of the prompt can never share an entry.
    expect(scopeCacheKey('x')).toHaveLength(64);
    expect(scopeCacheKey('x')).not.toBe(scopeCacheKey('y'));
  });

  it('clamps a confidence the model made up', async () => {
    answers({ scope: 'custom', confidence: 7 });
    expect((await llmClassifyScope('a')).confidence).toBe(1);
    clearScopeCache();
    answers({ scope: 'custom', confidence: -3 });
    expect((await llmClassifyScope('b')).confidence).toBe(0);
  });

  it('keeps at most three evidence fragments and trims each one', async () => {
    answers({
      scope: 'custom',
      confidence: 0.9,
      evidence: ['  one  ', '', 'two', 'three', 'four', 'x'.repeat(400)],
    });
    const result = await llmClassifyScope('something');
    expect(result.evidence).toEqual(['one', 'two', 'three']);
  });

  it('fails closed to unclear when the model call throws', async () => {
    callLlmObject.mockRejectedValue(new Error('provider is down'));
    const result = await llmClassifyScope('A bakery in Cluj');
    expect(result.scope).toBe('unclear');
    expect(result.confidence).toBe(0);
    expect(result.classifier).toBe('none');
  });

  it('does not cache a failure, so the next visitor gets a real answer', async () => {
    callLlmObject.mockRejectedValueOnce(new Error('blip'));
    await llmClassifyScope('A bakery in Cluj');
    answers({ scope: 'standard', confidence: 0.9 });
    expect((await llmClassifyScope('A bakery in Cluj')).scope).toBe('standard');
  });

  it('answers an empty brief without calling anything', async () => {
    const result = await llmClassifyScope('   ');
    expect(result.scope).toBe('unclear');
    expect(callLlmObject).not.toHaveBeenCalled();
  });

  it('truncates a paste bomb rather than sending it', async () => {
    answers({ scope: 'standard', confidence: 0.9 });
    await llmClassifyScope('x'.repeat(MAX_SCOPE_INPUT_CHARS * 3));
    const sent = callLlmObject.mock.calls[0][0].prompt as string;
    expect(sent.length).toBe(MAX_SCOPE_INPUT_CHARS);
  });
});

/**
 * The schema the seam is handed, exercised directly.
 *
 * `callLlmObject` is mocked above, so nothing else in this file ever runs the
 * schema. It is worth running: a schema stricter than what a model actually
 * emits is a classification failure that reads exactly like a provider outage.
 */
describe('the schema the model is held to', () => {
  interface Parseable {
    safeParse(value: unknown): { success: boolean; data?: unknown };
  }

  async function schema(): Promise<Parseable> {
    answers({ scope: 'standard', confidence: 0.9 });
    await llmClassifyScope('A bakery in Cluj');
    return callLlmObject.mock.calls[0][0].schema as Parseable;
  }

  it('accepts the documented values in any case', async () => {
    const parsed = (await schema()).safeParse({
      scope: ' Standard ',
      confidence: 0.9,
      evidence: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ scope: 'standard' });
  });

  it('accepts a confidence the model wrote as a string', async () => {
    const parsed = (await schema()).safeParse({
      scope: 'custom',
      confidence: '0.82',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ confidence: 0.82 });
  });

  it('ignores a field nobody asked for', async () => {
    const parsed = (await schema()).safeParse({
      scope: 'custom',
      confidence: 0.9,
      reasoning: 'I thought about it for a while',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('reasoning');
  });

  it('keeps a fourth evidence fragment rather than failing the object', async () => {
    const parsed = (await schema()).safeParse({
      scope: 'custom',
      confidence: 0.9,
      evidence: ['a', 'b', 'c', 'd'],
    });
    expect(parsed.success).toBe(true);
  });

  it('still refuses a label that is not one of the three', async () => {
    expect(
      (await schema()).safeParse({ scope: 'website', confidence: 1 }).success
    ).toBe(false);
  });
});

describe('a classifier that has stopped answering', () => {
  it('says nothing about the first failures, which are usually a blip', async () => {
    callLlmObject.mockRejectedValue(new Error('provider is down'));
    for (let i = 0; i < CLASSIFIER_FAILURE_ALERT_THRESHOLD - 1; i += 1) {
      await llmClassifyScope(`brief ${i}`);
    }
    expect(sendOpsAlert).not.toHaveBeenCalled();
  });

  it('raises an operator alert once the run is long enough', async () => {
    // The whole point: on 2026-09-15 this failed on 100% of calls for an
    // evening and the only trace was a console line. The gate kept answering
    // 200, so nothing else could have noticed.
    callLlmObject.mockRejectedValue(new Error('could not parse the response'));
    for (let i = 0; i < CLASSIFIER_FAILURE_ALERT_THRESHOLD; i += 1) {
      await llmClassifyScope(`brief ${i}`);
    }
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    const alert = sendOpsAlert.mock.calls[0][0];
    expect(alert.event).toBe('scope_classifier_failed');
    expect(alert.discriminator).toBe('scope');
    expect(alert.detail.consecutiveFailures).toBe(
      CLASSIFIER_FAILURE_ALERT_THRESHOLD
    );
    expect(alert.detail.reason).toBe('could not parse the response');
    expect(alert.detail.promptVersion).toBe(SCOPE_PROMPT_VERSION);
  });

  it('never puts the visitor’s own brief in the alert', async () => {
    callLlmObject.mockRejectedValue(new Error('down'));
    for (let i = 0; i < CLASSIFIER_FAILURE_ALERT_THRESHOLD; i += 1) {
      await llmClassifyScope('A clinic on Strada Memorandumului run by Ana');
    }
    expect(JSON.stringify(sendOpsAlert.mock.calls)).not.toContain(
      'Memorandumului'
    );
  });

  it('forgets the run as soon as one classification works', async () => {
    callLlmObject.mockRejectedValue(new Error('down'));
    for (let i = 0; i < CLASSIFIER_FAILURE_ALERT_THRESHOLD - 1; i += 1) {
      await llmClassifyScope(`brief ${i}`);
    }
    answers({ scope: 'standard', confidence: 0.9 });
    await llmClassifyScope('a working brief');

    callLlmObject.mockReset();
    callLlmObject.mockRejectedValue(new Error('down again'));
    await llmClassifyScope('another brief');
    expect(sendOpsAlert).not.toHaveBeenCalled();
  });

  it('still answers unclear when the alert itself cannot be sent', async () => {
    sendOpsAlert.mockRejectedValueOnce(new Error('no mailer'));
    callLlmObject.mockRejectedValue(new Error('down'));
    let result;
    for (let i = 0; i < CLASSIFIER_FAILURE_ALERT_THRESHOLD; i += 1) {
      result = await llmClassifyScope(`brief ${i}`);
    }
    expect(result?.scope).toBe('unclear');
  });
});
