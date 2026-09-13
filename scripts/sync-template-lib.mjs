#!/usr/bin/env node
/**
 * Copies the shared, dependency-free template libraries from their canonical
 * home in `packages/agentic-codegen` into every template that ships them.
 *
 * A generated site is a standalone Astro app: its `package.json` depends on
 * `astro` and nothing else, so a template cannot import a workspace package
 * and the file has to travel with the site. One canonical copy is where the
 * tests point; these are the ones that ship. `test/template-lib-sync.test.ts`
 * in `packages/agentic-codegen` fails when a shipped copy has drifted, and
 * tells whoever is reading to run this script.
 *
 *   node scripts/sync-template-lib.mjs           # write the copies
 *   node scripts/sync-template-lib.mjs --check   # exit 1 if any has drifted
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** canonical source → the name it takes inside a template's `src/lib/`. */
export const SYNCED_TEMPLATE_LIBS = [
  {
    source: 'packages/agentic-codegen/src/flowstarter/site-html-sanitizer.ts',
    target: 'src/lib/sanitize-html.ts',
  },
];

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Every template that has a `src/lib/` — the ones with a content loader. */
export async function templatesWithLib(repoRoot = root) {
  const templatesRoot = join(repoRoot, 'apps/flowstarter-templates');
  const entries = await readdir(templatesRoot, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(templatesRoot, entry.name);
    if (await isDirectory(join(dir, 'src/lib'))) found.push(dir);
  }
  return found.sort();
}

async function main() {
  const check = process.argv.includes('--check');
  const templates = await templatesWithLib();
  const drifted = [];
  let written = 0;

  for (const lib of SYNCED_TEMPLATE_LIBS) {
    const canonical = await readFile(join(root, lib.source), 'utf8');
    for (const template of templates) {
      const target = join(template, lib.target);
      let current = null;
      try {
        current = await readFile(target, 'utf8');
      } catch {
        current = null;
      }
      if (current === canonical) continue;
      if (check) {
        drifted.push(target.slice(root.length + 1));
        continue;
      }
      await writeFile(target, canonical);
      written += 1;
    }
  }

  if (check && drifted.length > 0) {
    console.error(
      'These template copies have drifted from their canonical source:\n' +
        drifted.map((path) => `  ${path}`).join('\n') +
        '\nRun: node scripts/sync-template-lib.mjs',
    );
    process.exit(1);
  }
  console.info(
    check
      ? 'Template libraries are in sync.'
      : `Template libraries synced (${written} file(s) written).`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
