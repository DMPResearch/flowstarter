/**
 * The booking URL builder, including every way it is allowed to have no answer.
 *
 * The two things worth being strict about are both here: a configured value
 * that is not a booking page must yield null rather than an embedded 404, and
 * "no Cal.com in this environment" must be a supported state rather than a
 * crash, because that is a laptop and a fresh deploy.
 */
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_CALL_HANDLE,
  DISCOVERY_CALL_PATH,
  DISCOVERY_CALL_SLUG,
  discoveryCallBookingUrl,
  discoveryCallEmbedSrc,
  discoveryCallUrl,
  isDiscoveryCallConfigured,
  type DiscoveryCallEnv,
} from '../discovery-call';

const SELF_HOSTED: DiscoveryCallEnv = {
  CAL_BASE_URL: 'https://cal.flowstarter.dev',
};

describe('discoveryCallUrl', () => {
  it('defaults to Darius’s event type on the platform’s own Cal.com', () => {
    expect(discoveryCallUrl(SELF_HOSTED)).toBe(
      `https://cal.flowstarter.dev/${DISCOVERY_CALL_HANDLE}/${DISCOVERY_CALL_SLUG}`
    );
  });

  it('tolerates a trailing slash on CAL_BASE_URL', () => {
    expect(
      discoveryCallUrl({ CAL_BASE_URL: 'https://cal.flowstarter.dev/' })
    ).toBe(
      `https://cal.flowstarter.dev/${DISCOVERY_CALL_HANDLE}/${DISCOVERY_CALL_SLUG}`
    );
  });

  it('is null when nothing is configured', () => {
    expect(discoveryCallUrl({})).toBeNull();
    expect(isDiscoveryCallConfigured({})).toBe(false);
  });

  it('prefers an explicit DMPRESEARCH_DISCOVERY_CAL_URL, on its own host', () => {
    expect(
      discoveryCallUrl({
        CAL_BASE_URL: 'https://cal.flowstarter.dev',
        DMPRESEARCH_DISCOVERY_CAL_URL:
          'https://cal.dmpresearch.com/darius/scoping',
      })
    ).toBe('https://cal.dmpresearch.com/darius/scoping');
  });

  it('accepts the explicit value with no CAL_BASE_URL at all', () => {
    expect(
      discoveryCallUrl({
        DMPRESEARCH_DISCOVERY_CAL_URL:
          'https://cal.flowstarter.dev/darius/discovery-call',
      })
    ).toBe('https://cal.flowstarter.dev/darius/discovery-call');
  });

  it('refuses an explicit value that is not a booking page', () => {
    const bad = [
      'http://cal.flowstarter.dev/darius/discovery-call', // not https
      'https://cal.flowstarter.dev/settings', // a reserved segment
      'https://cal.flowstarter.dev/a/b/c', // three segments deep
      'https://cal.flowstarter.dev/', // no handle
      'not a url at all',
    ];
    for (const value of bad) {
      expect(
        discoveryCallUrl({ DMPRESEARCH_DISCOVERY_CAL_URL: value })
      ).toBeNull();
    }
  });
});

describe('discoveryCallBookingUrl', () => {
  it('prefills the visitor’s name and email', () => {
    const url = new URL(
      discoveryCallBookingUrl(
        { name: 'Sarah Smith', email: 'sarah@example.com' },
        SELF_HOSTED
      )!
    );
    expect(url.searchParams.get('name')).toBe('Sarah Smith');
    expect(url.searchParams.get('email')).toBe('sarah@example.com');
    expect(url.pathname).toBe(
      `/${DISCOVERY_CALL_HANDLE}/${DISCOVERY_CALL_SLUG}`
    );
  });

  it('omits a field the visitor never gave rather than sending an empty one', () => {
    const url = new URL(
      discoveryCallBookingUrl(
        { name: '  ', email: 'x@example.com' },
        SELF_HOSTED
      )!
    );
    expect(url.searchParams.has('name')).toBe(false);
    expect(url.searchParams.get('email')).toBe('x@example.com');
  });

  it('escapes a name that would otherwise break the query string', () => {
    const url = new URL(
      discoveryCallBookingUrl({ name: 'A & B?x=1' }, SELF_HOSTED)!
    );
    expect(url.searchParams.get('name')).toBe('A & B?x=1');
  });

  it('is null, not a broken link, when there is no booking page', () => {
    expect(discoveryCallBookingUrl({ name: 'Sarah' }, {})).toBeNull();
    expect(discoveryCallEmbedSrc({ name: 'Sarah' }, {})).toBeNull();
  });
});

describe('discoveryCallEmbedSrc', () => {
  it('points at Cal’s embed and keeps the prefill', () => {
    const url = new URL(
      discoveryCallEmbedSrc({ email: 'sarah@example.com' }, SELF_HOSTED)!
    );
    expect(url.pathname).toBe(
      `/${DISCOVERY_CALL_HANDLE}/${DISCOVERY_CALL_SLUG}/embed`
    );
    expect(url.searchParams.get('email')).toBe('sarah@example.com');
    expect(url.searchParams.get('layout')).toBe('month_view');
  });
});

describe('DISCOVERY_CALL_PATH', () => {
  it('is the route the marketing copy links to', () => {
    expect(DISCOVERY_CALL_PATH).toBe('/discovery-call');
  });
});
