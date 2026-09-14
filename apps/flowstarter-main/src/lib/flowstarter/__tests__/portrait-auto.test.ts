/**
 * The three automatic portrait sources, as rules, with no network anywhere.
 *
 * Two things are being pinned here and they fail in opposite directions.
 *
 * THE HANDLE READERS turn a string a visitor typed into a path in an outbound
 * request from our server. Everything they accept, we will fetch. So the tests
 * below spend most of their length on what is refused: every reserved word on
 * both networks, every shape of handle GitHub's own rule forbids, every host
 * that merely looks like the real one, and every URL that would take the
 * request somewhere private. A permissive handle reader is not a loose test,
 * it is a server side request forgery.
 *
 * THE PAGE READER decides whether a picture is the client's face. It fails the
 * other way: a false positive is a stranger's photograph, or a logo, on a site
 * somebody paid for. The `saysPerson` cases are therefore written from both
 * sides, and the two-letter-name case is the one that matters most, because
 * "Jo" matching the word "logo" is exactly the bug this rule is shaped to
 * prevent.
 *
 * The og:image fallback is tested as a feature rather than as a leftover. It
 * comes back with `saysPerson: false` on purpose so `portrait-source.ts` can
 * refuse it with `not_a_person` and the brief can tell the client what we
 * found and why we left it. Returning null instead would be silence.
 */
import { describe, expect, it } from 'vitest';

import {
  INSTAGRAM_CRAWLER_USER_AGENT,
  MIN_NAME_PART_CHARS,
  githubAvatarUrl,
  githubHandleFrom,
  instagramHandleFrom,
  instagramProfileUrl,
  nameAppearsIn,
  personImageFromHtml,
  websiteUrlFrom,
  type PortraitScanCaps,
} from '../portrait-auto';

const NAME = 'Darius Popescu';

/** Wide enough that the defaults never interfere with a small fixture. */
const CAPS: PortraitScanCaps = {
  maxHtmlBytes: 1_000_000,
  maxImgTags: 50,
  headingWindowChars: 2_000,
};

