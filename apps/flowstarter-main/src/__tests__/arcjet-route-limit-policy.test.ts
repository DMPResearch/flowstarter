/**
 * A route limiter limits rate, and nothing else.
 *
 * `routeLimiter` used to layer its per-route sliding window onto `aj`, the
 * base client that carries `shield` and `detectBot` at `LIVE`. That meant
 * every rate-limit check re-evaluated bot detection and shield for a request
 * `src/middleware.ts` had already run both against -- and, on the 2026-09-15
 * showcase run, for a request whose bot check the middleware had deliberately
 * dropped to `DRY_RUN` under the #178 recorder allowance.
 *
 * `decisionFromArcjet` flattens any denial to `{ ok: false }`, and
 * `POST /api/discovery/scope` turns that into `429 Retry-After: 60`. So the
 * recorder was told, four times ninety seconds apart, that it had exhausted a
 * ten-per-minute window it had never touched. The window was refilling
 * correctly the whole time; the refusal was a bot denial wearing a rate
 * limit's clothes, and five of eight scenarios could not be filmed.
 *
 * Pinned by reading the source, the same way `arcjet-machine-policy.test.ts`
 * pins `ajMachine`: `src/lib/arcjet.ts` is a module that constructs live
 * Arcjet clients at import time, and booting it in a unit suite to inspect a
 * rule list is not worth it.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ARCJET_SOURCE = readFileSync(
  path.resolve(__dirname, '..', 'lib', 'arcjet.ts'),
  'utf8'
);
const ROUTE_LIMITS_SOURCE = readFileSync(
  path.resolve(__dirname, '..', 'lib', 'security', 'route-limits.ts'),
  'utf8'
);

function clientBody(name: string): string {
  const start = ARCJET_SOURCE.indexOf(`export const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = ARCJET_SOURCE.indexOf('\n});', start);
  return ARCJET_SOURCE.slice(start, end);
}

describe('the route-limit client carries no rule of its own', () => {
  it('ajRouteLimit declares neither shield nor detectBot', () => {
    const body = clientBody('ajRouteLimit');
    expect(body).not.toContain('detectBot(');
    expect(body).not.toContain('shield(');
    expect(body).toContain('rules: []');
  });

  it('routeLimiter builds its sliding window on ajRouteLimit, not on aj', () => {
    expect(ROUTE_LIMITS_SOURCE).toContain('ajRouteLimit.withRule(');
    // `aj` still exists and is still the middleware's; it is just not what a
    // rate limiter runs on. Checked as a whole-word import so `ajRouteLimit`
    // does not satisfy it.
    expect(ROUTE_LIMITS_SOURCE).not.toMatch(/\baj\.withRule\(/);
    expect(ROUTE_LIMITS_SOURCE).not.toMatch(/import \{ aj \}/);
  });

  it('the middleware still runs bot detection for browser traffic', () => {
    // The fix moves bot detection to one place. It must not remove it.
    expect(clientBody('ajWithRateLimit')).toContain('detectBot(');
  });

  it('the recorder allowance still only relaxes detectBot in the middleware', () => {
    const body = clientBody('ajWithRateLimitBotDryRun');
    expect(body).toContain("mode: 'DRY_RUN'");
    expect(body).toContain('shield(');
    expect(body).toContain('slidingWindow(');
  });
});

describe('the recorder allowance reaches the route limits too', () => {
  it('routeLimiter asks the same decision function the middleware asks', () => {
    expect(ROUTE_LIMITS_SOURCE).toContain('isRecorderRequestAllowed');
    expect(ROUTE_LIMITS_SOURCE).toContain('RECORDER_HEADER_NAME');
    expect(ROUTE_LIMITS_SOURCE).toContain('@flowstarter/platform-config');
  });

  it('logs the allowance where a production bundle keeps it', () => {
    // `next.config.mjs` strips every console call except `error` and `warn`
    // from a production build, and staging builds with `NODE_ENV=production`.
    // `console.info` here would be an audit line that does not exist on the
    // one environment the allowance is for.
    const start = ROUTE_LIMITS_SOURCE.indexOf(
      'async function recorderMayBypass'
    );
    expect(start).toBeGreaterThan(-1);
    const body = ROUTE_LIMITS_SOURCE.slice(start, start + 800);
    expect(body).toContain('console.warn');
    expect(body).toContain('security.recorder_allowance');
    expect(body).not.toContain('console.info');
  });
});
