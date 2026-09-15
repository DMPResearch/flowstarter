import { describe, expect, it } from 'vitest';

import {
  HOSTED_CAL_FRAME_ORIGINS,
  calEmbedOrigins,
} from '../src/embed-origins';

describe('calEmbedOrigins', () => {
  it('always keeps the hosted cal.com entries', () => {
    // The Astro templates embed a client's own cal.com booking link, which is
    // not named by any environment variable.
    expect(calEmbedOrigins({})).toEqual([...HOSTED_CAL_FRAME_ORIGINS]);
  });

  it('adds the instance CAL_BASE_URL names, as an origin', () => {
    expect(
      calEmbedOrigins({ CAL_BASE_URL: 'https://cal.flowstarter.dev/' }),
    ).toContain('https://cal.flowstarter.dev');
  });

  it('reduces a whole booking page to its origin', () => {
    // A CSP entry is an origin, not a URL. The path would silently match
    // nothing.
    expect(
      calEmbedOrigins({
        DMPRESEARCH_DISCOVERY_CAL_URL:
          'https://book.dmpresearch.com/darius/discovery-call?name=Ana',
      }),
    ).toContain('https://book.dmpresearch.com');
  });

  it('adds a bare hostname as https', () => {
    expect(calEmbedOrigins({ CAL_BASE_URL: 'cal.flowstarter.dev' })).toContain(
      'https://cal.flowstarter.dev',
    );
  });

  it('refuses anything that is not https', () => {
    expect(
      calEmbedOrigins({
        CAL_BASE_URL: 'http://cal.internal',
        DMPRESEARCH_DISCOVERY_CAL_URL: 'javascript:alert(1)',
      }),
    ).toEqual([...HOSTED_CAL_FRAME_ORIGINS]);
  });

  it('refuses a value that is not a URL at all', () => {
    expect(calEmbedOrigins({ CAL_BASE_URL: '   ' })).toEqual([
      ...HOSTED_CAL_FRAME_ORIGINS,
    ]);
  });

  it('lists each origin once, in a stable order', () => {
    // The CSP header must be the same string on every request.
    const origins = calEmbedOrigins({
      CAL_BASE_URL: 'https://cal.flowstarter.dev',
      DMPRESEARCH_DISCOVERY_CAL_URL:
        'https://cal.flowstarter.dev/darius/discovery-call',
    });
    expect(origins).toEqual([
      ...HOSTED_CAL_FRAME_ORIGINS,
      'https://cal.flowstarter.dev',
    ]);
  });

  it('does not add a second entry for cal.com itself', () => {
    expect(calEmbedOrigins({ CAL_BASE_URL: 'https://cal.com' })).toEqual([
      ...HOSTED_CAL_FRAME_ORIGINS,
    ]);
  });
});
