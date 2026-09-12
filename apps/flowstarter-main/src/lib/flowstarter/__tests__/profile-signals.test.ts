import { describe, expect, it } from 'vitest';

import {
  MAX_BIO_CHARS,
  bioTextFrom,
  imageUrlsFrom,
  isPublicHttpUrl,
  parseProfileLinks,
  readProfileHtml,
  summariseProfileSignals,
  unavailableCopyKey,
  type ProfileReading,
} from '../profile-signals';

describe('isPublicHttpUrl', () => {
  it('accepts an ordinary https url', () => {
    expect(isPublicHttpUrl('https://instagram.com/darius.flowstarter')).toBe(
      true
    );
  });

  it('refuses plain http', () => {
    expect(isPublicHttpUrl('http://instagram.com/someone')).toBe(false);
  });

  it('refuses loopback and the private ranges', () => {
    for (const host of [
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://192.168.0.5/x',
      'https://169.254.169.254/latest/meta-data',
      'https://172.16.4.4/x',
      'https://0.0.0.0/x',
    ]) {
      expect(isPublicHttpUrl(host)).toBe(false);
    }
  });

  it('refuses credentials in the authority', () => {
    expect(isPublicHttpUrl('https://user:pass@instagram.com/x')).toBe(false);
  });

  it('refuses a string that is not a url at all', () => {
    expect(isPublicHttpUrl('not a url')).toBe(false);
  });
});

describe('parseProfileLinks', () => {
  it('reads all three networks', () => {
    const links = parseProfileLinks({
      instagramUrl: 'https://instagram.com/darius.flowstarter',
      linkedinUrl: 'https://www.linkedin.com/in/darius-popescu',
      websiteUrl: 'https://flowstarter.net',
    });
    expect(links.map((link) => link.network)).toEqual([
      'instagram',
      'linkedin',
      'website',
    ]);
  });

  it('pulls the handle out of each path shape', () => {
    const links = parseProfileLinks({
      instagramUrl: 'instagram.com/darius.flowstarter',
      linkedinUrl: 'linkedin.com/in/darius-popescu',
    });
    expect(links[0]?.handle).toBe('darius.flowstarter');
    expect(links[1]?.handle).toBe('darius-popescu');
  });

  it('reads a LinkedIn company page as well as a person', () => {
    const links = parseProfileLinks({
      linkedinUrl: 'https://linkedin.com/company/flowstarter',
    });
    expect(links[0]?.handle).toBe('flowstarter');
  });

  it('leaves the handle null when the path does not carry one', () => {
    const links = parseProfileLinks({
      linkedinUrl: 'https://linkedin.com/feed',
      websiteUrl: 'https://flowstarter.net/about',
    });
    expect(links.map((link) => link.handle)).toEqual([null, null]);
  });

  it('adds https to a bare host and upgrades http', () => {
    const links = parseProfileLinks({
      instagramUrl: 'instagram.com/someone',
      websiteUrl: 'http://flowstarter.net',
    });
    expect(links[0]?.url).toBe('https://instagram.com/someone');
    expect(links[1]?.url).toBe('https://flowstarter.net/');
  });

  it('drops a link that is on the wrong host for its field', () => {
    const links = parseProfileLinks({
      instagramUrl: 'https://instagram.com.evil.example/darius',
      linkedinUrl: 'https://not-linkedin.com/in/someone',
    });
    expect(links).toEqual([]);
  });

  it('accepts a subdomain of an allowed host', () => {
    const links = parseProfileLinks({
      instagramUrl: 'https://www.instagram.com/darius.flowstarter',
    });
    expect(links).toHaveLength(1);
  });

  it('refuses a website that points inside our own network', () => {
    expect(
      parseProfileLinks({ websiteUrl: 'https://169.254.169.254/' })
    ).toEqual([]);
  });

  it('ignores empty and missing fields', () => {
    expect(parseProfileLinks({})).toEqual([]);
    expect(
      parseProfileLinks({ instagramUrl: '   ', linkedinUrl: null })
    ).toEqual([]);
  });
});

const OG_PAGE = `<!doctype html><html><head>
  <title>Darius Popescu</title>
  <meta property="og:title" content="Darius Popescu, product studio" />
  <meta property="og:description" content="I build small, sharp software. Ereno and four other products." />
  <meta property="og:image" content="https://cdn.example.com/darius.jpg" />
</head><body></body></html>`;

