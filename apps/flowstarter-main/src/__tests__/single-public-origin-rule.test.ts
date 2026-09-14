/**
 * There is exactly one rule for "where is the app publicly served":
 * `publicAppOrigin()` / `publicCallbackOrigin()` in
 * `@flowstarter/platform-config` (`packages/platform-config/src/public-origin.ts`).
 *
 * Before this test, there were at least two: that rule (added for lead
 * capture and the Cal.com webhook), and a second, older one — a
 * `new URL(NEXT_PUBLIC_SITE_URL).protocol !== 'https:'` assertion, copied by
 * hand into half a dozen routes and lib functions, that forgave `localhost`
 * / `127.0.0.1` and threw or silently degraded everywhere else. On a
 * development stack whose `NEXT_PUBLIC_SITE_URL` names a LAN address
 * (`http://192.168.3.119:3000` — the shape a phone or another machine on the
 * network needs to reach a laptop) that second rule 500'd the signed-in
 * deposit checkout with "NEXT_PUBLIC_SITE_URL must be HTTPS outside local
 * development", while the guest deposit route on the same stack worked,
 * because it happened to fall through to the request's own origin instead.
 * Two rules that can disagree will disagree.
 *
 * This reads the app's own source from disk (not `platform-config`, which
 * legitimately owns both env var names, and not `env.ts`, whose entire job
 * is declaring the app's environment schema) and fails if either
 * `NEXT_PUBLIC_SITE_URL` or `NEXT_PUBLIC_APP_URL` is referenced anywhere else
 * — in code or in a comment, since a comment that still explains a deleted
 * rule is worse than no comment. The one place a route is allowed to reach
 * for its own request is `request.nextUrl.origin` (or an equivalent),
 * threaded into `publicAppOrigin()`'s own `requestOrigin` parameter — never a
 * second reading of the env var.
 *
 * Test files are the one exception: they legitimately stub these env vars to
 * exercise `publicAppOrigin()`'s behaviour end-to-end through a route, the
 * same way `packages/platform-config/test/public-origin.test.ts` does for
 * the rule itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '..');

const FORBIDDEN_ENV_VARS = [
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_APP_URL',
] as const;

/**
 * The app's own environment schema (`env.ts`) is the one file whose entire
 * job is naming every env var the app reads, this pair included — see the
 * module doc above.
 */
const ENV_HANDLING_FILES = new Set([path.join(SRC_DIR, 'env.ts')]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'coverage']);

function isTestFile(filePath: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/.test(filePath) ||
    filePath.split(path.sep).includes('__tests__')
  );
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(path.join(dir, entry.name), out);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

describe('the app reads its own public origin through one rule', () => {
  const allFiles = collectSourceFiles(SRC_DIR);
  // Sanity: this walk actually found the app, so an empty result below means
  // "nothing referenced it" and not "the walk found nothing at all".
  it('found more than a handful of source files to check', () => {
    expect(allFiles.length).toBeGreaterThan(50);
  });

  for (const envVar of FORBIDDEN_ENV_VARS) {
    it(`references ${envVar} only from platform-config's env schema (env.ts) or a test`, () => {
      const offenders: string[] = [];
      for (const file of allFiles) {
        if (ENV_HANDLING_FILES.has(file)) continue;
        if (isTestFile(file)) continue;
        const contents = readFileSync(file, 'utf8');
        if (contents.includes(envVar)) {
          offenders.push(path.relative(SRC_DIR, file));
        }
      }
      expect(
        offenders,
        `${envVar} referenced outside env.ts and tests:\n${offenders.join(
          '\n'
        )}`
      ).toEqual([]);
    });
  }
});
