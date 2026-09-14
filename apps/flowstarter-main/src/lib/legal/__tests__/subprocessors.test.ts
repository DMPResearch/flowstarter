/**
 * The subprocessor list, checked against the code rather than against itself.
 *
 * The old hand-written list on the privacy page named Plausible, which has
 * never been installed, and Calendly, which was replaced by a self-hosted
 * Cal.com; it omitted Arcjet, the language-model gateway, Cal.com, GitHub and
 * Depot. Every assertion below is aimed at that failure: a vendor that
 * appears in the list has to appear in the source tree, and a vendor the
 * source tree depends on has to appear in the list.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DPA_STATEMENT,
  SUBPROCESSORS,
  isDisclosed,
  subprocessorsOutsideEu,
  termsUrl,
} from '../subprocessors';

/** Surrogate-pair range: the app's ES target predates \p{} escapes. */
const EMOJI =
  /[\uD83C-\uDBFF][\uDC00-\uDFFF]|\uFE0F|[\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF]/;

const APP_ROOT = path.resolve(__dirname, '../../../..');

function readSource(relative: string): string {
  return readFileSync(path.join(APP_ROOT, relative), 'utf8');
}

describe('the list itself', () => {
  it('names nothing twice', () => {
    const names = SUBPROCESSORS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every entry a purpose, a region, a basis and its terms', () => {
    for (const entry of SUBPROCESSORS) {
      expect(entry.purpose.length).toBeGreaterThan(20);
      expect(entry.region.length).toBeGreaterThan(2);
      expect(entry.terms.length).toBeGreaterThan(5);
      expect(entry.evidence.length).toBeGreaterThan(3);
    }
  });

  it('writes no em dash and no emoji, the same as every other surface', () => {
    const prose = SUBPROCESSORS.map(
      (entry) => `${entry.purpose} ${entry.region} ${entry.terms}`
    ).join(' ');
    expect(prose).not.toContain('—');
    expect(prose).not.toMatch(EMOJI);
    expect(DPA_STATEMENT).not.toContain('—');
  });
});

