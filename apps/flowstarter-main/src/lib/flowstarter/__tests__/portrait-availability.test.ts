/**
 * `portrait-availability.ts` — the answer the connect buttons are drawn from.
 *
 * Two properties are worth a test here and they are both about what is NOT in
 * the answer. Half a credential must not read as available, because a button
 * wired to half a credential sends somebody to a provider that refuses them.
 * And the answer must carry env var names and never env var values, because it
 * goes into a log line and into a response body served to anybody.
 *
 * Every case passes its own environment object. Nothing in this suite touches
 * `process.env`, which is the point of the module taking one.
 */
import { describe, expect, it } from 'vitest';

import {
  anyPortraitProviderAvailable,
  portraitProviderAvailability,
  portraitProviderAvailabilityFor,
} from '../portrait-availability';
import { portraitTestCredentials } from './portrait-test-credentials';

// Minted per run, never committed. See `portrait-test-credentials.ts` for why
// a fixture that merely looks like a secret is still a problem worth removing.
const CREDENTIALS = portraitTestCredentials();
const LINKEDIN_ID = CREDENTIALS.LINKEDIN_CLIENT_ID;
const LINKEDIN_SECRET = CREDENTIALS.LINKEDIN_CLIENT_SECRET;
const INSTAGRAM_ID = CREDENTIALS.INSTAGRAM_APP_ID;
const INSTAGRAM_SECRET = CREDENTIALS.INSTAGRAM_APP_SECRET;

const BOTH = {
  LINKEDIN_CLIENT_ID: LINKEDIN_ID,
  LINKEDIN_CLIENT_SECRET: LINKEDIN_SECRET,
  INSTAGRAM_APP_ID: INSTAGRAM_ID,
  INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET,
};

const ONLY_LINKEDIN = {
  LINKEDIN_CLIENT_ID: LINKEDIN_ID,
  LINKEDIN_CLIENT_SECRET: LINKEDIN_SECRET,
};

describe('portraitProviderAvailability', () => {
  it('reports both providers available when both credentials are whole', () => {
    expect(portraitProviderAvailability(BOTH)).toEqual([
      { provider: 'linkedin', available: true, missing: [] },
      { provider: 'instagram', available: true, missing: [] },
    ]);
  });

  it('reports the configured one and names what the other is missing', () => {
    expect(portraitProviderAvailability(ONLY_LINKEDIN)).toEqual([
      { provider: 'linkedin', available: true, missing: [] },
      {
        provider: 'instagram',
        available: false,
        missing: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
      },
    ]);
  });

  it('reports both unavailable, with both pairs of names, on an empty environment', () => {
    expect(portraitProviderAvailability({})).toEqual([
      {
        provider: 'linkedin',
        available: false,
        missing: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
      },
      {
        provider: 'instagram',
        available: false,
        missing: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
      },
    ]);
  });

  it('refuses half a credential and names only the half that is missing', () => {
    const half = portraitProviderAvailabilityFor('linkedin', {
      LINKEDIN_CLIENT_ID: LINKEDIN_ID,
    });
    expect(half.available).toBe(false);
    expect(half.missing).toEqual(['LINKEDIN_CLIENT_SECRET']);
  });

  it('treats a whitespace-only value as missing rather than as set', () => {
    const blank = portraitProviderAvailabilityFor('instagram', {
      INSTAGRAM_APP_ID: '   ',
      INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET,
    });
    expect(blank.available).toBe(false);
    expect(blank.missing).toEqual(['INSTAGRAM_APP_ID']);
  });

  it('never puts a credential value in the answer', () => {
    const serialised = JSON.stringify(portraitProviderAvailability(BOTH));
    for (const value of [
      LINKEDIN_ID,
      LINKEDIN_SECRET,
      INSTAGRAM_ID,
      INSTAGRAM_SECRET,
    ]) {
      expect(serialised).not.toContain(value);
    }
  });

  it('keeps the declared provider order, so the buttons do not shuffle', () => {
    expect(portraitProviderAvailability({}).map((e) => e.provider)).toEqual([
      'linkedin',
      'instagram',
    ]);
  });
});

describe('anyPortraitProviderAvailable', () => {
  it('is true when either provider is whole', () => {
    expect(anyPortraitProviderAvailable(ONLY_LINKEDIN)).toBe(true);
  });

  it('is false when neither is', () => {
    expect(anyPortraitProviderAvailable({})).toBe(false);
  });

  it('is false when both providers have only half a credential each', () => {
    expect(
      anyPortraitProviderAvailable({
        LINKEDIN_CLIENT_ID: LINKEDIN_ID,
        INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET,
      })
    ).toBe(false);
  });
});