describe('INSTAGRAM_CRAWLER_USER_AGENT', () => {
  it('is the user agent Instagram documents, exactly', () => {
    expect(INSTAGRAM_CRAWLER_USER_AGENT).toBe('facebookexternalhit/1.1');
  });
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

describe('githubHandleFrom', () => {
  it('reads a plain profile link', () => {
    expect(githubHandleFrom(['https://github.com/darius'])).toBe('darius');
  });

  it('accepts www, http, a trailing slash, a query and no scheme at all', () => {
    for (const url of [
      'https://www.github.com/darius',
      'http://github.com/darius',
      'github.com/darius',
      'www.github.com/darius/',
      'https://github.com/darius?tab=repositories',
      'https://github.com/darius#readme',
      '  https://github.com/darius  ',
    ]) {
      expect(githubHandleFrom([url])).toBe('darius');
    }
  });

  it('takes the owner out of a repository link', () => {
    expect(githubHandleFrom(['https://github.com/darius/flowstarter'])).toBe(
      'darius'
    );
    expect(
      githubHandleFrom(['https://github.com/darius/flowstarter/blob/main/x.ts'])
    ).toBe('darius');
  });

  it('refuses every reserved path, alone or as an owner', () => {
    const reserved = [
      'orgs',
      'settings',
      'features',
      'about',
      'pricing',
      'marketplace',
      'explore',
      'topics',
      'collections',
      'events',
      'sponsors',
      'enterprise',
      'login',
      'join',
      'apps',
    ];
    for (const word of reserved) {
      expect(githubHandleFrom([`https://github.com/${word}`])).toBeNull();
      expect(githubHandleFrom([`https://github.com/${word}/acme`])).toBeNull();
      expect(
        githubHandleFrom([`https://github.com/${word.toUpperCase()}`])
      ).toBeNull();
    }
  });

  it("refuses handles GitHub's own rule forbids", () => {
    for (const handle of [
      '-darius',
      'darius-',
      'da--rius',
      'da_rius',
      'dari.us',
      'da rius',
      'a'.repeat(40),
    ]) {
      expect(githubHandleFrom([`https://github.com/${handle}`])).toBeNull();
    }
  });

  it('accepts the longest handle GitHub allows and one hyphen inside it', () => {
    expect(githubHandleFrom([`https://github.com/${'a'.repeat(39)}`])).toBe(
      'a'.repeat(39)
    );
    expect(githubHandleFrom(['https://github.com/da-rius'])).toBe('da-rius');
    expect(githubHandleFrom(['https://github.com/9darius'])).toBe('9darius');
  });

  it('refuses a host that only looks like GitHub', () => {
    for (const url of [
      'https://gist.github.com/darius',
      'https://github.com.evil.test/darius',
      'https://notgithub.com/darius',
      'https://github.co/darius',
    ]) {
      expect(githubHandleFrom([url])).toBeNull();
    }
  });

  it('refuses a bare host, a blank, and a string that is not a URL', () => {
    expect(githubHandleFrom(['https://github.com'])).toBeNull();
    expect(githubHandleFrom(['https://github.com/'])).toBeNull();
    expect(githubHandleFrom([''])).toBeNull();
    expect(githubHandleFrom(['   '])).toBeNull();
    expect(githubHandleFrom(['https://'])).toBeNull();
    expect(githubHandleFrom([])).toBeNull();
  });

  it('refuses an escaped separator smuggled into the first segment', () => {
    expect(githubHandleFrom(['https://github.com/%2F'])).toBeNull();
  });

  it('walks past the links that are not GitHub and takes the first that is', () => {
    expect(
      githubHandleFrom([
        'https://instagram.com/darius.flowstarter',
        'https://flowstarter.net',
        'https://github.com/darius',
        'https://github.com/someone-else',
      ])
    ).toBe('darius');
  });
});

describe('githubAvatarUrl', () => {
  it('asks for the avatar at the edge it was given', () => {
    expect(githubAvatarUrl('darius', 460)).toBe(
      'https://github.com/darius.png?size=460'
    );
  });

  it('escapes a handle rather than trusting one', () => {
    expect(githubAvatarUrl('a/b', 96)).toBe(
      'https://github.com/a%2Fb.png?size=96'
    );
  });
});

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

describe('instagramHandleFrom', () => {
  it('reads a handle, with dots and underscores in it', () => {
    expect(
      instagramHandleFrom(['https://www.instagram.com/darius.flowstarter/'])
    ).toBe('darius.flowstarter');
    expect(instagramHandleFrom(['instagram.com/darius_p'])).toBe('darius_p');
  });

  it('refuses the paths that are the product rather than a person', () => {
    for (const word of [
      'explore',
      'reels',
      'reel',
      'p',
      'tv',
      'stories',
      'accounts',
      'directory',
      'about',
      'developer',
      'legal',
      'privacy',
      'terms',
    ]) {
      expect(instagramHandleFrom([`https://instagram.com/${word}`])).toBeNull();
    }
  });

  it("refuses anything Instagram's own rule would not issue", () => {
    expect(
      instagramHandleFrom([`https://instagram.com/${'a'.repeat(31)}`])
    ).toBeNull();
    expect(instagramHandleFrom(['https://instagram.com/da-rius'])).toBeNull();
    expect(instagramHandleFrom(['https://instagram.com/'])).toBeNull();
    expect(instagramHandleFrom(['https://evil.test/darius'])).toBeNull();
    expect(instagramHandleFrom(['https://'])).toBeNull();
  });
});

describe('instagramProfileUrl', () => {
  it('is the public page and nothing else', () => {
    expect(instagramProfileUrl('darius.flowstarter')).toBe(
      'https://www.instagram.com/darius.flowstarter/'
    );
  });
});

// ---------------------------------------------------------------------------
// The client's own site
// ---------------------------------------------------------------------------

describe('websiteUrlFrom', () => {
  it('takes the first link that is the client rather than a network', () => {
    expect(
      websiteUrlFrom([
        'https://instagram.com/darius',
        'https://www.linkedin.com/in/darius',
        'https://github.com/darius',
        'https://flowstarter.net/about',
        'https://second-site.test',
      ])
    ).toBe('https://flowstarter.net/about');
  });

  it('adds a scheme and upgrades an http one', () => {
    expect(websiteUrlFrom(['flowstarter.net'])).toBe(
      'https://flowstarter.net/'
    );
    expect(websiteUrlFrom(['http://flowstarter.net'])).toBe(
      'https://flowstarter.net/'
    );
  });

  it('refuses every network we already have a named source for', () => {
    expect(
      websiteUrlFrom([
        'https://m.facebook.com/darius',
        'https://x.com/darius',
        'https://twitter.com/darius',
        'https://tiktok.com/@darius',
        'https://youtu.be/abc',
        'https://www.youtube.com/@darius',
        'https://threads.net/@darius',
        'https://pinterest.com/darius',
        'https://behance.net/darius',
        'https://dribbble.com/darius',
      ])
    ).toBeNull();
  });

  it('refuses a URL that would send the request somewhere private', () => {
    expect(websiteUrlFrom(['http://localhost:3000'])).toBeNull();
    expect(websiteUrlFrom(['https://192.168.1.5/'])).toBeNull();
    expect(websiteUrlFrom(['https://127.0.0.1/'])).toBeNull();
    expect(
      websiteUrlFrom(['https://169.254.169.254/latest/meta-data'])
    ).toBeNull();
    expect(websiteUrlFrom(['https://user:pass@flowstarter.net'])).toBeNull();
  });

  it('has nothing to say about an empty list or a broken string', () => {
    expect(websiteUrlFrom([])).toBeNull();
    expect(websiteUrlFrom([''])).toBeNull();
    expect(websiteUrlFrom(['https://'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Does this text name the client
// ---------------------------------------------------------------------------

describe('nameAppearsIn', () => {
  it('matches the whole name and any part long enough to mean something', () => {
    expect(nameAppearsIn('A photo of Darius Popescu', NAME)).toBe(true);
    expect(nameAppearsIn('Darius, founder', NAME)).toBe(true);
    expect(nameAppearsIn('POPESCU', NAME)).toBe(true);
    expect(nameAppearsIn('photo-of-darius-popescu', NAME)).toBe(true);
  });

  it('matches on whole words only', () => {
    expect(nameAppearsIn('dariusz kowalski', NAME)).toBe(false);
    expect(nameAppearsIn('popescus', NAME)).toBe(false);
  });

  it('will not match on a two-letter part of a name', () => {
    // The whole point of the floor. Without it "Jo" finds "logo" and the
    // company mark ends up in the portrait slot.
    expect(nameAppearsIn('Our logo', 'Jo Li')).toBe(false);
    expect(nameAppearsIn('li', 'Jo Li')).toBe(false);
    expect(MIN_NAME_PART_CHARS).toBe(3);
  });

  it('still matches a short name when the whole of it is there in order', () => {
    expect(nameAppearsIn('A photo of Jo Li at work', 'Jo Li')).toBe(true);
    expect(nameAppearsIn('Li Jo', 'Jo Li')).toBe(false);
  });

  it('reads through the entities a page writes names with', () => {
    expect(nameAppearsIn('Darius &amp; Popescu', NAME)).toBe(true);
    expect(nameAppearsIn('&quot;Darius&quot;', NAME)).toBe(true);
  });

  it('has nothing to match when either side is empty', () => {
    expect(nameAppearsIn('Darius Popescu', '')).toBe(false);
    expect(nameAppearsIn('', NAME)).toBe(false);
    expect(nameAppearsIn('---', NAME)).toBe(false);
  });

  it('does not match a name longer than the text it is looked for in', () => {
    expect(nameAppearsIn('Xx', 'Al Bo Cy')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The picture on the page
// ---------------------------------------------------------------------------

const BASE = 'https://flowstarter.net/about';

describe('personImageFromHtml', () => {
  it('takes the image whose alt text names the client', () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.test/social-card.png" />
    </head><body>
      <img src="https://cdn.test/logo.png" alt="Flowstarter" />
      <img src="https://cdn.test/darius.jpg" alt="Darius Popescu, founder" />
    </body></html>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toEqual({ url: 'https://cdn.test/darius.jpg', saysPerson: true });
  });

  it('takes an image in an about section under a heading with the name on it', () => {
    const html = `<body>
      <section id="clients"><h2>Our clients</h2>
        <img src="https://cdn.test/client.png" alt="A client" /></section>
      <section class="about-me">
        <h2>Darius Popescu</h2>
        <img src="https://cdn.test/me.jpg" alt="" />
      </section>
    </body>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toEqual({ url: 'https://cdn.test/me.jpg', saysPerson: true });
  });

  it('accepts a data-testid as the section name, and single quotes on attributes', () => {
    const html = `<body><div data-testid='founder-card'>
      <h3>Darius Popescu</h3>
      <img src='https://cdn.test/me.jpg' alt='' />
    </div></body>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toEqual({ url: 'https://cdn.test/me.jpg', saysPerson: true });
  });

  it('will not take a section image when the heading does not name the client', () => {
    const html = `<body>
      <meta property="og:image" content="https://cdn.test/card.png" />
      <section class="about"><h2>About the studio</h2>
        <img src="https://cdn.test/studio.jpg" alt="The studio" /></section>
    </body>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toEqual({ url: 'https://cdn.test/card.png', saysPerson: false });
  });

  it('will not take a named heading when the section is not about a person', () => {
    const html = `<body>
      <section id="press"><h2>Darius Popescu in the news</h2>
        <img src="https://cdn.test/press.jpg" alt="" /></section>
    </body>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toBeNull();
  });

  it('falls back to the og:image, and says it is not a person', () => {
    const html = `<head><meta property="og:image" content="/card.png" /></head>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toEqual({ url: 'https://flowstarter.net/card.png', saysPerson: false });
  });

  it('has nothing when the page has neither a named image nor an og:image', () => {
    const html = `<body><img src="https://cdn.test/logo.png" alt="Flowstarter" /></body>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toBeNull();
    expect(
      personImageFromHtml({
        html: '',
        baseUrl: BASE,
        fullName: NAME,
        caps: CAPS,
      })
    ).toBeNull();
  });

  it('skips an img with no src at all', () => {
    const html = `<body>
      <img alt="Darius Popescu" />
      <img src="" alt="Darius Popescu" />
      <img src="https://cdn.test/darius.jpg" alt="Darius Popescu" />
    </body>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toEqual({ url: 'https://cdn.test/darius.jpg', saysPerson: true });
  });

  it('resolves a relative src against the page it came from', () => {
    const html = `<body><img src="../img/darius.jpg" alt="Darius Popescu" /></body>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toEqual({
      url: 'https://flowstarter.net/img/darius.jpg',
      saysPerson: true,
    });
  });

  it('refuses an http src, a private src, and a src that is not a URL', () => {
    for (const src of [
      'http://cdn.test/darius.jpg',
      'https://192.168.0.9/darius.jpg',
      'https://localhost/darius.jpg',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'https://[',
    ]) {
      const html = `<body><img src="${src}" alt="Darius Popescu" /></body>`;
      expect(
        personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
      ).toBeNull();
    }
  });

  it('refuses an og:image that points somewhere private', () => {
    const html = `<head><meta property="og:image" content="http://169.254.169.254/x.png" /></head>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toBeNull();
  });

  it('ignores an og:image tag with no content and one with an empty one', () => {
    const html = `<head>
      <meta property="og:image" />
      <meta property="og:image" content="  " />
      <meta property="og:image" content="https://cdn.test/card.png" />
    </head>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toEqual({ url: 'https://cdn.test/card.png', saysPerson: false });
  });

  it('reads a lazy-loading data-src, and never reads it as the real src', () => {
    const html = `<body><img data-src="https://cdn.test/darius.jpg" alt="Darius Popescu" /></body>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME, caps: CAPS })
    ).toEqual({ url: 'https://cdn.test/darius.jpg', saysPerson: true });
  });

  it('stops after the capped number of img tags', () => {
    const filler = Array.from(
      { length: 5 },
      (_, index) => `<img src="https://cdn.test/${index}.png" alt="Filler" />`
    ).join('');
    const html = `<head><meta property="og:image" content="https://cdn.test/card.png" /></head>
      <body>${filler}<img src="https://cdn.test/darius.jpg" alt="Darius Popescu" /></body>`;

    expect(
      personImageFromHtml({
        html,
        baseUrl: BASE,
        fullName: NAME,
        caps: { ...CAPS, maxImgTags: 5 },
      })
    ).toEqual({ url: 'https://cdn.test/card.png', saysPerson: false });

    expect(
      personImageFromHtml({
        html,
        baseUrl: BASE,
        fullName: NAME,
        caps: { ...CAPS, maxImgTags: 6 },
      })
    ).toEqual({ url: 'https://cdn.test/darius.jpg', saysPerson: true });
  });

  it('stops after the capped number of characters', () => {
    const head = `<head><meta property="og:image" content="https://cdn.test/card.png" /></head>`;
    const html = `${head}<body><img src="https://cdn.test/darius.jpg" alt="Darius Popescu" /></body>`;
    expect(
      personImageFromHtml({
        html,
        baseUrl: BASE,
        fullName: NAME,
        caps: { ...CAPS, maxHtmlBytes: head.length },
      })
    ).toEqual({ url: 'https://cdn.test/card.png', saysPerson: false });
  });

  it('will not treat a heading a long way up the page as this image caption', () => {
    const html = `<section class="about"><h2>Darius Popescu</h2>
      ${'<p>filler</p>'.repeat(100)}
      <img src="https://cdn.test/far.jpg" alt="" /></section>`;
    expect(
      personImageFromHtml({
        html,
        baseUrl: BASE,
        fullName: NAME,
        caps: { ...CAPS, headingWindowChars: 100 },
      })
    ).toBeNull();
  });

  it('runs on the documented caps when none are handed to it', () => {
    const html = `<body><img src="https://cdn.test/darius.jpg" alt="Darius Popescu" /></body>`;
    expect(
      personImageFromHtml({ html, baseUrl: BASE, fullName: NAME })
    ).toEqual({ url: 'https://cdn.test/darius.jpg', saysPerson: true });
  });
});
