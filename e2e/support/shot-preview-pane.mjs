// Screenshots the wizard's preview step with a real generated site in the
// pane, without waiting on a build: the draft is seeded at the preview step
// and the live-build endpoints are answered locally with SITE_URL.
//
//   SITE_URL=http://127.0.0.1:8913/ APP_ORIGIN=http://localhost:3005 \
//     node e2e/support/shot-preview-pane.mjs
import { chromium } from '@playwright/test';

const BASE = process.env.APP_ORIGIN ?? 'http://localhost:3005';
const SITE_URL = process.env.SITE_URL ?? 'http://127.0.0.1:8931/';
const OUT = process.env.OUT_PREFIX ?? '/tmp/fs-preview-pane';
const SIZES = process.env.SIZES
  ? process.env.SIZES.split(',').map((s) => s.split('x').map(Number))
  : [
      [1440, 900],
      [1920, 1080],
      [1280, 800],
    ];

const draft = {
  step: 8,
  answered: [],
  data: {
    fullName: 'Maria Ionescu',
    email: 'maria.ionescu+shot@example.com',
    businessName: 'Marsh & Fern',
    industry: 'consulting',
    description: 'Operations consulting for small manufacturers.',
    targetAudience: 'Owners of 20 to 200 person manufacturing firms.',
    goal: 'leads',
    secondaryGoals: ['trust'],
    brandTone: 'trustworthy',
    pageCount: 'medium',
    timeline: '4w',
    commerceMode: 'none',
    catalogSize: 'na',
    selectedTier: 'pro',
    subscription: 'pro',
    billingCadence: 'monthly',
    instagramUrl: '',
    linkedinUrl: '',
    calComUrl: '',
    customIntegrations: '',
    phone: '',
    services: [],
    intakeAnswers: [],
    intakeChat: [],
    intakeChatDocuments: [],
    intakeChatStatus: 'done',
  },
};

const browser = await chromium.launch({
  args: ['--disable-features=site-per-process'],
});
for (const [width, height] of SIZES) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await context.route('**/api/discovery/preview/live', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ demoId: 'shot-demo' }),
    }),
  );
  await context.route('**/api/discovery/preview/live/stream**', (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body: `event: ready\ndata: ${JSON.stringify({ previewUrl: SITE_URL, personalized: true })}\n\n`,
    }),
  );
  await context.route('**/api/discovery/preview/live?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ready',
        previewUrl: SITE_URL,
        personalized: true,
      }),
    }),
  );
  await context.addInitScript((d) => {
    sessionStorage.setItem('fs-discovery-draft-v1', JSON.stringify(d));
  }, draft);

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.getByTestId('open-discovery').first().click();
  const frame = page.getByTitle('Live site preview');
  await frame.waitFor({ timeout: 60000 });
  await page.waitForTimeout(4000);

  const metrics = await page.evaluate(() => {
    const box = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    const dialog = document.querySelector('[role="dialog"] > div');
    const viewport = document.querySelector(
      '[data-testid="concierge-site-viewport"]',
    );
    const iframe = document.querySelector('iframe[title="Live site preview"]');
    const log = document.querySelector('[role="log"]');
    return {
      modal: box(dialog),
      pane: box(viewport),
      scale: viewport?.getAttribute('data-scale'),
      frameLayoutWidth: iframe?.style.width,
      conversation: box(log),
    };
  });
  console.log(`${width}x${height}`, JSON.stringify(metrics));
  await page.screenshot({ path: `${OUT}-${width}.png` });
  await context.close();
}
await browser.close();
