/**
 * Every route `apps/flowstarter-main/src/app` can serve, read off the disk.
 *
 * This is not the same thing as `apps/flowstarter-main/src/lib/route-manifest.ts`,
 * which is a hand-written allow-list telling `middleware.ts` which paths are
 * reachable without a Clerk session. That file answers "may a stranger open
 * this?"; this one answers "what exists?". `src/__tests__/route-manifest.test.ts`
 * already checks the first against the second. What was missing, and is here,
 * is the API half and a pattern form that a URL seen at runtime can be matched
 * back to, which is what E2E route coverage needs.
 *
 * Patterns keep Next's own syntax, so a route reads the same here as it does
 * in the file tree:
 *
 *   src/app/(dynamic-pages)/dashboard/projects/[workspaceId]/page.tsx
 *     -> /dashboard/projects/[workspaceId]
 *   src/app/api/client/site/[workspaceId]/preview/[[...path]]/route.ts
 *     -> /api/client/site/[workspaceId]/preview/[[...path]]
 *
 * A `(group)` segment is organisational and contributes nothing to the URL.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The app directory, given the repository root.
 *
 * A caller passes the root rather than this module working it out from
 * `import.meta.url`, because Playwright transpiles the files it loads to
 * CommonJS and `import.meta` does not survive that. Node loads this file as
 * real ESM and Playwright loads it as CommonJS; keeping both happy means
 * using neither `import.meta` nor `__dirname` here.
 */
export const appDirFrom = (repoRoot) =>
  path.join(repoRoot, 'apps', 'flowstarter-main', 'src', 'app');

/** `(main-pages)`: organisational, not part of the URL. */
const isRouteGroup = (segment) =>
  segment.startsWith('(') && segment.endsWith(')');

/** `[id]`, `[...slug]`, `[[...index]]`. */
const isDynamicSegment = (segment) =>
  segment.startsWith('[') && segment.endsWith(']');

/** `[[...index]]`: an optional catch-all, so the parent path renders too. */
const isOptionalCatchAll = (segment) =>
  segment.startsWith('[[...') && segment.endsWith(']]');

const IGNORED_DIRS = new Set(['__tests__', 'node_modules', '_components']);

/**
 * The HTTP methods a `route.ts` exports. Next.js only serves the ones that are
 * exported, so a route with `export async function GET` and nothing else is a
 * GET-only surface and asking for its POST is a 405, not a gap in coverage.
 *
 * Read with a regular expression rather than by importing the module: these
 * files pull in Clerk, Supabase, Stripe and the Edge runtime, and this has to
 * run inside a Playwright worker.
 */
function exportedMethods(file) {
  const source = readFileSync(file, 'utf8');
  const methods = new Set();
  const patterns = [
    // export async function GET(...)  /  export function GET(...)
    /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
    // export const GET = ...
    /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*[:=]/g,
    // export { handler as GET, handler as POST }
    /\bas\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) methods.add(match[1]);
  }

  // `export const { GET, POST } = createRouteHandler(...)` is a destructured
  // re-export, which is how the uploadthing route is written. The patterns
  // above only see named bindings, so read the braces too.
  for (const match of source.matchAll(/export\s+const\s*\{([^}]*)\}\s*=/g)) {
    for (const name of match[1].split(',')) {
      const method = name.trim().split(':').pop().trim();
      if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) {
        methods.add(method);
      }
    }
  }

  return [...methods].sort();
}

/**
 * Walk `src/app` once, collecting both kinds of route.
 *
 * @returns {{pages: Array<{pattern: string, file: string, dynamic: boolean}>,
 *            api: Array<{pattern: string, file: string, methods: string[]}>}}
 */
export function collectRoutes(appDir) {
  const pages = [];
  const api = [];

  const toPattern = (segments) =>
    `/${segments.join('/')}`.replace(/\/+$/, '') || '/';

  const walk = (dir, segments) => {
    const pageFile = path.join(dir, 'page.tsx');
    if (existsSync(pageFile)) {
      // `/login/[[...index]]` stays one entry, not two: `patternToRegExp`
      // makes the optional catch-all match the bare `/login` as well, so
      // splitting it here would count one page file as two surfaces and
      // permanently hold the percentage down.
      pages.push({
        pattern: toPattern(segments),
        file: path.relative(appDir, pageFile),
        dynamic: segments.some(isDynamicSegment),
      });
    }

    const routeFile = path.join(dir, 'route.ts');
    if (existsSync(routeFile)) {
      api.push({
        pattern: toPattern(segments),
        file: path.relative(appDir, routeFile),
        methods: exportedMethods(routeFile),
      });
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      walk(
        child,
        isRouteGroup(entry.name) ? segments : [...segments, entry.name],
      );
    }
  };

  walk(appDir, []);

  const byPattern = (a, b) => a.pattern.localeCompare(b.pattern);
  // A pattern can be produced twice (a page and its optional catch-all parent).
  const dedupe = (list) => {
    const seen = new Map();
    for (const item of list)
      if (!seen.has(item.pattern)) seen.set(item.pattern, item);
    return [...seen.values()].sort(byPattern);
  };

  return { pages: dedupe(pages), api: dedupe(api) };
}

/**
 * A regular expression that matches the URL paths a pattern can serve.
 *
 * `[id]` takes one segment, `[...slug]` takes one or more, `[[...path]]` takes
 * zero or more. Anchored at both ends so `/api/client/site` never swallows
 * `/api/client/site/x/publish`.
 */
export function patternToRegExp(pattern) {
  if (pattern === '/') return /^\/$/;

  const source = pattern
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (isOptionalCatchAll(segment)) return '(?:/[^?#]*)?';
      if (segment.startsWith('[...') && segment.endsWith(']')) return '/[^?#]+';
      if (isDynamicSegment(segment)) return '/[^/?#]+';
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');

  return new RegExp(`^${source}/?$`);
}

/**
 * The pattern a concrete path belongs to, or null when nothing serves it.
 *
 * Literal patterns win over dynamic ones, and a longer literal prefix wins
 * over a shorter one, so `/api/team/projects/draft` is credited to its own
 * route and not to `/api/team/projects/[id]`.
 */
export function matchPattern(pathname, patterns) {
  const candidates = patterns.filter((pattern) =>
    patternToRegExp(pattern).test(pathname),
  );
  if (candidates.length === 0) return null;

  const score = (pattern) => {
    const segments = pattern.split('/').filter(Boolean);
    const literals = segments.filter((s) => !isDynamicSegment(s)).length;
    return literals * 1000 + segments.length;
  };

  return candidates.sort((a, b) => score(b) - score(a))[0];
}

/** Normalise a URL (absolute or relative) to the path a pattern can match. */
export function toPathname(url, origin) {
  try {
    const parsed = new URL(url, origin || 'http://localhost');
    return parsed.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}
