/**
 * Reading a bio off somebody's own page, and every reason not to.
 *
 * The assertion that matters most in this file is a negative one: an
 * unconsented link never reaches a fetch. Everything else here is about what
 * comes back and how it is labelled, and all of it is worthless if the first
 * one does not hold, because the product would then be quoting people who
 * never agreed to be read.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PersonLink } from '@flowstarter/agentic-codegen/src/flowstarter/person';
import {
  MIN_ABOUT_PARAGRAPH_CHARS,
  consentedUrls,
  personParagraphs,
  readSourcedBio,
} from '../person-source';

const NOW = new Date('2026-09-15T11:00:00.000Z');

const GITHUB_BIO =
  'Freelance product designer. Eleven years at it, four of them on my own, ' +
  'mostly untangling the screens people get stuck on.';

function link(
  kind: PersonLink['kind'],
  url: string,
  consented: boolean
): PersonLink {
  return { kind, url, consented };
}

/**
 * A `fetch` that answers from a table and records every URL it was asked for.
 *
 * The recorder is the point: `calls` is what proves an unconsented link was
 * never requested, which is a property no assertion about the return value
 * can establish.
 */
function stubFetch(routes: Record<string, { status: number; body: string }>) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const route = routes[url];
    if (!route) {
      return new Response('', { status: 404 });
    }
    return new Response(route.body, {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    impl: impl as unknown as Parameters<typeof readSourcedBio>[0]['fetchImpl'],
    calls,
  };
}

describe('consent gates the whole feature', () => {
  it('reads nothing at all when no link was consented to', async () => {
    const { impl, calls } = stubFetch({});
    const bio = await readSourcedBio({
      links: [
        link('github', 'https://github.com/samokafor', false),
        link('website', 'https://samokafor.example', false),
      ],
      fullName: 'Sam Okafor',
      now: NOW,
      fetchImpl: impl,
    });
    expect(bio).toBeNull();
    expect(calls).toEqual([]);
  });

  it('never requests the page behind an unconsented link', async () => {
    const { impl, calls } = stubFetch({
      'https://api.github.com/users/samokafor': {
        status: 200,
        body: JSON.stringify({ bio: GITHUB_BIO }),
      },
    });
    await readSourcedBio({
      links: [
        link('github', 'https://github.com/samokafor', true),
        // Offered for the footer, not offered for reading.
        link('website', 'https://samokafor.example', false),
      ],
      fullName: 'Sam Okafor',
      now: NOW,
      fetchImpl: impl,
    });
    expect(calls.some((url) => url.includes('samokafor.example'))).toBe(false);
  });

  it('lists only the consented urls', () => {
    expect(
      consentedUrls([
        link('github', 'https://github.com/x', true),
        link('website', 'https://example.com', false),
        link('linkedin', '  ', true),
      ])
    ).toEqual(['https://github.com/x']);
  });
});

describe('what comes back is a proposal with a source', () => {
  it('reads a GitHub bio and files where it came from', async () => {
    const { impl } = stubFetch({
      'https://api.github.com/users/samokafor': {
        status: 200,
        body: JSON.stringify({ bio: GITHUB_BIO }),
      },
    });
    const bio = await readSourcedBio({
      links: [link('github', 'https://github.com/samokafor', true)],
      fullName: 'Sam Okafor',
      now: NOW,
      fetchImpl: impl,
    });
    expect(bio).not.toBeNull();
    // Verbatim. Nothing rewrites, summarises or improves a person's own line.
    expect(bio?.excerpt).toBe(GITHUB_BIO);
    expect(bio?.source).toBe('github-bio');
    // The page a client can click, not the API endpoint they cannot check.
    expect(bio?.sourceUrl).toBe('https://github.com/samokafor');
    expect(bio?.fetchedAt).toBe(NOW.toISOString());
    // The whole feature: found, never adopted.
    expect(bio?.adoptedAt).toBeNull();
  });

  it('declines a bio that is only a job title', async () => {
    const { impl } = stubFetch({
      'https://api.github.com/users/samokafor': {
        status: 200,
        body: JSON.stringify({ bio: 'Designer.' }),
      },
    });
    const bio = await readSourcedBio({
      links: [link('github', 'https://github.com/samokafor', true)],
      fullName: 'Sam Okafor',
      now: NOW,
      fetchImpl: impl,
    });
    expect(bio).toBeNull();
  });

  it('answers null rather than throwing when a source is down', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const bio = await readSourcedBio({
      links: [link('github', 'https://github.com/samokafor', true)],
      fullName: 'Sam Okafor',
      now: NOW,
      fetchImpl: impl as never,
    });
    expect(bio).toBeNull();
  });
});

describe('personParagraphs', () => {
  const ABOUT =
    '<html><body><nav>Home About</nav>' +
    '<h1>About Sam Okafor</h1>' +
    '<p>I spent six years inside product teams before going out on my own, ' +
    'which is why I would rather read a support queue than run a workshop.</p>' +
    '<p>These days I work with four or five teams a year, mostly on the ' +
    'screens their own users keep getting stuck on.</p>' +
    '<p>Short.</p>' +
    '</body></html>';

  it('takes the prose off a page that names the person', () => {
    const excerpt = personParagraphs(ABOUT, 'Sam Okafor');
    expect(excerpt).toContain('I spent six years inside product teams');
    expect(excerpt).toContain('four or five teams a year');
  });

  it('refuses a page that never names them', () => {
    // An agency's about page, a template's demo text, or the wrong site.
    // Quoting any of those back to a client as "your bio" is worse than
    // showing them nothing.
    expect(personParagraphs(ABOUT, 'Maria Ionescu')).toBe('');
  });

  it('skips captions and nav labels', () => {
    const excerpt = personParagraphs(ABOUT, 'Sam Okafor');
    expect(excerpt).not.toContain('Short.');
    expect(MIN_ABOUT_PARAGRAPH_CHARS).toBeGreaterThan('Short.'.length);
  });

  it('ignores scripts and styles', () => {
    const noisy =
      '<html><body><script>var about="Sam Okafor is a fraud"</script>' +
      ABOUT +
      '</body></html>';
    expect(personParagraphs(noisy, 'Sam Okafor')).not.toContain('fraud');
  });

  it('refuses a page with nothing long enough to be a bio', () => {
    expect(
      personParagraphs(
        '<html><body><h1>Sam Okafor</h1><p>Hello.</p></body></html>',
        'Sam Okafor'
      )
    ).toBe('');
  });
});
