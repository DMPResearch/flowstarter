// @vitest-environment node
/**
 * The gate that makes the other tenancy tests hard to forget.
 *
 * Three trees take a tenant id straight out of the URL and then query with the
 * service role, which bypasses RLS:
 *
 *   /api/client/site/[workspaceId]  : the client editor, gated by
 *                                     `requireWorkspaceAccess` (404 for a
 *                                     non-member)
 *   /api/admin/projects/[id]        : the operator surface, gated by
 *   /api/team/projects/[id]           `requireTeamAuth` (403 for a non-operator)
 *
 * In all three the guard is a line of code at the top of a handler, which is
 * to say it is a line of code someone can leave out. The proof that it is
 * there is a test, and the proof that the test exists is this file: it walks
 * the trees on disk, walks every `*.test.ts` under `src/app/api/**\/__tests__/`,
 * and fails by name for any `route.ts` that no cross-tenant test refers to.
 *
 * So a new route added without the check does not merely go untested. It
 * fails CI, and the failure says which file.
 *
 * What this can and cannot do: it proves a route is *named* by a suite that
 * asserts the boundary. It cannot prove the assertion is about that route.
 * That is what the per-tree suites are for; this only makes their absence
 * loud.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `src/app/api` */
const API_DIR = path.resolve(HERE, '..');
/** `src`, for resolving `@/...` specifiers the way the vitest alias does. */
const SRC_DIR = path.resolve(API_DIR, '../..');

/** The trees whose handlers take a tenant id from the request. */
const TENANT_TREES = [
  'client/site/[workspaceId]',
  'admin/projects/[id]',
  'team/projects/[id]',
] as const;

/**
 * Route files that are knowingly exempt.
 *
 * Empty, and meant to stay that way: every handler in the three trees has a
 * cross-tenant case as of this commit. An entry here is a promise that the
 * route cannot leak a tenant's data, written down where a reviewer will see
 * it, not a place to park a route someone did not get to.
 */
export const ALLOW_LIST: ReadonlyArray<{ file: string; reason: string }> = [];

/**
 * A suite counts as a cross-tenant suite if it says so. Loose on purpose: the
 * phrasing across the three trees differs ("not yours", "not yours to
 * operate", `expectRejectsForeignWorkspace`) and this gate is about presence,
 * not wording. The assertions themselves live in the suites.
 */
const CROSS_TENANT_MARKER =
  /(not\s+yours|not\s+your\s+workspace|foreign\s*workspace|another\s+workspace|cross[-\s]tenant)/i;

function walk(dir: string, keep: (full: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, keep));
    } else if (keep(full)) {
      found.push(full);
    }
  }
  return found;
}

/** Every `route.ts` under the three trees, as paths relative to `src/app/api`. */
function tenantRouteFiles(): string[] {
  const files: string[] = [];
  for (const tree of TENANT_TREES) {
    const root = path.join(API_DIR, tree);
    files.push(
      ...walk(root, (full) => path.basename(full) === 'route.ts').map((full) =>
        path.relative(API_DIR, full)
      )
    );
  }
  return files.sort();
}

/** Every `*.test.ts` under any `__tests__` directory in `src/app/api`, minus this one. */
function apiTestFiles(): string[] {
  const self = path.resolve(HERE, 'tenant-route-coverage.test.ts');
  return walk(
    API_DIR,
    (full) =>
      full.endsWith('.test.ts') &&
      path.basename(path.dirname(full)) === '__tests__' &&
      full !== self
  ).sort();
}

/**
 * Every path a test file names, however it names it: a relative import
 * (`'../billing/deposit-invoice/route'`), an aliased one (`'@/app/api/...'`),
 * or a bare string with the repo path in it. Extensions are dropped so
 * `route`, `route.ts` and `route.ts'` all land on the same key.
 */
