/**
 * Admin + client dashboard breadth check.
 *
 * Walks every team-dashboard route and the client `/dashboard` to confirm
 * each one returns HTTP 200 (or a 30x to login) and renders without
 * runtime crashes. We don't assert authenticated behaviour — that needs
 * Clerk creds — but we DO catch:
 *   - 5xx (server-side throw),
 *   - blank shells (length < 200 chars),
 *   - hard React error boundary text.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./support/coverage-fixture";
import { isNetlifyPreviewDrawerNoise } from "./support/console-noise";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

const TEAM_ROUTES = [
  "/admin/dashboard",
  "/admin/dashboard/clients",
  "/admin/dashboard/projects",
  "/admin/dashboard/hosting",
  "/admin/dashboard/ai-usage",
  "/admin/dashboard/analytics",
  "/admin/dashboard/domains",
  "/admin/dashboard/email",
  "/admin/dashboard/invite",
  "/admin/dashboard/profile",
  "/admin/dashboard/services",
  "/admin/dashboard/team",
];

const CLIENT_ROUTES = ["/dashboard", "/account", "/login"];

async function assertNoRuntimeCrash(page: Page, path: string) {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Filter out the noisy 401-from-Clerk warnings; we expect those when
      // unauthenticated. Real React error boundaries surface different
      // messages.
      //
      // Also drop Netlify's Deploy Preview collaboration drawer being blocked
      // by our own CSP: preview-only tooling the host injects, and the block
      // is the CSP doing its job. See ./support/console-noise.ts.
      if (
        !text.includes("Failed to load resource") &&
        !text.includes("status of 401") &&
        !text.includes("status of 403") &&
        !text.includes("net::ERR") &&
        !isNetlifyPreviewDrawerNoise(text)
      ) {
        consoleErrors.push(`console.error: ${text}`);
      }
    }
  });

  const response = await page.goto(`${BASE}${path}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  expect(response, `no response for ${path}`).not.toBeNull();
  const status = response!.status();
  expect(status, `${path} returned ${status}`).toBeLessThan(500);
  await page.waitForTimeout(800);
  const html = await page.content();
  expect(html.length, `${path} returned suspiciously short HTML`).toBeGreaterThan(200);
  expect(html, `${path} renders an error boundary`).not.toMatch(
    /Application error: a (server|client)-side exception has occurred/i,
  );
  expect(consoleErrors, `${path} has runtime errors:\n${consoleErrors.join("\n")}`).toEqual([]);
}

test.describe("Admin team dashboards (unauthenticated)", () => {
  for (const route of TEAM_ROUTES) {
    test(`route ${route} renders without crash`, async ({ page }) => {
      await assertNoRuntimeCrash(page, route);
    });
  }
});

test.describe("Client surfaces (unauthenticated)", () => {
  for (const route of CLIENT_ROUTES) {
    test(`route ${route} renders without crash`, async ({ page }) => {
      await assertNoRuntimeCrash(page, route);
    });
  }
});

// The console filter itself, checked in place. There is no root vitest
// project to hang a unit test off, so it runs here: it is a pure function and
// needs no page, and this is the spec that depends on it.
test.describe("Netlify drawer console filter", () => {
  // The real message, copied from a run against
  // deploy-preview-37--flowstarter-landing.netlify.app.
  const REAL_DRAWER_MESSAGE =
    "Framing 'https://app.netlify.com/' violates the following Content " +
    'Security Policy directive: "frame-src \'self\' ' +
    "https://accounts.google.com https://*.clerk.accounts.dev " +
    "https://challenges.cloudflare.com https://calendly.com https://cal.com " +
    "https://*.cal.com https://ux-journey.com " +
    "https://lebadusularticoledepescuit.ro https://www.openstreetmap.org " +
    'https://*.daytonaproxy01.net". The request has been blocked.';

  test("ignores the drawer's own violation", () => {
    expect(isNetlifyPreviewDrawerNoise(REAL_DRAWER_MESSAGE)).toBe(true);
  });

  test("does not ignore a host that merely contains the drawer's name", () => {
    const spoofed = REAL_DRAWER_MESSAGE.replace(
      "https://app.netlify.com/",
      "https://evil.example/app.netlify.com/",
    );
    expect(isNetlifyPreviewDrawerNoise(spoofed)).toBe(false);
  });

  test("does not ignore a CSP violation from another host", () => {
    const other = REAL_DRAWER_MESSAGE.replace(
      "https://app.netlify.com/",
      "https://tracker.example/",
    );
    expect(isNetlifyPreviewDrawerNoise(other)).toBe(false);
  });

  test("does not ignore a non-CSP error that names the drawer", () => {
    expect(
      isNetlifyPreviewDrawerNoise(
        "TypeError: failed to load https://app.netlify.com/widget.js",
      ),
    ).toBe(false);
  });
});
