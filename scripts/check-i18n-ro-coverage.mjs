#!/usr/bin/env node
/**
 * check-i18n-ro-coverage.mjs: refuse an English-only key in a visitor-facing
 * block of the Romanian catalogue.
 *
 * `ro.ts` is an overlay, not a full catalogue: a key it omits falls back to
 * the English string in `en.ts` (see `I18nProvider` in `src/lib/i18n.tsx`).
 * That fallback is the right behaviour for a block nobody has translated on
 * purpose. It stopped being the right behaviour for the discovery funnel on
 * 2026-09-15, when PR #196 added the funnel's person-block questions in both
 * languages and, in doing so, made it obvious that the *rest* of the funnel
 * -- everything asked before that block, the scope gate, the preview step,
 * the brief, the client dashboard -- had never been translated at all. A
 * Romanian visitor picks Romanian on this funnel; the funnel then interviews
 * them in English. That is not a missing nicety, it is the product telling a
 * visitor who just told it their language that it was not listening.
 *
 * This script does not care about the whole catalogue -- most of it is
 * admin tooling, or marketing copy nobody has scoped for translation yet,
 * and ratcheting all of it at once would make this check impossible to keep
 * green. It cares about the blocks a visitor can actually be standing in
 * while speaking Romanian: the discovery funnel and scope gate, the policy
 * notices, the preview step, the brief (including the portrait sourcing
 * copy shown there), and the client's own dashboard. `admin.*` and
 * `team.*` are staff tooling and are deliberately excluded -- see
 * VISITOR_FACING_BLOCKS below for the exact list, which is also what the
 * companion test in
 * `apps/flowstarter-main/src/locales/__tests__/ro-coverage.test.ts` checks
 * against the real catalogue.
 *
 * A key's "block" is its dotted prefix, matched from the start of the key
 * (`dashboard.` matches `dashboard.title` but not `admin.dashboard.title`
 * or `team.dashboard.title`, both of which have their own, different,
 * prefix).
 *
 * Usage:
 *   node scripts/check-i18n-ro-coverage.mjs
 *   node scripts/check-i18n-ro-coverage.mjs --locales path/to/locales
 *
 * Exits non-zero and lists every missing key, grouped by block, when an en
 * key in a visitor-facing block has no ro counterpart. Exits zero, silently,
 * otherwise.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The blocks a Romanian-speaking visitor can actually see. Staff-only
 * surfaces (`admin.*`, `team.*`) are deliberately not in this list. */
export const VISITOR_FACING_BLOCKS = [
  'landing.discovery.', // the discovery funnel + its scope gate (scope.* lives in this same prefix, in en/discovery-call.ts)
  'discoveryCall.', // the /discovery-call page and its fallback contact form
  'moderation.', // content-policy notices
  'site.preview.', // the temporary preview link banner
  'domain.preview.', // the temporary preview link banner (domain half)
  'portrait.', // the brief's photo-sourcing section
  'dashboard.', // the client's own project dashboard (not admin.dashboard. or team.dashboard.)
];

/**
 * Every top-level string key assigned in a locale catalogue source file,
 * found by scanning the source text rather than importing the module -- the
 * catalogues are plain `.ts` object literals, so a regex over quoted keys
 * avoids needing a TypeScript loader just to lint them (the same choice
 * `check-no-nul-bytes.mjs` makes for scanning source instead of executing
 * it).
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function extractKeys(source) {
  const keys = new Set();
  const re = /^[ \t]*'((?:[^'\\]|\\.)+)'\s*:/gm;
  let match;
  while ((match = re.exec(source))) {
    keys.add(match[1]);
  }
  return keys;
}

/**
 * @param {Set<string>} enKeys
 * @param {Set<string>} roKeys
 * @param {string[]} blocks
 * @returns {Array<{ block: string, missing: string[] }>} non-empty groups only, block-ordered
 */
export function findMissingByBlock(enKeys, roKeys, blocks) {
  const groups = [];
  for (const block of blocks) {
    const missing = [...enKeys]
      .filter((key) => key.startsWith(block) && !roKeys.has(key))
      .sort();
    if (missing.length > 0) {
      groups.push({ block, missing });
    }
  }
  return groups;
}

function parseArgs(argv) {
  const args = {
    localesDir: path.join(
      __dirname,
      '..',
      'apps',
      'flowstarter-main',
      'src',
      'locales',
    ),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--locales' && argv[i + 1]) {
      args.localesDir = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

/**
 * @param {string} localesDir
 * @returns {{ enKeys: Set<string>, roKeys: Set<string> }}
 */
function readCatalogueKeys(localesDir) {
  // en.ts spreads in the two split-out files at the bottom; ro.ts is a
  // single file. A file that does not exist yet (this script running
  // against an older checkout) contributes no keys rather than crashing.
  const read = (relativePath) => {
    try {
      return readFileSync(path.join(localesDir, relativePath), 'utf8');
    } catch {
      return '';
    }
  };

  const enKeys = new Set([
    ...extractKeys(read('en.ts')),
    ...extractKeys(read(path.join('en', 'admin.ts'))),
    ...extractKeys(read(path.join('en', 'discovery-call.ts'))),
  ]);
  const roKeys = extractKeys(read('ro.ts'));

  return { enKeys, roKeys };
}

function main() {
  const { localesDir } = parseArgs(process.argv.slice(2));
  const { enKeys, roKeys } = readCatalogueKeys(localesDir);
  const missingByBlock = findMissingByBlock(
    enKeys,
    roKeys,
    VISITOR_FACING_BLOCKS,
  );

  if (missingByBlock.length === 0) {
    console.log(
      `check-i18n-ro-coverage: every visitor-facing en key has a ro translation (${VISITOR_FACING_BLOCKS.length} block(s) checked in ${path.relative(process.cwd(), localesDir)}).`,
    );
    return;
  }

  const totalMissing = missingByBlock.reduce(
    (sum, { missing }) => sum + missing.length,
    0,
  );
  console.error(
    `check-i18n-ro-coverage: ${totalMissing} key(s) in a visitor-facing block exist in en.ts but not in ro.ts. A Romanian visitor sees English there -- see the block comment in this script for why that is treated as a bug, not a style nit.\n`,
  );
  for (const { block, missing } of missingByBlock) {
    console.error(`  ${block} (${missing.length} missing):`);
    for (const key of missing) {
      console.error(`    - ${key}`);
    }
  }
  console.error(
    '\nAdd a natural Romanian translation for each key above to apps/flowstarter-main/src/locales/ro.ts (or, if this block should not be visitor-facing after all, remove it from VISITOR_FACING_BLOCKS in this script and from the matching list in ro-coverage.test.ts).',
  );
  process.exitCode = 1;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
