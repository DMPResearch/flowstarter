/**
 * A real `astro build` of the heaviest template, packed the way a preview is.
 *
 * Every other suite around the preview pipeline stubs the build, and rightly
 * so — they are about the contract (cwd, argv, environment, exit code), and a
 * stub proves that faster and more precisely than Astro can. But both defects
 * this file exists for were invisible to every one of those stubs, because
 * both were about what the REAL compiler emits:
 *
 *  - the artifact was 11.05 MiB and the storage bucket refused objects over
 *    10 MiB, so a correct portfolio preview was generated and never hosted.
 *    No stub emits 11 MiB of PNG.
 *  - the built contact page carried `data-contact-form`, the honeypot and the
 *    sent/error elements, and the capture endpoint appeared nowhere in the
 *    HTML or in any `_astro/*.js` bundle. The injector ran — on the manifest
 *    the route stashes for the claim, AFTER this build had already compiled
 *    and deployed. No stub has a contact page to inject into.
 *
 * So these two run the real thing, on the real templates, and assert the two
 * properties a preview has to have before it is worth showing anybody: it fits
 * in the budget, and its form goes somewhere.
 *
 * The template is chosen by weight at runtime rather than named, so this keeps
 * testing the worst case as the templates change.
 */
import { describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('server-only', () => ({}));

import { buildStaticPreview, templateRootDir } from '../static-preview-build';
import { packPreviewTarball } from '@/lib/hosting/site-archive';
import {
  PREVIEW_ARTIFACT_BUDGET_BYTES,
  formatBytes,
} from '@/lib/hosting/preview-artifact-budget';
import { applyIntegrationsToWorkspace } from '@flowstarter/agentic-codegen';
import { previewLeadCaptureEndpoint } from '@/lib/flowstarter/lead-capture-scaffold';

const TEMPLATE_ROOT = templateRootDir();
const PREVIEW_ID = 'b17c5a90-3333-4333-8333-333333333333';

/**
 * The templates with a dependency tree installed. Absent, there is nothing to
 * build and this file has nothing to say — a `pnpm install` at the repo root
 * installs them, which is what CI does.
 */
function installedTemplates(): string[] {
  if (!existsSync(TEMPLATE_ROOT)) return [];
  return [
    'dorin-portfolio',
    'creative-portfolio',
    'local-trade',
    'professional-services',
    'wellness-therapy',
  ].filter(
    (slug) =>
      existsSync(join(TEMPLATE_ROOT, slug, 'node_modules', '.bin', 'astro')) &&
      existsSync(join(TEMPLATE_ROOT, slug, 'src', 'pages', 'contact.astro'))
  );
}

/** Total bytes under a directory, following nothing. */
async function weigh(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) total += await weigh(absolute);
    else if (entry.isFile()) total += (await stat(absolute)).size;
  }
  return total;
}

/**
 * The template that ships the most bytes under `public/` — the one Astro
 * copies into `dist/` verbatim, and therefore the one whose artifact is
 * largest. Chosen rather than named so this test follows the worst case.
 */
async function heaviestTemplate(slugs: readonly string[]): Promise<string> {
  let heaviest = slugs[0] as string;
  let most = -1;
  for (const slug of slugs) {
    const weight = await weigh(join(TEMPLATE_ROOT, slug, 'public'));
    if (weight > most) {
      most = weight;
      heaviest = slug;
    }
  }
  return heaviest;
}

/** A workspace copy of a template, the way the pipeline hands one over. */
async function workspaceFor(slug: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fs-real-build-'));
  const workspace = join(root, slug);
  await cp(join(TEMPLATE_ROOT, slug), workspace, {
    recursive: true,
    // The template's own `node_modules` is a symlink farm and hundreds of
    // megabytes; `buildStaticPreview` symlinks it in rather than copying, and
    // so does this.
    filter: (source) => !source.includes(`${slug}/node_modules`),
  });
  await symlink(
    resolve(TEMPLATE_ROOT, slug, 'node_modules'),
    join(workspace, 'node_modules'),
    'dir'
  ).catch(() => {});
  return workspace;
}

