/**
 * The one rule every string a stranger sends goes through.
 *
 * Pure, so every case here is a value in and a value out. What is being
 * defended is narrow and worth restating: not "this stops XSS" — React and
 * the email renderer do that, and they do it whether or not this file exists —
 * but "this cannot be stored", "this is invisible", and "this is longer than
 * we agreed to hold".
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INBOUND_LIMITS,
  INBOUND_LIMIT_ENV_VARS,
  inboundLimits,
  sanitiseInbound,
  sanitiseInboundOrNull,
} from '../inbound-content';

const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);

const line = { limit: 50, markup: 'reject' } as const;
const prose = { limit: 50, markup: 'text', multiline: true } as const;

describe('a value that cannot be stored', () => {
  it('refuses a NUL byte, which no Postgres text column can hold', () => {
    expect(sanitiseInbound(`before${NUL}after`, prose)).toEqual({
      ok: false,
      reason: 'null_byte',
    });
  });

  it('refuses one hiding at the end, where a trim would not find it', () => {
    expect(sanitiseInbound(`Elena${NUL}`, line).ok).toBe(false);
  });
});

describe('characters that are there without being visible', () => {
  it('strips the control characters', () => {
    const result = sanitiseInbound(`one${BELL}two`, prose);
    expect(result).toEqual({ ok: true, value: 'onetwo' });
  });

  it('strips the ones that reverse what follows them', () => {
    const result = sanitiseInbound(`Elena${RTL_OVERRIDE} Popescu`, line);
    expect(result).toEqual({ ok: true, value: 'Elena Popescu' });
  });

  it('strips zero width spaces and the byte order mark', () => {
    const result = sanitiseInbound(`El${ZERO_WIDTH}ena${BOM}`, line);
    expect(result).toEqual({ ok: true, value: 'Elena' });
  });

  it('keeps the letters that only look like formatting characters', () => {
    // U+0645 and friends: Arabic, and a real name. A `\p{Cf}` sweep would
    // have taken the zero-width joiner out of scripts that need it, which is
    // why the rule is written as explicit ranges.
    const arabic = 'محمد';
    expect(sanitiseInbound(arabic, line)).toEqual({ ok: true, value: arabic });
  });
});

describe('newlines', () => {
  it('keeps paragraphs in a message and folds the Windows pair', () => {
    expect(sanitiseInbound('one\r\ntwo\rthree', prose)).toEqual({
      ok: true,
      value: 'one\ntwo\nthree',
    });
  });

  it('flattens a name onto one line, whatever was pasted into it', () => {
    expect(sanitiseInbound('Elena\nPopescu', line)).toEqual({
      ok: true,
      value: 'Elena Popescu',
    });
  });

  it('flattens a tab, which is how a name becomes two CSV columns', () => {
    expect(sanitiseInbound('Elena\tPopescu', line)).toEqual({
      ok: true,
      value: 'Elena Popescu',
    });
  });
});

describe('unicode', () => {
  it('normalises to NFC, so one name is one string', () => {
    const decomposed = `Ren${String.fromCharCode(0x65, 0x301)}e`;
    const composed = `Ren${String.fromCharCode(0xe9)}e`;
    expect(decomposed).not.toBe(composed);
    expect(sanitiseInbound(decomposed, line)).toEqual({
      ok: true,
      value: composed,
    });
  });
});

describe('markup', () => {
  it('refuses it in a field it can only ever be an attack in', () => {
    expect(sanitiseInbound('<img src=x onerror=alert(1)>', line)).toEqual({
      ok: false,
      reason: 'markup',
    });
  });

  it('refuses a bare angle bracket in such a field, both directions', () => {
    expect(sanitiseInbound('a < b', line).ok).toBe(false);
    expect(sanitiseInbound('a > b', line).ok).toBe(false);
  });

  it('keeps it verbatim in prose, for the renderer to escape', () => {
    const payload = '<img src=x onerror=alert(1)>';
    expect(sanitiseInbound(payload, prose)).toEqual({
      ok: true,
      value: payload,
    });
  });
});

describe('length', () => {
  it('refuses what is over the cap by default', () => {
    expect(sanitiseInbound('x'.repeat(51), line)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('truncates instead when the caller asked for that', () => {
    const result = sanitiseInbound('x'.repeat(51), {
      ...line,
      onOverflow: 'truncate',
    });
    expect(result).toEqual({ ok: true, value: 'x'.repeat(50) });
  });

  it('measures after stripping, so padding with invisibles does not count', () => {
    const padded = 'x'.repeat(50) + ZERO_WIDTH.repeat(20);
    expect(sanitiseInbound(padded, line)).toEqual({
      ok: true,
      value: 'x'.repeat(50),
    });
  });
});

describe('a field that is not there', () => {
  it('is the empty string, and whether that is allowed is the caller rule', () => {
    for (const absent of [undefined, null, 42, {}, []]) {
      expect(sanitiseInbound(absent, line)).toEqual({ ok: true, value: '' });
    }
  });

  it('trims to empty rather than to whitespace', () => {
    expect(sanitiseInbound('   \n\t  ', prose)).toEqual({
      ok: true,
      value: '',
    });
  });
});

describe('the caller that cannot refuse', () => {
  it('turns a refusal into null rather than losing the delivery', () => {
    expect(sanitiseInboundOrNull(`x${NUL}`, line)).toBeNull();
    expect(sanitiseInboundOrNull('<script>', line)).toBeNull();
  });

  it('turns an empty value into null too, which is what a column wants', () => {
    expect(sanitiseInboundOrNull('   ', line)).toBeNull();
    expect(sanitiseInboundOrNull(undefined, line)).toBeNull();
  });

  it('passes a good value straight through', () => {
    expect(sanitiseInboundOrNull('Ada Roe', line)).toBe('Ada Roe');
  });
});

describe('the limits', () => {
  it('are the documented defaults on an empty environment', () => {
    expect(inboundLimits({})).toEqual({ ...DEFAULT_INBOUND_LIMITS });
  });

  it('are whatever an operator set, per field', () => {
    const limits = inboundLimits({
      [INBOUND_LIMIT_ENV_VARS.message]: '120',
      [INBOUND_LIMIT_ENV_VARS.name]: '30',
    });
    expect(limits.message).toBe(120);
    expect(limits.name).toBe(30);
    expect(limits.email).toBe(DEFAULT_INBOUND_LIMITS.email);
  });

  it('fall back to the default rather than crashing on nonsense', () => {
    const limits = inboundLimits({
      [INBOUND_LIMIT_ENV_VARS.message]: 'lots',
      [INBOUND_LIMIT_ENV_VARS.name]: '-5',
    });
    expect(limits.message).toBe(DEFAULT_INBOUND_LIMITS.message);
    expect(limits.name).toBe(DEFAULT_INBOUND_LIMITS.name);
  });
});
