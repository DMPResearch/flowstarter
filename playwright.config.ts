import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
// Side effect: loads apps/flowstarter-main/.env.local so Clerk keys reach both
// this config and the test workers.
import { STORAGE_STATE } from './e2e/support/clerk-env';

// The visual-regression projects (screenshot comparisons against committed
// Linux baselines) are opt-in via VISUAL_CHECK=1. The pre-push hook
// (`.husky/pre-push`) and `pnpm run ci:smoke:platform` both run
// `playwright test --config playwright.config.ts` with no --project flag,
// which executes every project below — so the visual projects must stay out
// of that default array and only appear when the visual-check workflow (or
// a developer refreshing baselines locally) explicitly opts in. See
// e2e/visual/README.md.
const VISUAL_CHECK = process.env.VISUAL_CHECK === '1';

// The production synthetic (e2e/prod-synthetic.spec.ts) reads a live, deployed
// site. It is opt-in via PROD_SYNTHETIC=1 for the same reason the visual
// projects are opt-in: `playwright test` with no --project runs every project
// in the array below, and the pre-push hook plus `pnpm run ci:smoke:platform`
// both do exactly that. Only .depot/workflows/prod-synthetic.yml sets the
// variable. The `chromium` project ignores the file so the synthetic never
// runs against a Deploy Preview by accident.
const PROD_SYNTHETIC = process.env.PROD_SYNTHETIC === '1';

// The daily QA journeys (e2e/qa/*.qa.spec.ts) walk a live deployment, sign in
// as the two QA users, and answer the intake conversation as a canary
// business. Opt-in via QA_JOURNEYS=1 for the same reason as the two flags
// above, and for one more: unlike every other project here, this one WRITES.
// Only .depot/workflows/daily-qa.yml sets the variable.
const QA_JOURNEYS = process.env.QA_JOURNEYS === '1';

const projects: NonNullable<PlaywrightTestConfig['projects']> = [
  {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
    // Authenticated specs run in `chromium-auth`; the setup project is not a
    // test suite; visual specs run in the dedicated visual-* projects only.
    // Everything else stays unauthenticated, as it was.
    testIgnore: [
      /\.auth\.spec\.ts$/,
      /global\.setup\.ts$/,
      /\.visual\.spec\.ts$/,
      // Belongs to the opt-in `prod-synthetic` project below; it targets
      // production, not this project's Deploy Preview base URL.
      /prod-synthetic\.spec\.ts$/,
      // Belongs to the opt-in `qa-journeys` project below; it targets a live
      // deployment and it writes.
      /\.qa\.spec\.ts$/,
    ],
  },
  {
    name: 'setup',
    testMatch: /global\.setup\.ts$/,
    use: { ...devices['Desktop Chrome'] },
  },
  {
    name: 'chromium-auth',
    testMatch: /\.auth\.spec\.ts$/,
    dependencies: ['setup'],
    use: {
      ...devices['Desktop Chrome'],
      // Written by the setup project after a real Clerk sign-in.
      storageState: STORAGE_STATE,
    },
  },
];

if (PROD_SYNTHETIC) {
  projects.push({
    name: 'prod-synthetic',
    testMatch: /prod-synthetic\.spec\.ts$/,
    use: { ...devices['Desktop Chrome'] },
  });
}

if (QA_JOURNEYS) {
  projects.push({
    name: 'qa-journeys',
    testMatch: /\.qa\.spec\.ts$/,
    use: { ...devices['Desktop Chrome'] },
  });
}

if (VISUAL_CHECK) {
  projects.push(
    {
      name: 'visual-desktop',
      testMatch: /\.visual\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'visual-mobile',
      testMatch: /\.visual\.spec\.ts$/,
      use: {
        // The iPhone 14 device descriptor's viewport, scale factor, and
        // touch emulation, but forced onto Chromium rather than its default
        // `webkit` — CI only installs the chromium browser
        // (`playwright install chromium --with-deps`), matching the
        // `visual-desktop` project and the rest of this config.
        ...devices['Desktop Chrome'],
        viewport: devices['iPhone 14'].viewport,
        deviceScaleFactor: devices['iPhone 14'].deviceScaleFactor,
        isMobile: devices['iPhone 14'].isMobile,
        hasTouch: devices['iPhone 14'].hasTouch,
        userAgent: devices['iPhone 14'].userAgent,
      },
    }
  );
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  // macOS and Linux rasterize fonts/anti-aliasing differently, so keep
  // per-platform baselines apart: darwin snapshots (written by developers
  // running the suite locally) never collide with the linux snapshots that
  // are the only ones committed to the repo and used in CI. See
  // e2e/visual/README.md for the baseline-refresh procedure.
  snapshotPathTemplate:
    '{testDir}/visual/__screenshots__/{platform}/{projectName}/{testFileName}/{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      threshold: 0.2,
      maxDiffPixelRatio: 0.01,
    },
  },

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'on',
    video: 'on-first-retry',
    // The library pages reveal content via scroll animations gated behind
    // `@media (prefers-reduced-motion: no-preference)` (see library.css). Under
    // reduced-motion those `.reveal` elements render immediately (no opacity:0
    // start state), so headings are visible without waiting on an animation /
    // IntersectionObserver that fires unreliably in headless. Emulating reduced
    // motion makes the templates-audit deterministic instead of flaky.
    reducedMotion: 'reduce',
  },

  projects,

  // In CI: PLAYWRIGHT_BASE_URL points at staging — no local server needed.
  // Locally: spin up the dev server.
  ...(process.env.CI
    ? {}
    : {
        webServer: [
          {
            command: 'cd apps/flowstarter-main && npx next dev -p 3000',
            url: 'http://localhost:3000',
            reuseExistingServer: true,
            timeout: 120000,
          },
        ],
      }),
});
