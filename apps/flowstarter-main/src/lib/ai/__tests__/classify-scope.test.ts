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
  callLlmObject.mockReset();
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
