/**
 * Arcjet's `detectBot` fingerprints exactly what a signature-authenticated
 * server caller looks like — no browser headers, no session, python's own
 * `User-Agent`. Cal.com's webhook delivery and the build worker's deploy
 * callback are both real, legitimate traffic of that shape, so running the
 * full `browser` Arcjet policy against them would 403 a correctly-signed
 * delivery before the route itself ever got to check the signature — which
 * is the actual authentication for both.
 *
 * `arcjetPolicyFor` (in `@/lib/route-manifest`) is what decides browser vs.
 * machine vs. none; it is pure, so it is tested directly here. `middleware.ts`
 * itself pulls in Clerk and the Edge runtime and is "unimportable in a unit
 * suite" (see `lead-capture-middleware.test.ts`), so the wiring from policy
 * to Arcjet client is pinned the same way that file pins its own exemptions:
 * reading the source rather than booting it. Together these two are the test
 * for "a python user agent is refused on /api/contact and accepted through to
 * the signature check on the Cal route and the worker callback route" — the
 * refusal/pass-through itself is exactly what `browser` running `detectBot`
 * and `machine` not running it produces, which is what the second half below
 * pins on `src/lib/arcjet.ts`.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { arcjetPolicyFor, PUBLIC_ROUTES } from '@/lib/route-manifest';

describe('arcjetPolicyFor', () => {
  it('is "none" for webhooks and health, same as today', () => {
    expect(arcjetPolicyFor('/api/webhooks/stripe')).toBe('none');
    expect(arcjetPolicyFor('/api/webhooks/cal')).toBe('none');
    expect(arcjetPolicyFor('/api/health')).toBe('none');
    expect(arcjetPolicyFor('/api/health/db')).toBe('none');
  });

  it('is "machine" for the build worker callback', () => {
    expect(arcjetPolicyFor('/api/internal/build/deploy')).toBe('machine');
    // Every route under the prefix, not only the one that exists today.
    expect(arcjetPolicyFor('/api/internal/anything-added-later')).toBe(
      'machine'
    );
  });

  it('is "machine" for Cal.com\'s webhook delivery', () => {
    expect(
      arcjetPolicyFor('/api/integrations/cal/0f4e1088-8d8f-4f18-83b1')
    ).toBe('machine');
  });

  it('is "browser" — the default — for an ordinary anonymous API route', () => {
    expect(arcjetPolicyFor('/api/contact')).toBe('browser');
    expect(arcjetPolicyFor('/api/discovery/preview/live')).toBe('browser');
    expect(arcjetPolicyFor('/api/leads/capture/abc')).toBe('browser');
  });

  it('does not widen the machine allow-list past the two known callers', () => {
    // A route elsewhere under /api/integrations (portrait connect, etc.) is
    // browser-facing or its own signed-state flow, not this allow-list.
    expect(arcjetPolicyFor('/api/integrations/other')).toBe('browser');
  });

  it(
    'only allow-lists paths that are also session-exempt, so a caller with ' +
      'no Clerk session and no bot check still needs its own authentication',
    () => {
      for (const prefix of [
        '/api/internal/build/deploy',
        '/api/integrations/cal/x',
      ]) {
        expect(arcjetPolicyFor(prefix)).toBe('machine');
      }
      expect(PUBLIC_ROUTES).toContain('/api/internal(.*)');
      expect(PUBLIC_ROUTES).toContain('/api/integrations/cal/(.*)');
    }
  );
});

describe('the machine policy is wired to a client with no bot detection', () => {
  const ARCJET_SOURCE = readFileSync(
    path.resolve(__dirname, '..', 'lib', 'arcjet.ts'),
    'utf8'
  );
  const MIDDLEWARE_SOURCE = readFileSync(
    path.resolve(__dirname, '..', 'middleware.ts'),
    'utf8'
  );

  it("ajMachine's rules do not include detectBot", () => {
    const start = ARCJET_SOURCE.indexOf('export const ajMachine');
    expect(start).toBeGreaterThan(-1);
    const end = ARCJET_SOURCE.indexOf('\n});', start);
    const body = ARCJET_SOURCE.slice(start, end);
    expect(body).toContain('shield(');
    expect(body).toContain('slidingWindow(');
    expect(body).not.toContain('detectBot(');
  });

  it("ajWithRateLimit — the browser policy's client — still runs detectBot", () => {
    const start = ARCJET_SOURCE.indexOf('export const ajWithRateLimit');
    const end = ARCJET_SOURCE.indexOf('\n});', start);
    const body = ARCJET_SOURCE.slice(start, end);
    expect(body).toContain('detectBot(');
  });

  it('middleware picks ajMachine only for the machine policy', () => {
    // Whitespace-insensitive: this only pins that both identifiers appear on
    // the same ternary, not the exact wrapping Prettier chose for the line.
    const normalized = MIDDLEWARE_SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "arcjetPolicy === 'machine' ? ajMachine : ajWithRateLimit"
    );
    expect(MIDDLEWARE_SOURCE).toContain('arcjetPolicyFor(pathname)');
  });
});
