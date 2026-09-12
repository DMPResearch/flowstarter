#!/usr/bin/env node
/**
 * Build every Astro library template into
 * `apps/flowstarter-main/public/preview/<slug>/` so the library showcase iframes
 * (DeferredPreviewFrame → `/preview/<slug>/`) ship with fresh static output on
 * each deploy. Called from the `previews` stage of
 * `deploy/hetzner-staging/Dockerfile`, which runs it only when the image is
 * built with `BUILD_LIBRARY_PREVIEWS=true`. The release lane sets that;
 * staging does not, because staging can live with empty iframes.
 *
 * Each template's `astro.config.mjs` is self-describing — it sets its own
 * `base: '/preview/<slug>/'` and `outDir` into this app's public/preview — so
 * we just run the template's build in its own directory; no slug mapping here.
 *
 * This script installs nothing. Each template resolves `astro` by walking up
 * to `apps/flowstarter-library/node_modules/.bin`, so that workspace's
 * dependencies have to be installed before it runs. (`--skip-install` is
 * accepted for backwards compatibility and ignored; it never did anything.)
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', '..', 'flowstarter-library', 'templates');

if (!existsSync(templatesDir)) {
  console.error(`[previews] templates dir not found: ${templatesDir}`);
  process.exit(1);
}

const templates = readdirSync(templatesDir)
  .filter((name) => name !== 'shared')
  .map((name) => join(templatesDir, name))
  .filter(
    (dir) =>
      statSync(dir).isDirectory() && existsSync(join(dir, 'astro.config.mjs')),
  );

if (templates.length === 0) {
  console.error('[previews] no buildable templates found');
  process.exit(1);
}

console.log(`[previews] building ${templates.length} template preview(s)…`);
for (const dir of templates) {
  const name = dir.split('/').pop();
  console.log(`[previews] → ${name}`);
  // Honour each template's own build script (astro build) in its own cwd.
  execSync('pnpm run build', { cwd: dir, stdio: 'inherit' });
}
console.log('[previews] done.');
