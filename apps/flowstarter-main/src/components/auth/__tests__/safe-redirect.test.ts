/**
 * The redirect gate the sign-in form navigates through.
 *
 * `LoginForm` reads `redirect_url` and `next` from the query string, so both
 * are attacker-controlled. `toSameOriginPath` is the only value that reaches
 * `window.location`, and this suite holds it to that: the open-redirect
 * payloads below have to come back `null`, and the paths the product actually
 * uses have to survive untouched.
 *
 * The helper lives in the design system
 * (`packages/flow-design-system/src/utils/safe-redirect.ts`), which has no test
 * runner of its own, so its tests live here next to the app that renders the
 * form.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_REDIRECT_PATH,
  TEAM_REDIRECT_PATH,
  toSameOriginPath,
  toTrustedHandoffUrl,
} from '@flowstarter/flow-design-system';

const ORIGIN = 'https://app.flowstarter.dev';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('toSameOriginPath', () => {
  it('keeps the paths sign-in actually redirects to', () => {
    expect(toSameOriginPath('/dashboard', ORIGIN)).toBe('/dashboard');
    expect(toSameOriginPath('/admin/dashboard?tab=x', ORIGIN)).toBe(
      '/admin/dashboard?tab=x'
    );
    expect(toSameOriginPath('/admin/projects/42#log', ORIGIN)).toBe(
      '/admin/projects/42#log'
    );
  });

  it('collapses a same-origin absolute URL to its path', () => {
    expect(toSameOriginPath(`${ORIGIN}/admin/dashboard?tab=x`, ORIGIN)).toBe(
      '/admin/dashboard?tab=x'
    );
  });

  it.each([
    ['protocol-relative', '//evil.example'],
    ['protocol-relative with a path', '//evil.example/dashboard'],
    ['absolute on another origin', 'https://evil.example'],
    [
      'absolute on a lookalike subdomain',
      'https://app.flowstarter.dev.evil.example/x',
    ],
    ['backslash authority', '/\\evil.example'],
    ['backslash after a slash', '//\\evil.example'],
    ['encoded double slash', '/%2F%2Fevil.example'],
    ['encoded backslash', '/%5Cevil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    [
      'credentials in the authority',
      'https://evil.example@app.flowstarter.dev',
    ],
    ['authority wearing a path', '/@evil.example'],
    ['not rooted', 'dashboard'],
    ['bare host', 'evil.example/dashboard'],
    ['empty', ''],
    ['whitespace', '   '],
  ])('rejects %s', (_label, candidate) => {
    expect(toSameOriginPath(candidate, ORIGIN)).toBeNull();
  });

  it('rejects a missing value and a missing origin', () => {
    expect(toSameOriginPath(null, ORIGIN)).toBeNull();
    expect(toSameOriginPath(undefined, ORIGIN)).toBeNull();
    expect(toSameOriginPath('/dashboard', null)).toBeNull();
  });

  it('exposes the defaults the form falls back to', () => {
    expect(CLIENT_REDIRECT_PATH).toBe('/dashboard');
    expect(TEAM_REDIRECT_PATH).toBe('/admin/dashboard');
    expect(toSameOriginPath(CLIENT_REDIRECT_PATH, ORIGIN)).toBe(
      CLIENT_REDIRECT_PATH
    );
    expect(toSameOriginPath(TEAM_REDIRECT_PATH, ORIGIN)).toBe(
      TEAM_REDIRECT_PATH
    );
  });
});

describe('toTrustedHandoffUrl', () => {
  it('accepts another origin on the same platform domain', () => {
    vi.stubEnv('PLATFORM_DOMAIN', 'flowstarter.dev');
    expect(
      toTrustedHandoffUrl('https://editor.flowstarter.dev/projects/1', ORIGIN)
    ).toBe('https://editor.flowstarter.dev/projects/1');
  });

  it.each([
    ['another platform entirely', 'https://evil.example/'],
    ['a lookalike domain', 'https://flowstarter.dev.evil.example/'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a relative path', '/dashboard'],
    [
      'credentials in the authority',
      'https://evil.example@editor.flowstarter.dev/',
    ],
    ['empty', ''],
  ])('rejects %s', (_label, candidate) => {
    vi.stubEnv('PLATFORM_DOMAIN', 'flowstarter.dev');
    expect(toTrustedHandoffUrl(candidate, ORIGIN)).toBeNull();
  });

  it('returns null for the current origin, which needs no hand-off', () => {
    vi.stubEnv('PLATFORM_DOMAIN', 'flowstarter.dev');
    expect(toTrustedHandoffUrl(`${ORIGIN}/dashboard`, ORIGIN)).toBeNull();
  });
});