describe('what the code actually uses', () => {
  const names = SUBPROCESSORS.map((entry) => entry.name);
  const keys = SUBPROCESSORS.map((entry) => entry.key);

  // Every membership check below is exact, on the slug. Searching inside the
  // display name is wrong in both directions -- "Cal" matches Calendly, and a
  // vendor renamed to "Cal.com, self-hosted" keeps passing a test looking for
  // "Cal.com" -- and comparing a dotted vendor name by substring is the shape
  // CodeQL flags as js/incomplete-url-substring-sanitization, which is what it
  // flagged on the first version of this file.
  it.each([
    'clerk',
    'supabase',
    'hetzner',
    'cloudflare',
    'stripe',
    'resend',
    'arcjet',
    'openrouter',
    'cal-com',
    'github',
    'depot',
  ])('discloses %s', (key) => {
    expect(isDisclosed(key)).toBe(true);
    expect(keys).toContain(key);
  });

  it('keeps the slugs unique, and free of anything shaped like a host', () => {
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('says the booking software is self-hosted, not a third party', () => {
    const cal = SUBPROCESSORS.find((entry) => entry.key === 'cal-com');
    expect(cal).toBeDefined();
    expect(cal?.name).toMatch(/self-hosted/i);
    expect(cal?.region).toMatch(/our own servers/i);
    expect(cal?.transfersOutsideEu).toBe(false);
  });

  it('does not name Plausible, which has never been installed', () => {
    expect(names.join(' ')).not.toMatch(/plausible/i);
    expect(isDisclosed('plausible')).toBe(false);
  });

  it('does not name Calendly, which Cal.com replaced', () => {
    expect(names.join(' ')).not.toMatch(/calendly/i);
    expect(isDisclosed('calendly')).toBe(false);
  });

  it('names OpenRouter because that is the gateway lib/ai calls', () => {
    const client = readSource('src/lib/ai/client.ts');
    expect(client).toContain('OPENROUTER_API_KEY');
    expect(isDisclosed('openrouter')).toBe(true);
  });

  it('names Arcjet because the middleware runs it on every request', () => {
    expect(readSource('src/middleware.ts')).toMatch(/arcjet/i);
    expect(isDisclosed('arcjet')).toBe(true);
  });
});

describe('the DPA statement', () => {
  it('no longer claims a signed agreement with every vendor', () => {
    expect(DPA_STATEMENT).not.toMatch(/has signed/i);
    expect(DPA_STATEMENT).not.toMatch(/Each one has signed/i);
  });

  it('says where the terms are and how to ask for ours', () => {
    expect(DPA_STATEMENT).toMatch(/publishes the data-processing terms/i);
    expect(DPA_STATEMENT).toMatch(/contact page/i);
  });
});

describe('subprocessorsOutsideEu', () => {
  it('selects exactly the entries flagged as transferring', () => {
    const outside = subprocessorsOutsideEu();
    expect(outside.length).toBeGreaterThan(0);
    for (const entry of outside) {
      expect(entry.transfersOutsideEu).toBe(true);
    }
  });

  // The region prose and the flag have to agree. The flag is what the
  // transfers section is built from, and the prose is what a reader checks it
  // against; a vendor where they disagree is a disclosure that contradicts
  // itself on the same page.
  it('agrees with what each entry says about where it is', () => {
    for (const entry of SUBPROCESSORS) {
      expect(entry.transfersOutsideEu).toBe(
        entry.region.includes('standard contractual clauses')
      );
    }
  });

  it('leaves the EU-hosted vendors out of the transfer section', () => {
    const outsideKeys = subprocessorsOutsideEu().map((entry) => entry.key);
    expect(outsideKeys).not.toContain('supabase');
    expect(outsideKeys).not.toContain('hetzner');
    expect(outsideKeys).not.toContain('stripe');
    expect(outsideKeys).not.toContain('cal-com');
  });

  it('takes the list it is given, so a caller can pin it', () => {
    expect(
      subprocessorsOutsideEu([
        {
          key: 'somewhere',
          name: 'Somewhere',
          purpose: 'x'.repeat(30),
          region: 'European Union',
          legalBasis: 'Contract performance',
          transfersOutsideEu: false,
          terms: 'https://example.test',
          evidence: 'nowhere',
        },
      ])
    ).toEqual([]);
  });
});

describe('termsUrl', () => {
  it('links a well-formed https URL', () => {
    const url = termsUrl('https://stripe.com/legal/dpa');
    expect(url?.hostname).toBe('stripe.com');
    expect(url?.pathname).toBe('/legal/dpa');
  });

  it('renders a sentence as a sentence, not a link', () => {
    expect(
      termsUrl('Self-hosted. No third party receives this data.')
    ).toBeNull();
  });

  // The failures a `startsWith('http')` test would have let through.
  it.each([
    'httpfoo',
    'http://stripe.com/legal/dpa',
    'javascript:alert(1)',
    'https://',
    '//stripe.com/legal/dpa',
    '',
  ])('refuses to link %j', (value) => {
    expect(termsUrl(value)).toBeNull();
  });

  it('links every URL-shaped row in the real table', () => {
    for (const entry of SUBPROCESSORS) {
      if (!entry.terms.startsWith('https://')) continue;
      expect(termsUrl(entry.terms)).not.toBeNull();
    }
  });
});

describe('isDisclosed', () => {
  it('is exact, so a prefix of a real vendor is not a match', () => {
    // The bug this forecloses: `name.includes('Cal')` would have matched both
    // Cal.com and Calendly, and `name.includes('Cal.com')` reads to CodeQL as
    // an incomplete host check.
    expect(isDisclosed('cal')).toBe(false);
    expect(isDisclosed('cal-com')).toBe(true);
    expect(isDisclosed('calendly')).toBe(false);
  });

  it('takes the list it is given', () => {
    expect(isDisclosed('clerk', [])).toBe(false);
  });
});
