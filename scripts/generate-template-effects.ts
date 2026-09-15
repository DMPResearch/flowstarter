/**
 * Writes each template's `effects.json`: the effect contract
 * `deriveTemplateEffectsManifest` reads out of that template's own source.
 *
 *   pnpm effects:manifest           # rewrite every template's effects.json
 *   pnpm effects:manifest --check   # fail if one is stale (CI, and the suite)
 *
 * The product never reads these files. The `TEMPLATE_EFFECTS_DROPPED` gate
 * derives the same manifest from the seed a build starts from, in memory, so
 * there is no baseline on disk for an agent to edit and nothing to keep in
 * sync at build time. The files exist so that a human reviewing a template
 * change can see, in the diff, that the section they rewrote carried a scroll
 * reveal, a sticky panel or a step timeline — and so that
 * `template-effects.test.ts` can assert the derivation still says what the
 * repository claims it says.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveTemplateEffectsManifest,
  readTemplateEffectsSource,
  type TemplateEffectsManifest,
} from '../packages/agentic-codegen/src/flowstarter/template-effects';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES_ROOT = join(repoRoot, 'apps/flowstarter-templates');
export const EFFECTS_MANIFEST_FILE = 'effects.json';

/** Every template directory with sources in it, in a stable order. */
export async function templateDirs(): Promise<string[]> {
  const entries = await readdir(TEMPLATES_ROOT, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(TEMPLATES_ROOT, entry.name);
    try {
      if (!(await stat(join(dir, 'src'))).isDirectory()) continue;
    } catch {
      continue;
    }
    dirs.push(dir);
  }
  return dirs.sort();
}

/** The file's exact text, so "generate" and "check" cannot disagree. */
export function manifestText(manifest: TemplateEffectsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function manifestFor(
  templateDir: string,
): Promise<TemplateEffectsManifest> {
  return deriveTemplateEffectsManifest(
    await readTemplateEffectsSource(templateDir),
  );
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  for (const dir of await templateDirs()) {
    const name = relative(TEMPLATES_ROOT, dir);
    const target = join(dir, EFFECTS_MANIFEST_FILE);
    const text = manifestText(await manifestFor(dir));
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current === text) {
      console.log(`  ${name}: up to date`);
      continue;
    }
    if (check) {
      stale.push(name);
      console.error(`  ${name}: ${EFFECTS_MANIFEST_FILE} is stale`);
      continue;
    }
    await writeFile(target, text, 'utf8');
    console.log(`  ${name}: wrote ${EFFECTS_MANIFEST_FILE}`);
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} template effect manifest(s) out of date. Run ` +
        '`pnpm effects:manifest` and commit the result.',
    );
    process.exitCode = 1;
  }
}

/** Run as a script, not when the suite imports the helpers above. */
const invoked = process.argv[1]?.split(sep).join('/') ?? '';
if (invoked.endsWith('/generate-template-effects.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
