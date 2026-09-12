import { beforeEach, describe, expect, it, vi } from 'vitest';

const callLlmObject = vi.fn();
vi.mock('@/lib/ai/llm', () => ({
  callLlmObject: (...args: unknown[]) => callLlmObject(...args),
}));

import {
  DEFAULT_TONE,
  MAX_VOICE_CHARS,
  hasToneEvidence,
  phraseTone,
  readToneAnswer,
  toneEvidence,
  toneFromChips,
} from '../brand-tone';

/** Long enough to clear MIN_EVIDENCE_CHARS, so the model path is reached. */
const REAL_WORDS =
  'I do cosmetic dentistry for people who have not been to a dentist in ten years.';

beforeEach(() => {
  callLlmObject.mockReset();
});

describe('toneFromChips', () => {
  it('returns null when there are no chips', () => {
    expect(toneFromChips('')).toBeNull();
    expect(toneFromChips(null)).toBeNull();
    expect(toneFromChips(undefined)).toBeNull();
    expect(toneFromChips(', ,')).toBeNull();
  });

  it("gives back the visitor's own words, not a table's", () => {
    expect(toneFromChips('Calm, Trustworthy')?.adjectives).toEqual([
      'calm',
      'trustworthy',
    ]);
  });

  it('keeps at most three and drops repeats', () => {
    const tone = toneFromChips('Warm, Warm, Bold, Playful, Minimal');
    expect(tone?.adjectives).toEqual(['warm', 'bold', 'playful']);
  });

  it('reduces a compound chip to its first word', () => {
    expect(toneFromChips('Premium / elegant')?.adjectives).toEqual(['premium']);
  });

  it('reads the first matching family, so the order is the ranking', () => {
    expect(toneFromChips('Professional, Bold')?.voice).toBe(
      toneFromChips('Bold')?.voice
    );
  });

  it('always has a voice line, even for words no family covers', () => {
    const tone = toneFromChips('Nautical');
    expect(tone?.adjectives).toEqual(['nautical']);
    expect(tone?.voice.length).toBeGreaterThan(0);
  });

  it('marks where it came from', () => {
    expect(toneFromChips('Calm')?.source).toBe('chips');
  });
});

describe('toneEvidence', () => {
  it('joins only the words the visitor wrote', () => {
    expect(
      toneEvidence({ offer: 'Whitening.', description: 'A clinic.' })
    ).toBe('Whitening. A clinic.');
  });

  it('is empty when they wrote nothing', () => {
    expect(toneEvidence({})).toBe('');
    expect(toneEvidence({ offer: '   ', description: null })).toBe('');
  });

  it('collapses whitespace and caps the length', () => {
    const long = toneEvidence({ description: 'word  '.repeat(400) });
    expect(long.length).toBeLessThanOrEqual(900);
    expect(long).not.toContain('  ');
  });

  it('folds in whatever a profile exposed', () => {
    expect(toneEvidence({ offer: 'A.', bioText: 'B.' })).toBe('A. B.');
  });

  it('knows when there is too little to read a tone from', () => {
    expect(hasToneEvidence('')).toBe(false);
    expect(hasToneEvidence('dentist')).toBe(false);
    expect(hasToneEvidence(REAL_WORDS)).toBe(true);
  });
});

describe('readToneAnswer', () => {
  it('accepts three clean adjectives and a line', () => {
    expect(
      readToneAnswer({
        adjectives: ['Calm', 'direct', 'Warm'],
        voice: 'Say the true thing plainly.',
      })
    ).toEqual({
      adjectives: ['calm', 'direct', 'warm'],
      voice: 'Say the true thing plainly.',
      source: 'phrased',
    });
  });

  it('refuses anything that is not three distinct adjectives', () => {
    expect(
      readToneAnswer({ adjectives: ['calm', 'calm', 'calm'], voice: 'A line.' })
    ).toBeNull();
    expect(
      readToneAnswer({ adjectives: ['calm'], voice: 'A line.' })
    ).toBeNull();
    expect(readToneAnswer({ adjectives: 'calm', voice: 'A line.' })).toBeNull();
    expect(readToneAnswer({})).toBeNull();
  });

  it('refuses a voice note that is missing or too short', () => {
    const three = ['calm', 'direct', 'warm'];
    expect(readToneAnswer({ adjectives: three, voice: 'no' })).toBeNull();
    expect(readToneAnswer({ adjectives: three, voice: 42 })).toBeNull();
  });

  it('empties a voice note that ran past the limit rather than truncating it', () => {
    const reading = readToneAnswer({
      adjectives: ['calm', 'direct', 'warm'],
      voice: 'x'.repeat(MAX_VOICE_CHARS + 1),
    });
    expect(reading?.voice).toBe('');
  });

  it('drops a word the model dressed up in punctuation', () => {
    expect(
      readToneAnswer({
        adjectives: ['"calm"', 'direct!', 'warm.'],
        voice: 'Say the true thing plainly.',
      })?.adjectives
    ).toEqual(['calm', 'direct', 'warm']);
  });
});

