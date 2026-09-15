import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockCallLlmObject } = vi.hoisted(() => ({
  mockCallLlmObject: vi.fn(),
}));

vi.mock('../llm', async () => {
  const actual = await vi.importActual<typeof import('../llm')>('../llm');
  return {
    ...actual,
    callLlmObject: mockCallLlmObject,
  };
});

import { LlmBudgetExceededError } from '../llm';
import {
  AUTO_CAPTION_COLORS_MAX,
  AUTO_CAPTION_SUBJECT_MAX_CHARS,
  autoCaptionAsset,
} from '../asset-caption';

const BYTES = Buffer.from('not real image bytes, the LLM call is mocked');

function validObject(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'A dentist smiling in a bright reception area',
    kind: 'photo',
    showsPerson: true,
    visibleName: null,
    dominantColors: ['white', '#2a6f97'],
    ...overrides,
  };
}

describe('autoCaptionAsset', () => {
  beforeEach(() => {
    mockCallLlmObject.mockReset();
  });

  it('returns the model’s guess on a clean call', async () => {
    mockCallLlmObject.mockResolvedValue({
      object: validObject(),
      usage: {
        tokensIn: 100,
        tokensOut: 40,
        cachedTokens: 0,
        totalTokens: 140,
      },
      model: 'anthropic/claude-3.7-sonnet',
      costEstimate: 0.001,
    });

    const result = await autoCaptionAsset({
      bytes: BYTES,
      mime: 'image/png',
      workspaceId: 'ws-1',
    });

    expect(result).toEqual(validObject());
    expect(mockCallLlmObject).toHaveBeenCalledTimes(1);
    const call = mockCallLlmObject.mock.calls[0]![0];
    expect(call.action).toBe('caption_asset');
    expect(call.workspaceId).toBe('ws-1');
    // One user message carrying both the prompt text and the image bytes —
    // never a second, unbudgeted call, and never the bytes alone with no
    // instruction about what to report.
    expect(call.messages).toHaveLength(1);
    const [message] = call.messages;
    expect(message.role).toBe('user');
    expect(message.content).toEqual([
      { type: 'text', text: expect.any(String) },
      { type: 'image', image: BYTES, mediaType: 'image/png' },
    ]);
  });

  it('threads a null workspaceId through for anonymous funnel traffic', async () => {
    mockCallLlmObject.mockResolvedValue({
      object: validObject(),
      usage: { tokensIn: 1, tokensOut: 1, cachedTokens: 0, totalTokens: 2 },
      model: 'anthropic/claude-3.7-sonnet',
      costEstimate: 0,
    });

    await autoCaptionAsset({ bytes: BYTES, mime: 'image/jpeg' });

    expect(mockCallLlmObject.mock.calls[0]![0].workspaceId).toBeNull();
  });

  it('trims a padded subject and caps the colour list defensively', async () => {
    mockCallLlmObject.mockResolvedValue({
      object: validObject({
        subject: '  A logo on a white background  ',
        dominantColors: Array.from(
          { length: AUTO_CAPTION_COLORS_MAX + 5 },
          (_, i) => ` Colour${i} `
        ),
      }),
      usage: { tokensIn: 1, tokensOut: 1, cachedTokens: 0, totalTokens: 2 },
      model: 'anthropic/claude-3.7-sonnet',
      costEstimate: 0,
    });

    const result = await autoCaptionAsset({ bytes: BYTES, mime: 'image/png' });

    expect(result?.subject).toBe('A logo on a white background');
    expect(result?.dominantColors).toHaveLength(AUTO_CAPTION_COLORS_MAX);
    expect(result?.dominantColors[0]).toBe('colour0');
  });

  it('normalizes a blank visibleName to null', async () => {
    mockCallLlmObject.mockResolvedValue({
      object: validObject({ visibleName: '   ' }),
      usage: { tokensIn: 1, tokensOut: 1, cachedTokens: 0, totalTokens: 2 },
      model: 'anthropic/claude-3.7-sonnet',
      costEstimate: 0,
    });

    const result = await autoCaptionAsset({ bytes: BYTES, mime: 'image/png' });
    expect(result?.visibleName).toBeNull();
  });

  it('fails closed to null when the schema does not validate', async () => {
    mockCallLlmObject.mockRejectedValue(
      new Error('response did not match schema')
    );

    const result = await autoCaptionAsset({ bytes: BYTES, mime: 'image/png' });
    expect(result).toBeNull();
  });

  it('fails closed to null on a network/timeout error', async () => {
    mockCallLlmObject.mockRejectedValue(new Error('The operation was aborted'));

    const result = await autoCaptionAsset({ bytes: BYTES, mime: 'image/png' });
    expect(result).toBeNull();
  });

  it('fails closed to null when the budget is exceeded, without re-throwing', async () => {
    mockCallLlmObject.mockRejectedValue(
      new LlmBudgetExceededError('caption_asset', 'total_tokens', 3_000, 5_000)
    );

    const result = await autoCaptionAsset({ bytes: BYTES, mime: 'image/png' });
    expect(result).toBeNull();
  });

  it('never returns a subject over the documented cap', async () => {
    mockCallLlmObject.mockResolvedValue({
      object: validObject({
        subject: 'x'.repeat(AUTO_CAPTION_SUBJECT_MAX_CHARS + 50),
      }),
      usage: { tokensIn: 1, tokensOut: 1, cachedTokens: 0, totalTokens: 2 },
      model: 'anthropic/claude-3.7-sonnet',
      costEstimate: 0,
    });

    const result = await autoCaptionAsset({ bytes: BYTES, mime: 'image/png' });
    expect(result?.subject.length).toBeLessThanOrEqual(
      AUTO_CAPTION_SUBJECT_MAX_CHARS
    );
  });
});
