/**
 * The one test that proves the whole site side actually reaches a browser.
 *
 * Every other assertion about lead capture is made over strings. That is worth
 * having and it is not enough: the thing that could quietly break this feature
 * is Astro, not us. A bundled `<script>` is hoisted into `_astro/*.js` and
 * disappears from the HTML, `is:inline` is what stops that, and no string test
 * over the source can tell the difference. So this one copies a real template,
 * runs the real `astro build`, and reads the real `dist/contact/index.html`.
 *
 * Two endpoint shapes are built, not one. A prior version of this file only
 * ever exercised a production-shaped `https://flowstarter.net/...` endpoint,
 * which `normalizeLeadCaptureEndpoint` always accepted — so it kept passing
 * while every *real* local build silently lost its contact form, because
 * `publicAppOrigin()` (`@flowstarter/platform-config`) correctly answers
 * `http://localhost:{PORT}` in development, and that shape was being refused.
 * The dev case here is what `leadCaptureEndpointFor()`
 * (`apps/build-worker/src/job-store.ts`) and the funnel preview's
 * `previewLeadCaptureEndpoint()` (`apps/flowstarter-main`) actually hand the
 * injector on a laptop or in CI, so this is the shape a real end-to-end run
 * exercises — the one the bug report was filed against.
 *
 * It is skipped, loudly, when the template has no `node_modules` - a developer
 * who has not installed the workspace should get a skip with a reason, not a
 * failure about a missing binary.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { applyIntegrationsToWorkspace } from '../src/integrations';

const run = promisify(execFile);

const TEMPLATE = 'creative-portfolio';
const TEMPLATE_DIR = join(
  __dirname,
  '../../../apps/flowstarter-templates',
  TEMPLATE,
);
const ASTRO_BIN = join(TEMPLATE_DIR, 'node_modules/.bin/astro');
const TOKEN = 'Kx9-_abcdefghijklmnopqrstuvwxyz0123456789AB';

const installed = existsSync(ASTRO_BIN);

const SCENARIOS = [
  {
    name: 'a production-shaped endpoint (publicAppOrigin() in production/staging)',
    endpoint: `https://flowstarter.net/api/leads/capture/${TOKEN}`,
  },
  {
    name: 'a dev-shaped endpoint (publicAppOrigin() on a laptop with nothing overridden)',
    endpoint: `http://localhost:3000/api/leads/capture/${TOKEN}`,
  },
] as const;

describe.skipIf(!installed).each(SCENARIOS)(
  'a built template carries the capture script and this workspace token — $name',
  ({ endpoint }) => {
    let workspace = '';
    let html = '';

    beforeAll(async () => {
      workspace = await mkdtemp(join(tmpdir(), 'lead-capture-build-'));
      await cp(TEMPLATE_DIR, workspace, {
        recursive: true,
        filter: (source) =>
          !source.includes(`${TEMPLATE}/node_modules`) &&
          !source.includes(`${TEMPLATE}/dist`) &&
          !source.includes(`${TEMPLATE}/.astro`),
      });
      // Astro resolves from the project root, so the copy borrows the
      // template's own installed tree rather than running an install here.
      await symlink(
        join(TEMPLATE_DIR, 'node_modules'),
        join(workspace, 'node_modules'),
        'dir',
      );

      const applied = await applyIntegrationsToWorkspace(workspace, {
        booking: { provider: 'cal.com', url: null },
        leadCapture: { endpoint },
      });
      expect(applied.changedPaths).toContain('src/pages/contact.astro');

      await run(ASTRO_BIN, ['build'], { cwd: workspace });
      html = await readFile(join(workspace, 'dist/contact/index.html'), 'utf8');
    }, 180_000);

    afterAll(async () => {
      if (workspace) await rm(workspace, { recursive: true, force: true });
    });

    it('emits the script inline, in the HTML itself', () => {
      expect(html).toContain('data-flowstarter-lead-capture="true"');
      expect(html).toContain('<script>');
      expect(html).toContain(endpoint);
      // The proof the marker is not just a src attribute somewhere.
      expect(html).toContain("querySelector('[data-contact-form]')");
    });

    it('emits the form with its mailto fallback and the honeypot', () => {
      expect(html).toContain('data-contact-form');
      expect(html).toMatch(/action="mailto:[^"]+"/);
      expect(html).toContain('name="company_website"');
    });

    it('emits both result lines, hidden until the script shows one', () => {
      expect(html).toContain('data-contact-sent');
      expect(html).toContain('data-contact-error');
    });

    it('leaves no unfilled slot behind', () => {
      expect(html).not.toContain('data-flowstarter-lead-capture-slot');
    });
  },
);
