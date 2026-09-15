/**
 * The parse that unblocked the funnel.
 *
 * The first fixture below is not invented. It is the exact `error.text` from
 * `NoObjectGeneratedError` on a real call to `anthropic/claude-sonnet-4`
 * through OpenRouter on 2026-09-15, at temperature 0, with the scope
 * classifier's own system prompt and Darius's own brief, made against the
 * local stack's configuration. The object in it is correct and complete; the
 * fence around it is the whole reason 100% of scope classifications failed and
 * no visitor could reach a preview.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  extractJsonObject,
  parseObjectFromText,
  recoverObject,
  stripCodeFence,
} from '../object-repair';

/** Verbatim. Do not tidy it. */
const REAL_FAILING_RESPONSE =
  '```json\n{\n  "scope": "standard",\n  "confidence": 0.9,\n  "evidence": [\n    "I want a portfolio site that shows the three projects I have shipped",\n    "A site that presents my business"\n  ]\n}\n```';

const ScopeSchema = z.object({
  scope: z.enum(['standard', 'custom', 'unclear']),
  confidence: z.number(),
  evidence: z.array(z.string()),
});

describe('the response that broke the scope gate', () => {
  it('is not valid JSON, which is why the SDK threw', () => {
    expect(() => JSON.parse(REAL_FAILING_RESPONSE)).toThrow();
  });

  it('parses once the fence is off', () => {
    expect(recoverObject(REAL_FAILING_RESPONSE, ScopeSchema)).toEqual({
      scope: 'standard',
      confidence: 0.9,
      evidence: [
        'I want a portfolio site that shows the three projects I have shipped',
        'A site that presents my business',
      ],
    });
  });
});

describe('stripCodeFence', () => {
  it('unwraps a fence with a language tag', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('unwraps a fence without one', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('leaves unfenced text exactly as it found it', () => {
    expect(stripCodeFence('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('does not unwrap a fence that is not the whole answer', () => {
    // Prose with an example in it is somebody explaining themselves, and
    // taking the example would be guessing which part was the answer.
    const text = 'Here is what I would return:\n```json\n{"a":1}\n```';
    expect(stripCodeFence(text)).toBe(text);
  });
});

describe('extractJsonObject', () => {
  it('takes the outermost object, nesting included', () => {
    expect(extractJsonObject('noise {"a":{"b":2}} trailing')).toBe(
      '{"a":{"b":2}}'
    );
  });

  it('does not end the object on a brace inside a string', () => {
    // An evidence fragment quoting a visitor's own brace would otherwise move
    // the boundary and truncate the object.
    expect(extractJsonObject('{"evidence":["a } b"],"scope":"custom"}')).toBe(
      '{"evidence":["a } b"],"scope":"custom"}'
    );
  });

  it('is not fooled by an escaped quote', () => {
    expect(extractJsonObject('{"a":"say \\" }","b":1}')).toBe(
      '{"a":"say \\" }","b":1}'
    );
  });

  it('finds nothing in a truncated object', () => {
    expect(extractJsonObject('{"scope":"standard","confid')).toBeNull();
  });

  it('finds nothing in text with no object at all', () => {
    expect(extractJsonObject('I could not answer that.')).toBeNull();
  });
});

describe('parseObjectFromText', () => {
  it('refuses an array, which is not the shape any caller asked for', () => {
    expect(parseObjectFromText('[1,2,3]')).toBeNull();
  });

  it('refuses malformed JSON rather than repairing it', () => {
    // Recover, never invent: a comma the model forgot is not something this
    // module gets to decide the meaning of.
    expect(parseObjectFromText('{"a":1,,}')).toBeNull();
  });

  it('answers null for an empty completion', () => {
    expect(parseObjectFromText(undefined)).toBeNull();
    expect(parseObjectFromText('')).toBeNull();
  });
});

describe('recoverObject', () => {
  it('lets the caller schema refuse a recovered object', () => {
    // The point of handing it back to the schema: a well-formed object that is
    // not the answer is still not an answer.
    expect(
      recoverObject('```json\n{"scope":"toaster"}\n```', ScopeSchema)
    ).toBe(null);
  });

  it('returns what the schema produced, not what was parsed', () => {
    const Coercing = z.object({ confidence: z.coerce.number() });
    expect(recoverObject('{"confidence":"0.4"}', Coercing)).toEqual({
      confidence: 0.4,
    });
  });

  it('hands back the raw object when there is no schema to check it', () => {
    expect(recoverObject('{"a":1}', undefined)).toEqual({ a: 1 });
  });
});
