/**
 * The recorder allowance itself (`isRecorderRequestAllowed`, the
 * production/header/secret logic) is a pure function tested directly in
 * `@flowstarter/platform-config` — see
 * `packages/platform-config/test/recorder-allowance.test.ts`.
 *
 * `middleware.ts` pulls in Clerk and the Edge runtime and is "unimportable
 * in a unit suite" (see `lead-capture-middleware.test.ts` and
 * `arcjet-machine-policy.test.ts`, which pin `src/lib/arcjet.ts` and
 * `middleware.ts` the same way this file does). What is left to pin here is
 * the wiring: the recorder-allowance client only relaxes `detectBot`, the
 * allowance is only even considered for the `browser` policy, and it is
 * logged whenever it fires.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ARCJET_SOURCE = readFileSync(
  path.resolve(__dirname, '..', 'lib', 'arcjet.ts'),
  'utf8'
);
const MIDDLEWARE_SOURCE = readFileSync(
  path.resolve(__dirname, '..', 'middleware.ts'),
  'utf8'
);

describe('ajWithRateLimitBotDryRun', () => {
  function ruleBody(): string {
    const start = ARCJET_SOURCE.indexOf(
      'export const ajWithRateLimitBotDryRun'
    );
    expect(start).toBeGreaterThan(-1);
    const end = ARCJET_SOURCE.indexOf('\n});', start);
    return ARCJET_SOURCE.slice(start, end);
  }

  it('runs detectBot at DRY_RUN, not LIVE', () => {
    const body = ruleBody();
    const detectBotStart = body.indexOf('detectBot(');
    expect(detectBotStart).toBeGreaterThan(-1);
    const detectBotEnd = body.indexOf('}),', detectBotStart);
    const detectBotBody = body.slice(detectBotStart, detectBotEnd);
    expect(detectBotBody).toContain("mode: 'DRY_RUN'");
    expect(detectBotBody).not.toContain("mode: 'LIVE'");
  });

  it('keeps shield and the sliding-window rate limit at LIVE', () => {
    const body = ruleBody();
    expect(body).toContain('shield(');
    const shieldStart = body.indexOf('shield(');
    const shieldEnd = body.indexOf('}),', shieldStart);
    expect(body.slice(shieldStart, shieldEnd)).toContain("mode: 'LIVE'");

    expect(body).toContain('slidingWindow(');
    const slidingStart = body.indexOf('slidingWindow(');
    const slidingEnd = body.indexOf('}),', slidingStart);
    const slidingBody = body.slice(slidingStart, slidingEnd);
    expect(slidingBody).toContain("mode: 'LIVE'");
    expect(slidingBody).toContain('max: 20');
  });
});

describe('middleware wiring for the recorder allowance', () => {
  it('imports the recorder allowance from @flowstarter/platform-config', () => {
    expect(MIDDLEWARE_SOURCE).toContain('isRecorderRequestAllowed');
    expect(MIDDLEWARE_SOURCE).toContain('RECORDER_HEADER_NAME');
    expect(MIDDLEWARE_SOURCE).toMatch(
      /from ['"]@flowstarter\/platform-config['"]/
    );
  });

  it('only considers the allowance for the browser policy', () => {
    const normalized = MIDDLEWARE_SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain("arcjetPolicy === 'browser' &&");
  });

  it('selects ajWithRateLimitBotDryRun when the allowance fires, otherwise the existing ternary', () => {
    const normalized = MIDDLEWARE_SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('recorderAllowed ? ajWithRateLimitBotDryRun');
    // The existing machine/browser choice is untouched underneath it.
    expect(normalized).toContain(
      "arcjetPolicy === 'machine' ? ajMachine : ajWithRateLimit"
    );
  });

  it('logs the allowance through the same security-event logger as every other Arcjet outcome', () => {
    expect(MIDDLEWARE_SOURCE).toContain(
      "logSecurityEventEdge('security.recorder_allowance'"
    );
  });
});
