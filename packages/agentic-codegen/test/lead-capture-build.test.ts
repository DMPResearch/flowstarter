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

const TEMPLATES_ROOT = join(__dirname, '../../../apps/flowstarter-templates');

function templateDir(template: string): string {
  return join(TEMPLATES_ROOT, template);
}

const TEMPLATE = 'creative-portfolio';
const TEMPLATE_DIR = templateDir(TEMPLATE);
const ASTRO_BIN = join(TEMPLATE_DIR, 'node_modules/.bin/astro');
const TOKEN = 'Kx9-_abcdefghijklmnopqrstuvwxyz0123456789AB';

const installed = existsSync(ASTRO_BIN);

/**
 * Every template that ships the contact page's lead-capture slot, so a
 * class-name regression on any one of them is a real-build failure and not
 * just a string match against a template nobody rebuilt. `demo-coach` has no
 * `contact.astro` at all and is out of scope for this file.
 */
const TEMPLATES_WITH_LEAD_CAPTURE_SLOT = [
  'creative-portfolio',
  'dorin-portfolio',
  'local-trade',
  'professional-services',
  'wellness-therapy',
] as const;

/** Copies `template` into a scratch workspace, borrowing its installed tree. */
async function scaffoldWorkspace(template: string): Promise<string> {
  const dir = templateDir(template);
  const workspace = await mkdtemp(join(tmpdir(), 'lead-capture-build-'));
  await cp(dir, workspace, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${template}/node_modules`) &&
      !source.includes(`${template}/dist`) &&
      !source.includes(`${template}/.astro`),
  });
  // Astro resolves from the project root, so the copy borrows the template's
  // own installed tree rather than running an install here.
  await symlink(
    join(dir, 'node_modules'),
    join(workspace, 'node_modules'),
    'dir',
  );
  return workspace;
}

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
      workspace = await scaffoldWorkspace(TEMPLATE);

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

    /**
     * Job `7508bf52`'s built contact page shipped `class="contact-pagelead-
     * capture"` — `contact-page` and `lead-capture` concatenated with no
     * separator — instead of either the template's `contact-page__lead-
     * capture` slot or the injector's own `flowstarter-lead-capture` block
     * class. The injector never produces that string (`renderLeadCaptureBlock`
     * in `src/integrations.ts` always writes `flowstarter-lead-capture`
     * literally); the defect was a corrupted *stored* phrase from before
     * `isUsablePhrase` rejected markup (see `preview-manifest.test.ts`) being
     * handed to the build agent as text to reproduce. This asserts the class
     * a real build actually emits, so a regression in either place fails here
     * directly rather than only in a unit test over a string nobody built.
     */
    it('emits the injector block under its own class, never the malformed concatenation', () => {
      expect(html).toContain('class="flowstarter-lead-capture"');
      expect(html).not.toContain('contact-pagelead-capture');
    });
  },
);

/**
 * Every template's *unmodified* contact page — no lead-capture integration
 * applied, the scaffold built exactly as `astro build` would build it before
 * any injector or agent ever touches it — carries the slot under its real
 * BEM class and its managed-block marker. This is the ground truth
 * `resolveApprovedEdit` (`workflows.ts`) and the lead-capture injector both
 * have to agree with: if a template ever regresses to shipping the class
 * concatenated (`contact-pagelead-capture`) or drops the marker attribute
 * that makes the slot findable, a real build catches it here.
 */
describe.skipIf(!installed).each(TEMPLATES_WITH_LEAD_CAPTURE_SLOT)(
  'the unmodified %s contact page carries the correct slot class and marker',
  (template) => {
    let workspace = '';
    let html = '';

    beforeAll(async () => {
      workspace = await scaffoldWorkspace(template);
      const astroBin = join(workspace, 'node_modules/.bin/astro');
      await run(astroBin, ['build'], { cwd: workspace });
      html = await readFile(join(workspace, 'dist/contact/index.html'), 'utf8');
    }, 180_000);

    afterAll(async () => {
      if (workspace) await rm(workspace, { recursive: true, force: true });
    });

    it('ships the BEM class, never the malformed concatenation', () => {
      expect(html).toContain('class="contact-page__lead-capture"');
      expect(html).not.toContain('contact-pagelead-capture');
    });

    it('ships the managed-block marker the injector and the gate both key off', () => {
      expect(html).toContain('data-flowstarter-lead-capture-slot');
    });
  },
);