describe('phraseTone', () => {
  it('never calls a model with nothing to read', async () => {
    const tone = await phraseTone({ brandTone: 'Calm, Trustworthy' });
    expect(callLlmObject).not.toHaveBeenCalled();
    expect(tone.source).toBe('chips');
    expect(tone.adjectives).toEqual(['calm', 'trustworthy']);
  });

  it('falls all the way to the plain default with no words and no chips', async () => {
    const tone = await phraseTone({});
    expect(callLlmObject).not.toHaveBeenCalled();
    expect(tone).toEqual(DEFAULT_TONE);
  });

  it('does not call a model for a scrap of prose either', async () => {
    const tone = await phraseTone({ offer: 'dentist', brandTone: 'Calm' });
    expect(callLlmObject).not.toHaveBeenCalled();
    expect(tone.source).toBe('chips');
  });

  it("phrases from the visitor's own words when there are enough of them", async () => {
    callLlmObject.mockResolvedValue({
      object: {
        adjectives: ['unhurried', 'reassuring', 'plain'],
        voice: 'Explain what happens before it happens.',
      },
    });
    const tone = await phraseTone({ offer: REAL_WORDS, brandTone: 'Calm' });
    expect(callLlmObject).toHaveBeenCalledTimes(1);
    expect(tone).toEqual({
      adjectives: ['unhurried', 'reassuring', 'plain'],
      voice: 'Explain what happens before it happens.',
      source: 'phrased',
    });
  });

  it('sends the model only the description, never our own categories', async () => {
    callLlmObject.mockResolvedValue({
      object: { adjectives: ['a', 'bb', 'ccc'], voice: 'A line here.' },
    });
    await phraseTone({ offer: REAL_WORDS, brandTone: 'Calm' });
    const call = callLlmObject.mock.calls[0]?.[0] as { prompt: string };
    expect(JSON.parse(call.prompt)).toEqual({ description: REAL_WORDS });
  });

  it('books the call against the funnel, with no workspace', async () => {
    callLlmObject.mockResolvedValue({
      object: { adjectives: ['aa', 'bb', 'cc'], voice: 'A line here.' },
    });
    await phraseTone({ offer: REAL_WORDS });
    const call = callLlmObject.mock.calls[0]?.[0] as {
      workspaceId: string | null;
      action: string;
    };
    expect(call.workspaceId).toBeNull();
    expect(call.action).toBe('intake_graph');
  });

  it('falls back to the chips when the model returns something unusable', async () => {
    callLlmObject.mockResolvedValue({
      object: { adjectives: ['only', 'two'], voice: 'A line here.' },
    });
    const tone = await phraseTone({ offer: REAL_WORDS, brandTone: 'Bold' });
    expect(tone.source).toBe('chips');
    expect(tone.adjectives).toEqual(['bold']);
  });

  it('falls back to the chips when the model throws', async () => {
    callLlmObject.mockRejectedValue(new Error('budget exceeded'));
    const tone = await phraseTone({ offer: REAL_WORDS, brandTone: 'Bold' });
    expect(tone.source).toBe('chips');
  });

  it('falls back rather than showing an empty voice line', async () => {
    callLlmObject.mockResolvedValue({
      object: {
        adjectives: ['aa', 'bb', 'cc'],
        voice: 'x'.repeat(MAX_VOICE_CHARS + 1),
      },
    });
    const tone = await phraseTone({ offer: REAL_WORDS, brandTone: 'Bold' });
    expect(tone.voice.length).toBeGreaterThan(0);
    expect(tone.source).toBe('chips');
  });
});
