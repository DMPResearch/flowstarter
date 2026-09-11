import { describe, expect, it } from 'vitest';
import { stageTone, stageDotStyle } from '../dashboard.constants';

describe('stageTone', () => {
  it('reads intake as neutral, before anything has started', () => {
    expect(stageTone('intake')).toBe('neutral');
  });

  it('reads build and internal_review as warn — work an operator owns', () => {
    expect(stageTone('build')).toBe('warn');
    expect(stageTone('internal_review')).toBe('warn');
  });

  it('reads client_review as accent — in front of the client', () => {
    expect(stageTone('client_review')).toBe('accent');
  });

  it('reads launched and care as ok', () => {
    expect(stageTone('launched')).toBe('ok');
    expect(stageTone('care')).toBe('ok');
  });

  it('falls back to neutral for an unrecognised stage', () => {
    expect(stageTone('something_new')).toBe('neutral');
  });
});

describe('stageDotStyle', () => {
  it('reads its colour from the tone token, not a hardcoded palette', () => {
    expect(stageDotStyle('launched')).toEqual({
      backgroundColor: 'var(--fs-tone-ok)',
    });
    expect(stageDotStyle('build')).toEqual({
      backgroundColor: 'var(--fs-tone-warn)',
    });
  });
});