const templates = installedTemplates();

describe.skipIf(templates.length === 0)(
  'a real preview build of the heaviest template',
  () => {
    it('packs to an artifact inside the budget, and carries a live contact form', async () => {
      const slug = await heaviestTemplate(templates);
      const workspace = await workspaceFor(slug);
      let built: Awaited<ReturnType<typeof buildStaticPreview>> | undefined;
      try {
        built = await buildStaticPreview({
          projectId: PREVIEW_ID,
          templateSlug: slug,
          workspaceRoot: workspace,
          timeoutMs: 240_000,
          // Exactly what `createFunnelPreviewPublisher` passes. Written out
          // here rather than imported from the publisher because the thing
          // under test is that this, applied at this moment, reaches the
          // compiled output.
          prepare: async (root) => {
            await applyIntegrationsToWorkspace(root, {
              leadCapture: {
                endpoint: previewLeadCaptureEndpoint(PREVIEW_ID),
              },
            });
          },
        });

        // ── The artifact ───────────────────────────────────────────────
        const tarball = packPreviewTarball(built.files);
        const size = tarball.byteLength;
        // Reported on every run, pass or fail: the number is the point, and
        // a test that only speaks up when it breaks cannot show a trend.
        console.info(
          `[real-build] ${slug}: ${built.files.length} files, artifact ` +
            `${formatBytes(size)} (${size} bytes), budget ` +
            `${formatBytes(PREVIEW_ARTIFACT_BUDGET_BYTES)}`
        );
        expect(size).toBeLessThan(PREVIEW_ARTIFACT_BUDGET_BYTES);

        // Only the built site. Not the dependency tree, not the Astro
        // scratch directory, not source maps, not the template's source.
        for (const file of built.files) {
          expect(file.path).not.toMatch(/(^|\/)node_modules\//);
          expect(file.path).not.toMatch(/(^|\/)\.astro\//);
          expect(file.path).not.toMatch(/\.map$/);
          expect(file.path).not.toMatch(/\.astro$/);
        }

        // The images are the optimised outputs. The originals that made the
        // artifact 11.05 MiB were `public/images/*.png` copied verbatim; a
        // multi-megabyte raster surviving into the artifact means the
        // optimiser did not run.
        const originals = built.files.filter((file) =>
          /\.(png|jpe?g)$/i.test(file.path)
        );
        for (const file of originals) {
          // base64 inflates by 4/3; the comparison is against the real bytes.
          const bytes =
            file.encoding === 'base64'
              ? Math.floor((file.content.length * 3) / 4)
              : Buffer.byteLength(file.content, 'utf8');
          expect(bytes).toBeLessThan(1024 * 1024);
        }

        // ── The contact form ───────────────────────────────────────────
        const contact = built.files.find(
          (file) => file.path === 'contact/index.html'
        );
        expect(contact, 'the built site has a contact page').toBeDefined();
        const html = contact?.content ?? '';

        // The form the template ships, which was never the missing half.
        expect(html).toContain('data-contact-form');

        // The half that was missing: something for a submit to go to. The
        // grep the showcase ran — `grep -c "leads/capture"` — returned 0 on
        // this exact file.
        expect(html).toContain('/api/leads/capture/');
        expect(html).toContain(previewLeadCaptureEndpoint(PREVIEW_ID));
        // Inline, not bundled. Astro hoists a module script into
        // `_astro/*.js` and leaves a `<script src>` behind, which is how a
        // capture endpoint can be present in source and absent from the
        // page; `is:inline` is what stops that and is load-bearing.
        expect(html).toMatch(/<script>[\s\S]*addEventListener\('submit'/);
        expect(html).toContain('flowstarter-lead-capture');

        // And the form is never left silently dead: either the injected
        // handler posts, or the native action does.
        expect(html).toMatch(/action="mailto:|action='mailto:/);
      } finally {
        await built?.cleanup().catch(() => {});
        await rm(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
);
