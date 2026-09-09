/**
 * The Playwright `test` every spec in this directory imports.
 *
 * It is `@playwright/test`'s own `test` with one thing added: while a test
 * runs, every URL the browser navigates to and every request it or the
 * `request` fixture sends to the application origin is recorded, normalised
 * to a route pattern from `route-manifest.mjs`, and written to
 * `test-results/route-coverage/<test>.json`. `scripts/e2e-route-coverage.mjs`
 * merges those files into "the suite touched N of M pages and P of Q API
 * routes".
 *
 * Why it lives in a fixture rather than in each spec: a spec that has to
 * remember to record is a spec that will forget. The only change a spec makes
 * is its import line.
 *
 * What counts as coverage here is *reached*, not *asserted*. A page the suite
 * opens and never looks at still shows up. That is deliberate: this number
 * answers "what does CI never visit at all", which is a different and much
 * weaker question than "what does CI check", and the readiness scorecard is
 * where the stronger question is asked.
 *
 * Requests to a third-party origin (Clerk, Stripe, Netlify's own assets) are
 * dropped: they are not this application's routes.
 */
import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  appDirFrom,
  collectRoutes,
  matchPattern,
  toPathname,
} from './route-manifest.mjs';

export { expect };

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Where the per-test records go.
 *
 * `test-results/route-coverage` by default, which is where
 * `scripts/e2e-route-coverage.mjs` looks. Playwright empties `test-results`
 * at the start of every run, so a job that invokes `playwright test` more
 * than once (the release lane runs the contract spec, the production
 * synthetic and the authenticated journey separately) would keep only the
 * last set. Those jobs set `ROUTE_COVERAGE_DIR` to somewhere Playwright does
 * not clean and pass the same path to the script with `--input`.
 */
const OUTPUT_DIR = process.env.ROUTE_COVERAGE_DIR
  ? path.resolve(REPO_ROOT, process.env.ROUTE_COVERAGE_DIR)
  : path.join(REPO_ROOT, 'test-results', 'route-coverage');

// Read the file tree once per worker, not once per test.
const ROUTES = collectRoutes(appDirFrom(REPO_ROOT));
const PAGE_PATTERNS = ROUTES.pages.map(
  (route: { pattern: string }) => route.pattern,
);
const API_PATTERNS = ROUTES.api.map(
  (route: { pattern: string }) => route.pattern,
);

/**
 * How the request was made.
 *
 * `navigation` is the browser opening a page. `asset` is everything else the
 * browser fetches for it (a prefetch, an RSC payload, an image), which
 * reaches a route but is not a visit to it. `direct` is the `request`
 * fixture, which has no browser and no prefetching, so a page path it asks
 * for was genuinely asked for.
 */
type RequestKind = 'navigation' | 'asset' | 'direct';

type Recorder = {
  pages: Set<string>;
  api: Set<string>;
  /** Paths that reached the app origin but matched no known route. */
  unmatched: Set<string>;
  note: (url: string, method: string, kind: RequestKind) => void;
};

/** Turn a spec title into something a file system will accept. */
function slugify(parts: string[]): string {
  return (
    parts
      .join('-')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120)
      .toLowerCase() || 'test'
  );
}

function createRecorder(baseURL: string | undefined): Recorder {
  const pages = new Set<string>();
  const api = new Set<string>();
  const unmatched = new Set<string>();

  const sameOrigin = (url: string): boolean => {
    if (!baseURL) return url.startsWith('/');
    try {
      return new URL(url, baseURL).origin === new URL(baseURL).origin;
    } catch {
      return false;
    }
  };

  return {
    pages,
    api,
    unmatched,
    note(url, method, kind) {
      if (!sameOrigin(url)) return;

      const pathname = toPathname(url, baseURL);
      if (!pathname) return;

      // Next.js internals and static assets are not routes anyone wrote.
      if (
        pathname.startsWith('/_next') ||
        pathname.startsWith('/__nextjs') ||
        /\.(?:js|css|map|png|jpe?g|svg|webp|avif|ico|woff2?|ttf|txt|xml|json)$/.test(
          pathname,
        )
      ) {
        return;
      }

      if (pathname.startsWith('/api')) {
        const matched = matchPattern(pathname, API_PATTERNS);
        if (matched) api.add(`${method.toUpperCase()} ${matched}`);
        else unmatched.add(`${method.toUpperCase()} ${pathname}`);
        return;
      }

      // A page counts when it is navigated to, or when the `request` fixture
      // asked for it by hand. A prefetch or an RSC payload the browser
      // fetched for a page nobody opened is not a visit.
      if (kind === 'asset') return;

      const matched = matchPattern(pathname, PAGE_PATTERNS);
      if (matched) pages.add(matched);
      else unmatched.add(`GET ${pathname}`);
    },
  };
}

/**
 * `APIRequestContext` emits no events, so the only way to see what a spec asks
 * for through the `request` fixture is to stand in front of its methods.
 */
function watchRequestContext(
  context: APIRequestContext,
  recorder: Recorder,
): APIRequestContext {
  const verbs: Record<string, string> = {
    get: 'GET',
    post: 'POST',
    put: 'PUT',
    patch: 'PATCH',
    delete: 'DELETE',
    head: 'HEAD',
  };

  return new Proxy(context, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') {
        return value;
      }

      const verb = verbs[property];
      const isFetch = property === 'fetch';
      if (!verb && !isFetch) return value.bind(target);

      return (...args: unknown[]) => {
        const [url, options] = args as [
          string | { url?: () => string },
          { method?: string } | undefined,
        ];
        const href = typeof url === 'string' ? url : url?.url?.();
        if (href) {
          recorder.note(href, verb ?? options?.method ?? 'GET', 'direct');
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as APIRequestContext;
}

function watchPage(page: Page, recorder: Recorder): void {
  page.on('request', (request) => {
    recorder.note(
      request.url(),
      request.method(),
      request.isNavigationRequest() && request.frame() === page.mainFrame()
        ? 'navigation'
        : 'asset',
    );
  });
}

export const test = base.extend<{
  routeRecorder: Recorder;
  page: Page;
  request: APIRequestContext;
}>({
  routeRecorder: [
    async ({ baseURL }, use, testInfo) => {
      const recorder = createRecorder(baseURL);
      await use(recorder);

      // One file per test, so parallel workers never write the same path and
      // a merge is a directory read rather than a lock.
      mkdirSync(OUTPUT_DIR, { recursive: true });
      const name = slugify([
        path.basename(testInfo.file).replace(/\.spec\.ts$/, ''),
        testInfo.project.name,
        ...testInfo.titlePath,
        String(testInfo.repeatEachIndex),
      ]);
      writeFileSync(
        path.join(OUTPUT_DIR, `${name}.json`),
        `${JSON.stringify(
          {
            title: testInfo.titlePath.join(' > '),
            file: path.relative(REPO_ROOT, testInfo.file),
            project: testInfo.project.name,
            status: testInfo.status ?? 'unknown',
            baseURL: baseURL ?? null,
            pages: [...recorder.pages].sort(),
            api: [...recorder.api].sort(),
            unmatched: [...recorder.unmatched].sort(),
          },
          null,
          2,
        )}\n`,
      );
    },
    { auto: true },
  ],

  page: async ({ page, routeRecorder }, use) => {
    watchPage(page, routeRecorder);
    await use(page);
  },

  request: async ({ request, routeRecorder }, use) => {
    await use(watchRequestContext(request, routeRecorder));
  },
});
