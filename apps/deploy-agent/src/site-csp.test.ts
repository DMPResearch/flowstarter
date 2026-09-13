import { describe, expect, test } from 'bun:test';
import {
  applySiteSecurityHeaders,
  buildSiteCsp,
  buildSiteSecurityHeaders,
  renderCaddyHeaderLines,
  SITE_HEADERS_PLACEHOLDER,
  SiteHeadersError,
  type SiteCspInput,
} from './site-csp';

const PLATFORM = 'https://flowstarter.dev';

function input(overrides: Partial<SiteCspInput> = {}): SiteCspInput {
  return {
    platformOrigin: PLATFORM,
    inlineScriptHashes: [
      'aaaabbbbccccddddeeeeffff00001111222233334444555566667777',
    ],
    frameOrigins: [],
    frameAncestors: [],
    styleOrigins: ['https://fonts.googleapis.com'],
    ...overrides,
  };
}

/** The policy as a map, so a test asserts about one directive at a time. */
function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split('; ').map((part) => {
      const [name, ...sources] = part.split(' ');
      return [name!, sources];
    }),
  );
}

describe('buildSiteCsp', () => {
  test('allows the site itself and every managed inline block, and nothing else', () => {
    const csp = directives(buildSiteCsp(input()));
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual([
      "'self'",
      "'sha256-aaaabbbbccccddddeeeeffff00001111222233334444555566667777'",
    ]);
    expect(csp.get('script-src')).not.toContain("'unsafe-inline'");
    expect(csp.get('script-src')).not.toContain("'unsafe-eval'");
  });

  test('lets an enquiry reach the platform and nowhere else', () => {
    const csp = directives(buildSiteCsp(input()));
    expect(csp.get('connect-src')).toEqual(["'self'", PLATFORM]);
    expect(csp.get('form-action')).toEqual(["'self'", PLATFORM, 'mailto:']);
  });

  test('closes the doors a generated site never needs', () => {
    const csp = directives(buildSiteCsp(input()));
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('worker-src')).toEqual(["'none'"]);
    expect(csp.get('frame-src')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  });

  test('frames only what the artifact was found to frame', () => {
    const csp = directives(
      buildSiteCsp(
        input({ frameOrigins: ['https://cal.com', 'https://cal.com'] }),
      ),
    );
    expect(csp.get('frame-src')).toEqual(["'self'", 'https://cal.com']);
  });

  test('a preview may be framed by the funnel, and only by the funnel', () => {
    const csp = directives(buildSiteCsp(input({ frameAncestors: [PLATFORM] })));
    expect(csp.get('frame-ancestors')).toEqual([PLATFORM]);
  });

  test('serves a client photograph from wherever the client keeps it', () => {
    const csp = directives(buildSiteCsp(input()));
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'https:']);
    expect(csp.get('style-src')).toEqual([
      "'self'",
      "'unsafe-inline'",
      'https://fonts.googleapis.com',
    ]);
  });

  test('says nothing about the platform when none is configured', () => {
    const csp = directives(buildSiteCsp(input({ platformOrigin: null })));
    expect(csp.get('connect-src')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'", 'mailto:']);
  });
});

describe('buildSiteSecurityHeaders', () => {
  test('carries the four headers a served site needs', () => {
    const names = buildSiteSecurityHeaders(input()).map(
      (header) => header.name,
    );
    expect(names).toEqual([
      'Content-Security-Policy',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'X-Frame-Options',
    ]);
  });

  test('drops X-Frame-Options when something is meant to frame the site', () => {
    const names = buildSiteSecurityHeaders(
      input({ frameAncestors: [PLATFORM] }),
    ).map((header) => header.name);
    expect(names).not.toContain('X-Frame-Options');
  });
});

describe('applySiteSecurityHeaders', () => {
  const template = [
    ':8080 {',
    '\troot * /srv',
    `\t${SITE_HEADERS_PLACEHOLDER}`,
    '\tfile_server',
    '}',
    '',
  ].join('\n');

  test('replaces the placeholder, keeping its indentation', () => {
    const out = applySiteSecurityHeaders(
      template,
      buildSiteSecurityHeaders(input()),
    );
    expect(out).not.toContain(SITE_HEADERS_PLACEHOLDER);
    expect(out).toContain(
      "\theader Content-Security-Policy \"default-src 'self';",
    );
    expect(out).toContain('\theader X-Content-Type-Options "nosniff"');
    // Everything else about the template survives untouched.
    expect(out).toContain('\troot * /srv');
    expect(out).toContain('\tfile_server');
  });

  test('refuses a Caddyfile that has lost the placeholder', () => {
    expect(() =>
      applySiteSecurityHeaders(
        ':8080 {\n\troot * /srv\n\tfile_server\n}\n',
        buildSiteSecurityHeaders(input()),
      ),
    ).toThrow(SiteHeadersError);
  });

  test('escapes a quote rather than ending the Caddy string early', () => {
    const lines = renderCaddyHeaderLines(
      [{ name: 'X-Test', value: 'a "quoted" value' }],
      '  ',
    );
    expect(lines).toEqual(['  header X-Test "a \\"quoted\\" value"']);
  });
});

describe('the Caddyfile this repository ships', () => {
  test('still carries the placeholder the deploy agent fills in', async () => {
    const caddyfile = await Bun.file(
      new URL('../docker/site-runtime.Caddyfile', import.meta.url),
    ).text();
    expect(caddyfile).toContain(SITE_HEADERS_PLACEHOLDER);
    expect(() =>
      applySiteSecurityHeaders(caddyfile, buildSiteSecurityHeaders(input())),
    ).not.toThrow();
  });
});
