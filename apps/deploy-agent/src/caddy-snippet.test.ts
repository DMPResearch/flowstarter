import { describe, expect, test } from 'bun:test';
import {
  buildCaddySnippet,
  buildPreviewCaddySnippet,
  ROBOTS_HEADER,
} from './caddy-snippet';
import { buildSiteSecurityHeaders } from './site-csp';

const EDITOR_UPSTREAM = 'http://editor:3773';

describe('buildCaddySnippet (site, static filesystem target)', () => {
  test('returns empty string when there is no domain', () => {
    expect(
      buildCaddySnippet(
        'acme',
        { kind: 'static', rootDir: '/x' },
        null,
        [],
        null,
        EDITOR_UPSTREAM,
      ),
    ).toBe('');
  });

  test('lists primary, additional and preview hosts together', () => {
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/sites/acme' },
      'acme.com',
      ['www.acme.com'],
      'acme.preview.flowstarter.app',
      EDITOR_UPSTREAM,
    );
    expect(snippet).toContain(
      'acme.com, www.acme.com, acme.preview.flowstarter.app {',
    );
  });

  test('writes a real block for a site with only its final hostname', () => {
    // The common case for a paid site: no custom domain attached yet, so the
    // final hostname is the only name it has. Before `siteHost` existed this
    // produced an empty snippet and a site nobody could reach.
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/sites/acme' },
      null,
      [],
      null,
      EDITOR_UPSTREAM,
      'acme.flowstarter.net',
    );
    expect(snippet).toContain('acme.flowstarter.net {');
    expect(snippet).toContain('root * /var/www/sites/acme');
  });

  test('puts the final hostname ahead of the preview one', () => {
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/sites/acme' },
      'acme.com',
      ['www.acme.com'],
      'acme.preview.flowstarter.net',
      EDITOR_UPSTREAM,
      'acme.flowstarter.net',
    );
    expect(snippet).toContain(
      'acme.com, www.acme.com, acme.flowstarter.net, acme.preview.flowstarter.net {',
    );
  });

  test('does not repeat a host that is also the custom domain', () => {
    // Caddy refuses a block that names the same host twice, and a client is
    // free to point their own domain at the name we gave them.
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/sites/acme' },
      'acme.flowstarter.net',
      [],
      null,
      EDITOR_UPSTREAM,
      'ACME.flowstarter.net',
    );
    expect(snippet).toContain('acme.flowstarter.net {');
    expect(snippet).not.toContain('acme.flowstarter.net, ');
  });

  test('keeps the editor reverse-proxy route ahead of the site content', () => {
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/sites/acme' },
      'acme.com',
      [],
      null,
      EDITOR_UPSTREAM,
    );
    expect(snippet).toContain('handle_path /editor/*');
    expect(snippet).toContain(`reverse_proxy ${EDITOR_UPSTREAM} {`);
    expect(snippet.indexOf('handle_path /editor/*')).toBeLessThan(
      snippet.indexOf('handle {'),
    );
  });

  test('serves the static root with the =404 try_files fallback', () => {
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/sites/acme' },
      'acme.com',
      [],
      null,
      EDITOR_UPSTREAM,
    );
    expect(snippet).toContain('root * /var/www/sites/acme');
    expect(snippet).toContain('try_files {path} {path}/ =404');
    expect(snippet).not.toContain('/index.html');
    expect(snippet).toContain('file_server');
    expect(snippet).not.toContain('reverse_proxy 127.0.0.1');
  });

  test("an unknown path is answered by the site's own 404.html, not the home page", () => {
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/sites/acme' },
      'acme.com',
      [],
      null,
      EDITOR_UPSTREAM,
    );
    expect(snippet).toContain('handle_errors {');
    expect(snippet).toContain(
      '@404 expression `{http.error.status_code} == 404`',
    );
    expect(snippet).toContain('rewrite @404 /404.html');
    // handle_errors gets its own file_server so a shipped 404.html actually
    // serves; the outer file_server never sees the rewritten request.
    const errorBlock = snippet.slice(snippet.indexOf('handle_errors {'));
    expect(errorBlock).toContain('file_server');
  });
});

describe('buildCaddySnippet (site, docker proxy target)', () => {
  test('reverse-proxies to the loopback upstream instead of serving a root', () => {
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'proxy', upstream: '127.0.0.1:54321' },
      'acme.com',
      [],
      null,
      EDITOR_UPSTREAM,
    );
    expect(snippet).toContain('reverse_proxy 127.0.0.1:54321');
    expect(snippet).not.toContain('root *');
    expect(snippet).not.toContain('file_server');
  });

  test('still keeps the editor route untouched by the runtime choice', () => {
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'proxy', upstream: '127.0.0.1:54321' },
      'acme.com',
      [],
      null,
      EDITOR_UPSTREAM,
    );
    expect(snippet).toContain('handle_path /editor/*');
    expect(snippet).toContain(`reverse_proxy ${EDITOR_UPSTREAM} {`);
  });
});

