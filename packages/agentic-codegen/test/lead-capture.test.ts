/**
 * The site side of lead capture: `injectLeadCapture`.
 *
 * What matters here is not that a script appears. It is that the script is
 * inline (a bundled module would be hoisted out of the HTML by Astro and no
 * gate could ever prove the token shipped), that it carries this workspace's
 * token and nobody else's, that running the injector again updates the block
 * rather than stacking a second one, and that a build with no endpoint takes
 * a previous run's block back out instead of leaving a form posting at a
 * token that no longer resolves.
 *
 * The real templates are read off disk on purpose. A synthetic fixture would
 * keep passing after somebody edits `contact.astro` and removes the slot.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyIntegrationsToWorkspace,
  injectIntegrations,
  injectLeadCapture,
  normalizeLeadCaptureEndpoint,
  removeLeadCapture,
  type FileMap,
} from '../src/integrations';

const TEMPLATES_DIR = join(__dirname, '../../../apps/flowstarter-templates');
const ALL_TEMPLATES = [
  'wellness-therapy',
  'professional-services',
  'local-trade',
  'creative-portfolio',
  'dorin-portfolio',
];

const TOKEN = 'Kx9-_abcdefghijklmnopqrstuvwxyz0123456789AB';
const OTHER_TOKEN = 'Zz8-_zyxwvutsrqponmlkjihgfedcba9876543210CD';
const ENDPOINT = `https://flowstarter.net/api/leads/capture/${TOKEN}`;
const OTHER_ENDPOINT = `https://flowstarter.net/api/leads/capture/${OTHER_TOKEN}`;
const PREVIEW_ENDPOINT =
  'https://flowstarter.dev/api/leads/capture/preview.3a5b7c9d-1e2f-4a3b-8c5d-6e7f8a9b0c1d';

function readTemplateFile(template: string, rel: string): string {
  return readFileSync(join(TEMPLATES_DIR, template, rel), 'utf8');
}

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

// ── What counts as an endpoint ─────────────────────────────────────────────

describe('normalizeLeadCaptureEndpoint', () => {
  it('accepts the capture path on https', () => {
    expect(normalizeLeadCaptureEndpoint(ENDPOINT)).toBe(ENDPOINT);
    expect(normalizeLeadCaptureEndpoint(`  ${ENDPOINT}  `)).toBe(ENDPOINT);
    expect(normalizeLeadCaptureEndpoint(PREVIEW_ENDPOINT)).toBe(
      PREVIEW_ENDPOINT,
    );
  });

  it('refuses anything that is not one', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      'not a url',
      `http://flowstarter.net/api/leads/capture/${TOKEN}`,
      'https://flowstarter.net/api/leads/capture/',
      `https://flowstarter.net/api/leads/capture/${TOKEN}/extra`,
      'https://flowstarter.net/anything-else',
      `https://flowstarter.net/api/leads/capture/${TOKEN}?to=evil`,
      `https://flowstarter.net/api/leads/capture/${TOKEN}#x`,
    ]) {
      expect(normalizeLeadCaptureEndpoint(bad)).toBeNull();
    }
  });
});

// ── Real templates ─────────────────────────────────────────────────────────

describe('injectLeadCapture — real templates under apps/flowstarter-templates', () => {
  it.each(ALL_TEMPLATES)(
    '%s: emits an inline script carrying this workspace token',
    (template) => {
      const rel = 'src/pages/contact.astro';
      const files: FileMap = { [rel]: readTemplateFile(template, rel) };
      const out = injectLeadCapture(files, ENDPOINT);
      const html = out[rel]!;

      expect(count(html, 'data-flowstarter-lead-capture="true"')).toBe(1);
      // Inline, or Astro hoists it into _astro/*.js and the token never
      // appears in the built HTML at all.
      expect(html).toContain('<script is:inline>');
      expect(html).toContain(ENDPOINT);
      expect(html).toContain("querySelector('[data-contact-form]')");
      // The flag the template's own mailto handler stands down on.
      expect(html).toContain("form.setAttribute('data-lead-capture', 'on')");
      // The slot it replaced is gone, not doubled.
      expect(html).not.toContain('data-flowstarter-lead-capture-slot');
      // And the page is otherwise intact.
      expect(html).toContain('<ContactFormPanel');
      expect(html).toContain('</main>');
    },
  );

  it.each(ALL_TEMPLATES)(
    '%s: ships the slot the injector fills',
    (template) => {
      expect(readTemplateFile(template, 'src/pages/contact.astro')).toContain(
        'data-flowstarter-lead-capture-slot',
      );
    },
  );

  it.each(ALL_TEMPLATES)(
    '%s: ships the honeypot and both result lines',
    (template) => {
      const panel = readTemplateFile(
        template,
        'src/components/contact/ContactFormPanel.astro',
      );
      expect(panel).toContain('name="company_website"');
      expect(panel).toContain('data-contact-sent');
      expect(panel).toContain('data-contact-error');
      // The mailto fallback the script falls back to.
      expect(panel).toContain('action={mailtoAction}');
    },
  );

  it.each(ALL_TEMPLATES)(
    '%s: the mailto handler stands down when capture is on',
    (template) => {
      const hook = readTemplateFile(
        template,
        'src/scripts/hooks/useFormSuccess.js',
      );
      expect(hook).toContain("form.dataset.leadCapture === 'on'");
    },
  );

  it('is idempotent, and a second token replaces the first in place', () => {
    const rel = 'src/pages/contact.astro';
    const files: FileMap = {
      [rel]: readTemplateFile('creative-portfolio', rel),
    };
    const once = injectLeadCapture(files, ENDPOINT);
    const twice = injectLeadCapture(once, ENDPOINT);
    expect(twice[rel]).toBe(once[rel]);

    const rotated = injectLeadCapture(once, OTHER_ENDPOINT);
    expect(count(rotated[rel]!, 'data-flowstarter-lead-capture="true"')).toBe(
      1,
    );
    expect(rotated[rel]).toContain(OTHER_ENDPOINT);
    expect(rotated[rel]).not.toContain(ENDPOINT);
  });

  it('upgrades a preview token to the paid one, leaving one block', () => {
    const rel = 'src/pages/contact.astro';
    const files: FileMap = {
      [rel]: readTemplateFile('local-trade', rel),
    };
    const preview = injectLeadCapture(files, PREVIEW_ENDPOINT);
    expect(preview[rel]).toContain('preview.3a5b7c9d');

    const paid = injectLeadCapture(preview, ENDPOINT);
    expect(count(paid[rel]!, 'data-flowstarter-lead-capture="true"')).toBe(1);
    expect(paid[rel]).toContain(ENDPOINT);
    expect(paid[rel]).not.toContain('preview.3a5b7c9d');
  });
});

// ── Built HTML ─────────────────────────────────────────────────────────────

describe('injectLeadCapture — built output', () => {
  const built = [
    '<html><body><main>',
    '<form data-contact-form action="mailto:hi@example.com"></form>',
    '<div class="contact-page__lead-capture" data-flowstarter-lead-capture-slot></div>',
    '</main></body></html>',
  ].join('\n');

  it('writes a plain script into contact/index.html', () => {
    const out = injectLeadCapture({ 'contact/index.html': built }, ENDPOINT);
    const html = out['contact/index.html']!;
    expect(html).toContain('<script>');
    expect(html).not.toContain('is:inline');
    expect(html).toContain(ENDPOINT);
  });

  it('hangs the block off </main> when there is no slot', () => {
    const noSlot =
      '<html><body><main><form data-contact-form></form></main></body></html>';
    const out = injectLeadCapture({ 'contact.html': noSlot }, ENDPOINT);
    expect(out['contact.html']).toContain(
      'data-flowstarter-lead-capture="true"',
    );
    expect(out['contact.html']).toContain('</main>');
  });

  it('leaves a tree with no contact page alone', () => {
    const files: FileMap = { 'src/pages/index.astro': '<p>hi</p>' };
    expect(injectLeadCapture(files, ENDPOINT)).toBe(files);
  });

  it('prefers the .astro source over the built copy', () => {
    const files: FileMap = {
      'src/pages/contact.astro': '<main><form data-contact-form></form></main>',
      'contact/index.html': built,
    };
    const out = injectLeadCapture(files, ENDPOINT);
    expect(out['src/pages/contact.astro']).toContain(ENDPOINT);
    expect(out['contact/index.html']).toBe(built);
  });
});

// ── Removal ────────────────────────────────────────────────────────────────

describe('no endpoint removes rather than no-ops', () => {
  it('takes a previous run block back out of every file', () => {
    const rel = 'src/pages/contact.astro';
    const injected = injectLeadCapture(
      { [rel]: readTemplateFile('wellness-therapy', rel) },
      ENDPOINT,
    );
    const removed = injectLeadCapture(injected, null);
    expect(removed[rel]).not.toContain('data-flowstarter-lead-capture="true"');
    expect(removed[rel]).not.toContain(ENDPOINT);
    expect(removed[rel]).toContain('</main>');
  });

  it('removes a block that landed on a page the candidate list does not name', () => {
    const files: FileMap = {
      'about/index.html':
        '<div data-flowstarter-lead-capture="true"><script>1</script></div>',
    };
    const out = removeLeadCapture(files);
    expect(out['about/index.html']).toBe('');
  });

  it('returns the same object when there is nothing to remove', () => {
    const files: FileMap = { 'a.html': '<p>nothing</p>' };
    expect(removeLeadCapture(files)).toBe(files);
    expect(injectLeadCapture(files, 'not a url')).toBe(files);
  });
});

// ── Through injectIntegrations ─────────────────────────────────────────────

describe('injectIntegrations', () => {
  const rel = 'src/pages/contact.astro';
  const page =
    '<main><form data-contact-form></form><div data-flowstarter-lead-capture-slot></div></main>';

  it('runs lead capture when the key is present', () => {
    const out = injectIntegrations(
      { [rel]: page },
      { leadCapture: { endpoint: ENDPOINT } },
    );
    expect(out[rel]).toContain(ENDPOINT);
  });

  it('removes when the key is present with no endpoint', () => {
    const injected = injectIntegrations(
      { [rel]: page },
      { leadCapture: { endpoint: ENDPOINT } },
    );
    const out = injectIntegrations(injected, {
      leadCapture: { endpoint: null },
    });
    expect(out[rel]).not.toContain('data-flowstarter-lead-capture="true"');
  });

  it('does nothing at all when the key is absent', () => {
    const files: FileMap = { [rel]: page };
    expect(injectIntegrations(files, {})).toBe(files);
  });
});

// ── On disk ────────────────────────────────────────────────────────────────

describe('applyIntegrationsToWorkspace', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes the contact page, which is not a booking candidate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lead-capture-'));
    dirs.push(dir);
    await mkdir(join(dir, 'src/pages'), { recursive: true });
    await writeFile(
      join(dir, 'src/pages/contact.astro'),
      readTemplateFile('creative-portfolio', 'src/pages/contact.astro'),
      'utf8',
    );

    const result = await applyIntegrationsToWorkspace(dir, {
      leadCapture: { endpoint: ENDPOINT },
    });
    expect(result.applied).toBe(true);
    expect(result.changedPaths).toContain('src/pages/contact.astro');

    const written = await readFile(
      join(dir, 'src/pages/contact.astro'),
      'utf8',
    );
    expect(written).toContain(ENDPOINT);
  });

  it('is a no-op on a directory with no candidate pages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lead-capture-'));
    dirs.push(dir);
    const result = await applyIntegrationsToWorkspace(dir, {
      leadCapture: { endpoint: ENDPOINT },
    });
    expect(result).toEqual({ applied: false, changedPaths: [] });
  });
});
