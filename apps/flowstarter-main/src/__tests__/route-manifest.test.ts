/**
 * The public route list has to describe pages that exist.
 *
 * Before this test, `isPublicRoute` in `middleware.ts` allow-listed eleven
 * paths with nothing behind them: `/gdpr`, `/guides`, `/blogs`, `/sitemap`,
 * `/accessibility`, `/cookie-policy`, `/term-of-service`, `/privacy-policy`,
 * `/forgot-password`, `/reset-password` and `/verify`. The production
 * synthetic in PR #38 found them by asking production for each one and getting
 * a 404. Nothing in the repository linked to any of them, so they were removed
 * rather than redirected.
 *
 * The check below reads `src/app` from disk, so deleting or renaming a page
 * whose path is still listed in the manifest fails here, in the unit suite,
 * instead of on the live site.
 */
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { KNOWN_APP_ROUTES, PUBLIC_ROUTES } from '@/lib/route-manifest';

const APP_DIR = path.resolve(__dirname, '..', 'app');

/** A `(group)` segment is organisational and contributes nothing to the URL. */
const isRouteGroup = (segment: string) =>
  segment.startsWith('(') && segment.endsWith(')');

/** `[id]`, `[...slug]`, `[[...index]]` — a placeholder, not a literal path. */
const isDynamicSegment = (segment: string) =>
  segment.startsWith('[') && segment.endsWith(']');

/**
 * Every URL path that `src/app` can render, plus the parent path of each
 * dynamic leaf so a prefix like `/unlock` (only `/unlock/[workspaceId]`
 * exists) still counts as a real surface of the app.
 */
function collectRenderablePaths(): Set<string> {
  const paths = new Set<string>();

  const record = (segments: string[]) => {
    const trailing = segments[segments.length - 1];
    // `/login/[[...index]]` renders `/login` itself, and `/unlock/[id]` makes
    // `/unlock` a real prefix of the app even though the bare path 404s. Both
    // drop the placeholder and record the parent.
    const literal =
      trailing !== undefined && isDynamicSegment(trailing)
        ? segments.slice(0, -1)
        : segments;
    // A placeholder anywhere else means this is not a literal path at all.
    if (literal.some(isDynamicSegment)) return;
    // No segments left is the root page, and `/${''}` already spells it `/`.
    paths.add(`/${literal.join('/')}`);
  };

  const walk = (dir: string, segments: string[]) => {
    if (existsSync(path.join(dir, 'page.tsx'))) record(segments);

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;

      const child = path.join(dir, entry.name);
      // A `(group)` segment is organisational: recurse without extending the URL.
      walk(
        child,
        isRouteGroup(entry.name) ? segments : [...segments, entry.name]
      );
    }
  };

  walk(APP_DIR, []);
  return paths;
}

/** `/about(.*)` describes the path `/about`. */
const toPath = (entry: string) => entry.replace(/\(\.\*\)$/, '') || '/';

const RENDERABLE = collectRenderablePaths();

describe('route manifest', () => {
  it('finds the pages it is about to check (guards against an empty scan)', () => {
    expect(RENDERABLE.size).toBeGreaterThan(10);
    expect(RENDERABLE.has('/privacy')).toBe(true);
    expect(RENDERABLE.has('/library')).toBe(true);
  });

  describe('PUBLIC_ROUTES', () => {
    const pageEntries = PUBLIC_ROUTES.filter(
      (entry) => !entry.startsWith('/api')
    );

    for (const entry of pageEntries) {
      it(`${entry} has a page under src/app`, () => {
        expect(
          RENDERABLE.has(toPath(entry)),
          `${entry} is public but no page renders ${toPath(
            entry
          )}. Remove the entry or add the page.`
        ).toBe(true);
      });
    }

    const apiEntries = PUBLIC_ROUTES.filter((entry) =>
      entry.startsWith('/api')
    );

    for (const entry of apiEntries) {
      it(`${entry} has a directory under src/app/api`, () => {
        const dir = path.join(APP_DIR, toPath(entry).replace(/^\//, ''));
        expect(existsSync(dir), `${entry} points at a missing ${dir}`).toBe(
          true
        );
      });
    }

    it('no longer allow-lists the paths that had no page', () => {
      // Named one by one so a future re-add has to argue with this test.
      for (const stale of [
        '/gdpr',
        '/guides',
        '/blogs',
        '/sitemap',
        '/accessibility',
        '/cookie-policy',
        '/term-of-service',
        '/privacy-policy',
        '/forgot-password',
        '/reset-password',
        '/verify',
      ]) {
        expect(
          PUBLIC_ROUTES.map(toPath),
          `${stale} is public again but still has no page`
        ).not.toContain(stale);
        expect(RENDERABLE.has(stale)).toBe(false);
      }
    });

    it('lists each route once', () => {
      expect(new Set(PUBLIC_ROUTES).size).toBe(PUBLIC_ROUTES.length);
    });
  });

  describe('KNOWN_APP_ROUTES', () => {
    it('covers every public route, or the public route can never be reached', () => {
      // middleware.ts returns the 404 for anything outside KNOWN_APP_ROUTES
      // before it ever consults isPublicRoute.
      const known = KNOWN_APP_ROUTES.map(toPath);
      for (const entry of PUBLIC_ROUTES) {
        const publicPath = toPath(entry);
        const covered = known.some(
          (candidate) =>
            publicPath === candidate || publicPath.startsWith(`${candidate}/`)
        );
        expect(covered, `${entry} is public but not a known app route`).toBe(
          true
        );
      }
    });

    it('lists each route once', () => {
      expect(new Set(KNOWN_APP_ROUTES).size).toBe(KNOWN_APP_ROUTES.length);
    });
  });
});
