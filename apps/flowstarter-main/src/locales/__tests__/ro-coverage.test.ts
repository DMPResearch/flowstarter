import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Regression test for the defect PR #196 surfaced on 2026-09-15: `ro.ts`
 * had no translation for anything in the discovery funnel except the
 * scope-gate hold notice, so a visitor who picked Romanian was interviewed
 * in English for the rest of the funnel (`I18nProvider` in `../../lib/i18n`
 * falls back to the English string for any key `ro.ts` omits, which is the
 * right behaviour for a block nobody has translated on purpose, not for one
 * a Romanian-speaking visitor is standing in).
 *
 * This checks the real catalogue files, not fixtures, so it fails the
 * moment a new en-only key lands in one of these blocks without its ro
 * counterpart -- the same property `scripts/check-i18n-ro-coverage.mjs`
 * enforces in CI before typecheck or tests even run. The two are
 * deliberately independent implementations of the same rule (this one
 * reads within the package via jsdom/vitest, the CI one runs as a plain
 * Node script with no package boundary to cross) rather than one importing
 * the other, so a change to either has to keep both green.
 *
 * `admin.*` and `team.*` are staff tooling, not visitor-facing, and are
 * intentionally excluded -- see VISITOR_FACING_BLOCKS.
 */

const VISITOR_FACING_BLOCKS = [
  'landing.discovery.', // the discovery funnel + its scope gate
  'discoveryCall.', // the /discovery-call page and its fallback contact form
  'moderation.', // content-policy notices
  'site.preview.', // the temporary preview link banner
  'domain.preview.', // the temporary preview link banner (domain half)
  'portrait.', // the brief's photo-sourcing section
  'dashboard.', // the client's own project dashboard
];

function extractKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const re = /^[ \t]*'((?:[^'\\]|\\.)+)'\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    keys.add(match[1]);
  }
  return keys;
}

const localesDir = path.join(__dirname, '..');
const read = (relativePath: string) =>
  readFileSync(path.join(localesDir, relativePath), 'utf8');

const enKeys = new Set([
  ...Array.from(extractKeys(read('en.ts'))),
  ...Array.from(extractKeys(read(path.join('en', 'admin.ts')))),
  ...Array.from(extractKeys(read(path.join('en', 'discovery-call.ts')))),
]);
const roKeys = extractKeys(read('ro.ts'));

describe('ro.ts coverage of visitor-facing blocks', () => {
  it.each(VISITOR_FACING_BLOCKS)(
    'every en key under %s has a ro translation',
    (block) => {
      const missing = Array.from(enKeys)
        .filter((key) => key.startsWith(block) && !roKeys.has(key))
        .sort();

      expect(
        missing,
        `${missing.length} key(s) under "${block}" exist in en.ts but not in ro.ts:\n${missing.map((k) => `  - ${k}`).join('\n')}\n\nAdd a natural Romanian translation for each to apps/flowstarter-main/src/locales/ro.ts.`,
      ).toEqual([]);
    },
  );

  it('admin.dashboard. and team.dashboard. are not swept into the dashboard. block', () => {
    // Guards the prefix-match itself: a key.startsWith('dashboard.') check
    // would (correctly) not match 'admin.dashboard.foo' or
    // 'team.dashboard.foo' since neither starts with the literal string
    // "dashboard.". This pins that behaviour so a future refactor of the
    // matching logic cannot silently start demanding ro translations for
    // staff-only tooling.
    const staffKeys = Array.from(enKeys).filter(
      (key) =>
        key.startsWith('admin.dashboard.') || key.startsWith('team.dashboard.'),
    );
    expect(staffKeys.some((key) => key.startsWith('dashboard.'))).toBe(false);
  });
});