function referencedPaths(testFile: string): Set<string> {
  const source = readFileSync(testFile, 'utf8');
  const dir = path.dirname(testFile);
  const references = new Set<string>();

  // `exec` in a loop rather than `matchAll`: the test tsconfig targets a
  // version whose iterator protocol tsc will not downlevel.
  const literal = /(['"`])([^'"`\n]+)\1/g;
  let match: RegExpExecArray | null = literal.exec(source);
  for (; match !== null; match = literal.exec(source)) {
    const raw = match[2];
    if (!raw || !raw.includes('/')) continue;
    const bare = raw.replace(/\.tsx?$/, '');

    let absolute: string | null = null;
    if (bare.startsWith('./') || bare.startsWith('../')) {
      absolute = path.resolve(dir, bare);
    } else if (bare.startsWith('@/')) {
      absolute = path.resolve(SRC_DIR, bare.slice(2));
    } else {
      const marker = bare.indexOf('src/app/api/');
      if (marker !== -1) {
        absolute = path.resolve(
          API_DIR,
          bare.slice(marker + 'src/app/api/'.length)
        );
      }
    }
    if (absolute) references.add(path.relative(API_DIR, absolute));
  }
  return references;
}

interface Coverage {
  /** Test files that import the route but say nothing about tenancy. */
  mentionedBy: string[];
  /** Test files that import the route AND assert the cross-tenant refusal. */
  provenBy: string[];
}

function coverage(): Map<string, Coverage> {
  const routes = tenantRouteFiles();
  const result = new Map<string, Coverage>(
    routes.map((route) => [route, { mentionedBy: [], provenBy: [] }])
  );

  for (const testFile of apiTestFiles()) {
    const references = referencedPaths(testFile);
    const asserts = CROSS_TENANT_MARKER.test(readFileSync(testFile, 'utf8'));
    const label = path.relative(API_DIR, testFile);

    for (const route of routes) {
      // `route.ts` relative to the api dir, minus the extension, is the key
      // an import specifier resolves to.
      if (!references.has(route.replace(/\.ts$/, ''))) continue;
      const entry = result.get(route);
      if (!entry) continue;
      entry.mentionedBy.push(label);
      if (asserts) entry.provenBy.push(label);
    }
  }
  return result;
}

describe('every tenant-scoped route is proven against a workspace that is not yours', () => {
  it('finds the trees it is supposed to be guarding', () => {
    // A rename that quietly emptied the walk would turn this whole file into a
    // test that passes because it checked nothing.
    const routes = tenantRouteFiles();
    for (const tree of TENANT_TREES) {
      expect(
        routes.filter((route) => route.startsWith(`${tree}${path.sep}`)).length,
        tree
      ).toBeGreaterThan(0);
    }
    expect(apiTestFiles().length).toBeGreaterThan(0);
  });

  it('has no allow-list entry that is stale or unexplained', () => {
    const routes = new Set(tenantRouteFiles());
    for (const entry of ALLOW_LIST) {
      expect(
        routes.has(entry.file),
        `${entry.file} is not a route in a tenant tree`
      ).toBe(true);
      expect(
        entry.reason.trim().length,
        `${entry.file} needs a real reason`
      ).toBeGreaterThan(20);
    }
  });

  it('names any route.ts that no cross-tenant suite covers', () => {
    const allowed = new Set(ALLOW_LIST.map((entry) => entry.file));
    const unproven: string[] = [];

    coverage().forEach((entry, route) => {
      if (allowed.has(route)) return;
      if (entry.provenBy.length > 0) return;
      unproven.push(
        entry.mentionedBy.length > 0
          ? `${route}: imported by ${entry.mentionedBy.join(
              ', '
            )}, but none of those suites asserts a workspace that is not yours`
          : `${route}: no test under src/app/api/**/__tests__/ imports it`
      );
    });

    expect(
      unproven,
      unproven.length === 0
        ? ''
        : [
            'These route handlers take a tenant id from the request and query past RLS,',
            "but nothing proves they refuse a workspace that is not the caller's:",
            ...unproven.map((line) => `  - ${line}`),
            '',
            'Add the route to the cross-tenant suite for its tree:',
            '  src/app/api/client/site/[workspaceId]/__tests__/client-site-routes.test.ts',
            '  src/app/api/admin/projects/[id]/__tests__/operator-project-routes.test.ts',
            '  src/app/api/team/projects/[id]/__tests__/operator-project-routes.test.ts',
            'or, if it genuinely cannot leak, add it to ALLOW_LIST in this file with a reason.',
          ].join('\n')
    ).toEqual([]);
  });
});