describe('buildPreviewCaddySnippet', () => {
  test('returns empty string with no hostname', () => {
    expect(
      buildPreviewCaddySnippet(
        'acme',
        { kind: 'static', rootDir: '/x' },
        null,
        9080,
      ),
    ).toBe('');
  });

  test('static target: carries the noindex header and no editor route', () => {
    const snippet = buildPreviewCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/previews/acme' },
      'abc123.preview.flowstarter.net',
      9080,
    );
    expect(snippet).toContain('http://abc123.preview.flowstarter.net:9080 {');
    expect(snippet).toContain(`header X-Robots-Tag "${ROBOTS_HEADER}"`);
    expect(snippet).not.toContain('/editor');
    expect(snippet).toContain('root * /var/www/previews/acme');
  });

  test('static target: an unknown path 404s instead of falling back to the home page', () => {
    const snippet = buildPreviewCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/previews/acme' },
      'abc123.preview.flowstarter.net',
      9080,
    );
    expect(snippet).toContain('try_files {path} {path}/ =404');
    expect(snippet).not.toContain('/index.html');
    expect(snippet).toContain('handle_errors {');
    expect(snippet).toContain('rewrite @404 /404.html');
  });

  test('docker target: reverse-proxies but keeps the noindex header', () => {
    const snippet = buildPreviewCaddySnippet(
      'acme',
      { kind: 'proxy', upstream: '127.0.0.1:61000' },
      'abc123.preview.flowstarter.net',
      9080,
    );
    expect(snippet).toContain('reverse_proxy 127.0.0.1:61000');
    expect(snippet).toContain(`header X-Robots-Tag "${ROBOTS_HEADER}"`);
    expect(snippet).not.toContain('root *');
  });
});

describe('security headers on a filesystem deploy', () => {
  const headers = buildSiteSecurityHeaders({
    platformOrigin: 'https://flowstarter.dev',
    inlineScriptHashes: ['hash-one'],
    frameOrigins: ['https://cal.com'],
    frameAncestors: [],
    styleOrigins: ['https://fonts.googleapis.com'],
  });

  test('puts the policy on the site route and not on the editor route', () => {
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/sites/acme' },
      null,
      [],
      null,
      EDITOR_UPSTREAM,
      'acme.flowstarter.net',
      headers,
    );
    const editorBlock = snippet.slice(
      snippet.indexOf('handle_path /editor/*'),
      snippet.indexOf('# Site content'),
    );
    const siteBlock = snippet.slice(snippet.indexOf('# Site content'));
    expect(siteBlock).toContain(
      "header Content-Security-Policy \"default-src 'self';",
    );
    expect(siteBlock).toContain("script-src 'self' 'sha256-hash-one'");
    expect(siteBlock).toContain(
      'header Referrer-Policy "strict-origin-when-cross-origin"',
    );
    expect(editorBlock).not.toContain('Content-Security-Policy');
  });

  test('the 404 error response carries the same security headers as a real page', () => {
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/sites/acme' },
      null,
      [],
      null,
      EDITOR_UPSTREAM,
      'acme.flowstarter.net',
      headers,
    );
    const errorBlock = snippet.slice(snippet.indexOf('handle_errors {'));
    expect(errorBlock).toContain(
      "header Content-Security-Policy \"default-src 'self';",
    );
    expect(errorBlock).toContain(
      'header Referrer-Policy "strict-origin-when-cross-origin"',
    );
  });

  test('a site deployed without headers is unchanged from before', () => {
    const snippet = buildCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/sites/acme' },
      null,
      [],
      null,
      EDITOR_UPSTREAM,
      'acme.flowstarter.net',
    );
    expect(snippet).not.toContain('Content-Security-Policy');
  });

  test('a preview keeps its robots header and gains the policy', () => {
    const previewHeaders = buildSiteSecurityHeaders({
      platformOrigin: 'https://flowstarter.dev',
      inlineScriptHashes: [],
      frameOrigins: [],
      frameAncestors: ['https://flowstarter.dev'],
      styleOrigins: [],
    });
    const snippet = buildPreviewCaddySnippet(
      'acme',
      { kind: 'static', rootDir: '/var/www/previews/acme' },
      'acme-x1.preview.flowstarter.dev',
      9080,
      previewHeaders,
    );
    expect(snippet).toContain(`header X-Robots-Tag "${ROBOTS_HEADER}"`);
    expect(snippet).toContain('frame-ancestors https://flowstarter.dev');
    expect(snippet).not.toContain('X-Frame-Options');
  });
});
