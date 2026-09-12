/**
 * The tone line: three adjectives and one sentence about how the site should
 * sound.
 *
 * This is the one place in the brand pipeline where a model is allowed to
 * speak, and the division of labour is the usual one:
 *
 *   rules decide, models phrase.
 *
 * The rules here decide three things, and the model decides none of them:
 *
 *   1. WHETHER THERE IS ANYTHING TO PHRASE. `toneEvidence` collects the
 *      visitor's own words, from their offer, their description and whatever a
 *      public profile exposed. If that comes to nothing, the model is never
 *      called. A model asked to describe the tone of an empty string will
 *      happily produce "warm, professional, approachable" for a business it
 *      knows nothing about, and the visitor cannot tell that apart from a real
 *      reading. That is the precise failure this guard exists to prevent.
 *   2. WHAT THE FALLBACK IS. With no evidence the tone comes from the intake's
 *      own tone chips, deterministically, and is marked `source: 'chips'` so
 *      the wizard can say where it came from.
 *   3. WHETHER THE ANSWER IS USABLE. The model's output is validated: three
 *      adjectives, each a single lowercase word, and one line under a limit.
 *      Anything else falls back to the chips rather than shipping.
 *
 * Nothing here writes to the database and nothing here fetches a profile; the
 * caller has already done both. Everything except `phraseTone` is pure.
 */
import { z } from 'zod';

import { callLlmObject } from '@/lib/ai/llm';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface ToneReading {
  /** Exactly three, lowercase, single words. */
  adjectives: string[];
  /** One line on how the copy should sound. Never longer than a sentence. */
  voice: string;
  /**
   * `phrased` when a model read the visitor's own words, `chips` when it came
   * from the tone chips, `default` when there were no chips either.
   */
  source: 'phrased' | 'chips' | 'default';
}

/** Longest voice note we will show or store. One sentence, not a paragraph. */
export const MAX_VOICE_CHARS = 160;

/** Longest single adjective. "Approachable" is eleven. */
export const MAX_ADJECTIVE_CHARS = 20;

/** How many words of evidence before it is worth asking a model anything. */
export const MIN_EVIDENCE_CHARS = 40;

/** The most evidence we send. A model does not need the whole bio twice. */
export const MAX_EVIDENCE_CHARS = 900;

/**
 * The tone when the visitor gave us neither words nor chips. Deliberately
 * plain: a default that claims to be "bold" is a lie about a business we know
 * nothing about, and plain prose is the only honest thing left.
 */
export const DEFAULT_TONE: ToneReading = {
  adjectives: ['clear', 'direct', 'warm'],
  voice: 'Plain sentences that say what the business does and who it is for.',
  source: 'default',
};

// ---------------------------------------------------------------------------
// The chips fallback
// ---------------------------------------------------------------------------

/**
 * Tone chips to a voice note. One line per chip family, chosen by the first
 * rule that matches, so the order below is the ranking: the stronger signal
 * wins, because it is the one a visitor is least likely to have tapped by
 * accident.
 *
 * The adjectives come from the chips the visitor actually picked, not from
 * this table, so a visitor who typed their own word sees their own word back.
 */
const VOICE_BY_TONE: ReadonlyArray<readonly [readonly string[], string]> = [
  [
    ['bold', 'vibrant', 'energetic', 'confident'],
    'Short, certain sentences. Say the strongest true thing first and do not hedge it.',
  ],
  [
    ['premium', 'elegant', 'editorial', 'minimal'],
    'Few words, chosen carefully. Let the space and the pictures carry the rest.',
  ],
  [
    ['earthy', 'natural', 'calm', 'warm'],
    'Unhurried and concrete. Name real things rather than reaching for adjectives.',
  ],
  [
    ['playful', 'friendly', 'approachable'],
    'Talk the way you would to someone standing in front of you, contractions and all.',
  ],
  [
    ['professional', 'trustworthy', 'modern'],
    'Clear and unshowy. Be specific about what happens and what it costs.',
  ],
];

function normaliseAdjective(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s*\/\s*/g, ' ')
    .replace(/[^a-z ]/g, '')
    .trim()
    .split(/\s+/)[0] as string;
}

/**
 * The chips, as a tone. Pure. Takes the comma-joined string the intake stores
 * and returns the first three usable words with the matching voice line.
 */