describe('readProfileHtml', () => {
  it('reads the OpenGraph tags a page exposes', () => {
    const reading = readProfileHtml({
      network: 'website',
      url: 'https://flowstarter.net',
      status: 200,
      html: OG_PAGE,
    });
    expect(reading).toEqual({
      status: 'exposed',
      network: 'website',
      url: 'https://flowstarter.net',
      title: 'Darius Popescu, product studio',
      description:
        'I build small, sharp software. Ereno and four other products.',
      imageUrl: 'https://cdn.example.com/darius.jpg',
    });
  });

  it('falls back to the plain title and meta description', () => {
    const reading = readProfileHtml({
      network: 'website',
      url: 'https://flowstarter.net',
      status: 200,
      html: `<html><head><title>Ereno</title>
        <meta name="description" content="A calm inbox." /></head></html>`,
    });
    expect(reading).toMatchObject({
      status: 'exposed',
      title: 'Ereno',
      description: 'A calm inbox.',
      imageUrl: null,
    });
  });

  it('decodes entities and collapses whitespace', () => {
    const reading = readProfileHtml({
      network: 'website',
      url: 'https://flowstarter.net',
      status: 200,
      html: `<html><head><meta property="og:title" content="Bea &amp; Co.
          &#39;s   studio" /></head></html>`,
    });
    expect(reading).toMatchObject({ title: "Bea & Co. 's studio" });
  });

  it('reads a login wall that answers 200 as login_required', () => {
    // This is verbatim what instagram.com/<handle> returns to an anonymous
    // reader: a success code, no OpenGraph tags at all, and a title that is
    // the network's own name.
    const reading = readProfileHtml({
      network: 'instagram',
      url: 'https://instagram.com/darius.flowstarter',
      status: 200,
      html: '<!DOCTYPE html><html><head><title>Instagram</title></head><body><div id="react-root"></div></body></html>',
    });
    expect(reading).toEqual({
      status: 'unavailable',
      network: 'instagram',
      url: 'https://instagram.com/darius.flowstarter',
      reason: 'login_required',
    });
  });

  it('reads an empty body as login_required rather than a success', () => {
    expect(
      readProfileHtml({
        network: 'instagram',
        url: 'https://instagram.com/x',
        status: 200,
        html: '',
      })
    ).toMatchObject({ status: 'unavailable', reason: 'login_required' });
  });

  it.each([
    [401, 'blocked'],
    [403, 'blocked'],
    [429, 'blocked'],
    [999, 'blocked'],
    [404, 'not_found'],
    [410, 'not_found'],
    [500, 'server_error'],
    [503, 'server_error'],
    [418, 'blocked'],
  ])('maps status %i to %s', (status, reason) => {
    expect(
      readProfileHtml({
        network: 'linkedin',
        url: 'https://linkedin.com/in/x',
        status,
        html: OG_PAGE,
      })
    ).toMatchObject({ status: 'unavailable', reason });
  });

  it('ignores an og:image that is not a public https url', () => {
    const reading = readProfileHtml({
      network: 'website',
      url: 'https://flowstarter.net',
      status: 200,
      html: `<html><head><meta property="og:title" content="Ereno" />
        <meta property="og:image" content="http://127.0.0.1:9000/secret.png" /></head></html>`,
    });
    expect(reading).toMatchObject({ status: 'exposed', imageUrl: null });
  });

  it('resolves a relative og:image against the page url', () => {
    const reading = readProfileHtml({
      network: 'website',
      url: 'https://flowstarter.net/about',
      status: 200,
      html: `<html><head><meta property="og:title" content="Ereno" />
        <meta property="og:image" content="/img/hero.png" /></head></html>`,
    });
    expect(reading).toMatchObject({
      imageUrl: 'https://flowstarter.net/img/hero.png',
    });
  });

  it('handles single-quoted attributes', () => {
    const reading = readProfileHtml({
      network: 'website',
      url: 'https://flowstarter.net',
      status: 200,
      html: "<html><head><meta property='og:description' content='A calm inbox.' /></head></html>",
    });
    expect(reading).toMatchObject({ description: 'A calm inbox.' });
  });
});

describe('summarising', () => {
  const exposed: ProfileReading = {
    status: 'exposed',
    network: 'website',
    url: 'https://flowstarter.net',
    title: 'Ereno',
    description: 'A calm inbox for people who hate inboxes.',
    imageUrl: 'https://cdn.example.com/a.png',
  };
  const blocked: ProfileReading = {
    status: 'unavailable',
    network: 'linkedin',
    url: 'https://linkedin.com/in/x',
    reason: 'blocked',
  };
  const walled: ProfileReading = {
    status: 'unavailable',
    network: 'instagram',
    url: 'https://instagram.com/x',
    reason: 'login_required',
  };

  it('collects the prose a tone may be built from', () => {
    expect(bioTextFrom([exposed, blocked])).toBe(
      'A calm inbox for people who hate inboxes.'
    );
  });

  it('returns no prose when nothing was readable', () => {
    expect(bioTextFrom([blocked, walled])).toBe('');
  });

  it('caps the bio so a keyword-stuffed meta description cannot run away', () => {
    const long: ProfileReading = {
      ...exposed,
      description: 'word '.repeat(400),
    };
    expect(bioTextFrom([long]).length).toBeLessThanOrEqual(MAX_BIO_CHARS);
  });

  it('deduplicates image urls and keeps reading order', () => {
    const second: ProfileReading = {
      ...exposed,
      network: 'instagram',
      imageUrl: 'https://cdn.example.com/b.png',
    };
    expect(imageUrlsFrom([exposed, second, exposed])).toEqual([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
    ]);
  });

  it('reports every network it could not read, with the reason', () => {
    const signals = summariseProfileSignals([exposed, blocked, walled]);
    expect(signals.anyExposed).toBe(true);
    expect(signals.unavailable).toEqual([
      { network: 'linkedin', reason: 'blocked' },
      { network: 'instagram', reason: 'login_required' },
    ]);
  });

  it('says plainly that nothing was exposed when nothing was', () => {
    const signals = summariseProfileSignals([blocked, walled]);
    expect(signals.anyExposed).toBe(false);
    expect(signals.imageUrls).toEqual([]);
    expect(signals.bioText).toBe('');
  });

  it('gives every reason its own copy key', () => {
    expect(unavailableCopyKey('login_required')).toBe(
      'landing.discovery.brand.unavailable.login_required'
    );
  });
});