export function toneFromChips(
  brandTone: string | null | undefined
): ToneReading | null {
  const chips = (brandTone ?? '')
    .split(',')
    .map((chip) => normaliseAdjective(chip))
    .filter((chip) => chip.length > 1 && chip.length <= MAX_ADJECTIVE_CHARS);
  if (chips.length === 0) return null;

  const needle = (brandTone ?? '').toLowerCase();
  const hit = VOICE_BY_TONE.find(([words]) =>
    words.some((word) => needle.includes(word))
  );

  // Deduplicate while keeping the visitor's own order: "Warm, Warm, Bold" is a
  // draft that was edited, not three signals.
  const adjectives = Array.from(new Set(chips)).slice(0, 3);
  return {
    adjectives,
    voice: hit?.[1] ?? VOICE_BY_TONE[VOICE_BY_TONE.length - 1]?.[1] ?? '',
    source: 'chips',
  };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface ToneEvidenceInput {
  /** What they said they offer, in the quick intake. */
  offer?: string | null;
  /** The longer description, if the conversation got one. */
  description?: string | null;
  /** Whatever a public profile exposed. Often empty; see `profile-signals`. */
  bioText?: string | null;
}

/**
 * The visitor's own words, joined and capped. Returns '' when there is
 * nothing, which is the signal not to call a model at all.
 *
 * Only the visitor's words go in here. Not the industry chip, not the goal
 * chips, not the business name: those are our categories, and a tone built
 * from our own categories is a tone we made up.
 */
export function toneEvidence(input: ToneEvidenceInput): string {
  return [input.offer, input.description, input.bioText]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EVIDENCE_CHARS);
}

/** True when there is enough of the visitor's own prose to read a tone from. */
export function hasToneEvidence(evidence: string): boolean {
  return evidence.length >= MIN_EVIDENCE_CHARS;
}

// ---------------------------------------------------------------------------
// The model's half
// ---------------------------------------------------------------------------

const ToneSchema = z.object({
  adjectives: z.array(z.string().min(2).max(MAX_ADJECTIVE_CHARS)).length(3),
  voice: z
    .string()
    .min(8)
    .max(MAX_VOICE_CHARS * 2),
});

const TONE_SYSTEM_PROMPT = [
  'You read a short description a business owner wrote about themselves and',
  'report how their site should sound. Respond with ONLY a JSON object of the',
  'shape {"adjectives": [string, string, string], "voice": string}.',
  'Each adjective is one lowercase English word describing the voice, not the',
  'business: "unhurried", not "artisanal bakery". The three must differ from',
  'each other.',
  'The voice note is one sentence of practical instruction to whoever writes',
  'the copy, under 160 characters, in plain English with no em dashes and no',
  'emoji.',
  'Use only what the description actually says. If it is thin, say something',
  'modest and true rather than inventing a personality for them.',
].join(' ');

/**
 * Cleans the model's answer into something we are willing to show, or returns
 * null. Pure, so the whole validation is testable without a model.
 */
export function readToneAnswer(raw: {
  adjectives?: unknown;
  voice?: unknown;
}): ToneReading | null {
  const words = Array.isArray(raw.adjectives)
    ? raw.adjectives
        .filter((word): word is string => typeof word === 'string')
        .map((word) => normaliseAdjective(word))
        .filter((word) => word.length > 1 && word.length <= MAX_ADJECTIVE_CHARS)
    : [];
  const adjectives = Array.from(new Set(words)).slice(0, 3);
  if (adjectives.length !== 3) return null;

  const voice =
    typeof raw.voice === 'string' ? raw.voice.replace(/\s+/g, ' ').trim() : '';
  if (voice.length < 8) return null;

  return {
    adjectives,
    voice: voice.length > MAX_VOICE_CHARS ? '' : voice,
    source: 'phrased',
  };
}

export interface PhraseToneInput extends ToneEvidenceInput {
  /** The intake's tone chips, for the fallback. */
  brandTone?: string | null;
  /** Null for anonymous funnel traffic, which is the normal case here. */
  workspaceId?: string | null;
}

/**
 * The tone, phrased.
 *
 * Never calls the model with nothing: with no evidence it returns the chips
 * fallback without a network round trip, and with no chips either it returns
 * the plain default. A model failure is not an error either, for the same
 * reason: the visitor is waiting for a preview, and a tone line is not worth
 * failing a funnel over.
 */
export async function phraseTone(input: PhraseToneInput): Promise<ToneReading> {
  const fallback = toneFromChips(input.brandTone) ?? DEFAULT_TONE;
  const evidence = toneEvidence(input);
  if (!hasToneEvidence(evidence)) return fallback;

  try {
    const { object } = await callLlmObject<{
      adjectives: string[];
      voice: string;
    }>({
      action: 'intake_graph',
      workspaceId: input.workspaceId ?? null,
      schema: ToneSchema,
      temperature: 0.3,
      system: TONE_SYSTEM_PROMPT,
      prompt: JSON.stringify({ description: evidence }),
    });
    const reading = readToneAnswer(object);
    if (!reading) return fallback;
    // A voice note that came back too long is dropped rather than truncated:
    // half a sentence of instruction is worse than the fallback's whole one.
    return reading.voice ? reading : { ...fallback, source: fallback.source };
  } catch {
    return fallback;
  }
}
