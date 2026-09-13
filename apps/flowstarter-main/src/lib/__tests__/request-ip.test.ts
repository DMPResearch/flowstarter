/**
 * Security audit 2026-09-13 (Claude, H3): every per-IP limiter used to read
 * `x-forwarded-for.split(',')[0]` — the LEFTMOST entry, which a client sends
 * and controls. This is the regression suite for `clientIp()`, the single
 * replacement: a spoofed leftmost value must never change the derived
 * client IP (and therefore never change a rate limiter's key).
 */
import { describe, expect, it } from 'vitest';
import {
  clientIp,
  defaultTrustedProxies,
  NO_FORWARDED_HEADER,
  type ClientIpEnv,
} from '../request-ip';

function headersOf(values: Record<string, string>): {
  get(name: string): string | null;
} {
  const lower = new Map(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    get(name: string) {
      return lower.get(name.toLowerCase()) ?? null;
    },
  };
}

const PROD_ENV: ClientIpEnv = { FLOWSTARTER_ENV: 'production' };
const STAGING_ENV: ClientIpEnv = { FLOWSTARTER_ENV: 'staging' };
const DEV_ENV: ClientIpEnv = { FLOWSTARTER_ENV: 'development' };

describe('clientIp — the core H3 regression: a spoofed leftmost value never wins', () => {
  it('behind the default loopback-trusted Caddy hop, returns the rightmost (real) address, not the attacker-supplied leftmost one', () => {
    const headers = headersOf({
      // The attacker's own header, then Caddy's appended real peer address.
      'x-forwarded-for': '6.6.6.6, 203.0.113.9',
      'x-real-ip': '127.0.0.1',
    });
    const ip = clientIp(headers, PROD_ENV);
    expect(ip).toBe('203.0.113.9');
    expect(ip).not.toBe('6.6.6.6');
  });

  it('the limiter key is identical whether or not the attacker prepends a spoofed value, given the same real peer', () => {
    const spoofed = headersOf({
      'x-forwarded-for': '9.9.9.9, 203.0.113.9',
    });
    const clean = headersOf({
      'x-forwarded-for': '203.0.113.9',
    });
    expect(clientIp(spoofed, PROD_ENV)).toBe(clientIp(clean, PROD_ENV));
  });

  it('a chain of multiple spoofed hops in front of the real address still yields the real address', () => {
    const headers = headersOf({
      'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.42',
    });
    expect(clientIp(headers, PROD_ENV)).toBe('203.0.113.42');
  });
});

describe('clientIp — trusted proxy configuration', () => {
  it('defaults to loopback-only in production and staging', () => {
    const loopback = ['127.0.0.1/32', '::1/128', '::ffff:127.0.0.0/104'];
    expect(defaultTrustedProxies(PROD_ENV)).toEqual(loopback);
    expect(defaultTrustedProxies(STAGING_ENV)).toEqual(loopback);
  });

  it('trusts nothing by default in development, so X-Forwarded-For is never honoured', () => {
    expect(defaultTrustedProxies(DEV_ENV)).toEqual([]);
    const headers = headersOf({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    // With nothing trusted, the rightmost entry is itself untrusted and is
    // returned — the walk never reaches past the first (rightmost) hop, but
    // note it still is NOT the spoofed leftmost value.
    expect(clientIp(headers, DEV_ENV)).toBe('203.0.113.9');
  });

  it('an explicit FLOWSTARTER_TRUSTED_PROXIES overrides the environment default', () => {
    const env: ClientIpEnv = {
      FLOWSTARTER_ENV: 'production',
      FLOWSTARTER_TRUSTED_PROXIES: '10.0.0.0/8',
    };
    const headers = headersOf({
      // Under the default (loopback-only), 127.0.0.1 would be trusted and
      // peeled, yielding 10.1.2.3. Under this override, only 10.0.0.0/8 is
      // trusted, so 127.0.0.1 is now the untrusted rightmost hop instead.
      'x-forwarded-for': '10.1.2.3, 127.0.0.1',
    });
    expect(clientIp(headers, env)).toBe('127.0.0.1');
    expect(clientIp(headers, PROD_ENV)).toBe('10.1.2.3');
  });

  it('the "cloudflare" named group trusts Cloudflare\'s published ranges when configured', () => {
    const env: ClientIpEnv = {
      FLOWSTARTER_ENV: 'production',
      FLOWSTARTER_TRUSTED_PROXIES: 'loopback,cloudflare',
    };
    const headers = headersOf({
      // real client, Cloudflare edge, Caddy's own loopback hop.
      'x-forwarded-for': '203.0.113.9, 104.16.1.1, 127.0.0.1',
    });
    expect(clientIp(headers, env)).toBe('203.0.113.9');
  });

  it('does not trust a Cloudflare address when "cloudflare" is not in the configured list', () => {
    const headers = headersOf({
      'x-forwarded-for': '203.0.113.9, 104.16.1.1',
    });
    // Only loopback trusted by default: 104.16.1.1 is the rightmost hop and
    // is not a trusted proxy, so it is (incorrectly, but safely) treated as
    // the client — this is exactly why "cloudflare" must be turned on
    // explicitly once a hostname is actually proxied.
    expect(clientIp(headers, PROD_ENV)).toBe('104.16.1.1');
  });
});

describe('clientIp — the required test table: no header, one hop, spoofed prefix, IPv6, malformed', () => {
  it('no header at all falls back to X-Real-Ip', () => {
    const headers = headersOf({ 'x-real-ip': '203.0.113.5' });
    expect(clientIp(headers, PROD_ENV)).toBe('203.0.113.5');
  });

  it('no header and no X-Real-Ip returns the named sentinel, never the string "unknown"', () => {
    const headers = headersOf({});
    expect(clientIp(headers, PROD_ENV)).toBe(NO_FORWARDED_HEADER);
    expect(clientIp(headers, PROD_ENV)).not.toBe('unknown');
  });

  it('a single untrusted hop is returned as-is', () => {
    const headers = headersOf({ 'x-forwarded-for': '203.0.113.77' });
    expect(clientIp(headers, PROD_ENV)).toBe('203.0.113.77');
  });

  it('a spoofed prefix ahead of the real address is ignored', () => {
    const headers = headersOf({
      'x-forwarded-for': '  198.51.100.1  ,  203.0.113.9  ',
    });
    expect(clientIp(headers, PROD_ENV)).toBe('203.0.113.9');
  });

  it('handles an IPv6 real address behind the trusted loopback hop', () => {
    const headers = headersOf({
      'x-forwarded-for': '2001:db8::dead:beef',
      'x-real-ip': '::1',
    });
    expect(clientIp(headers, PROD_ENV)).toBe('2001:db8::dead:beef');
  });

  it('trusts the IPv6 loopback (::1) as a proxy hop the same as 127.0.0.1', () => {
    const headers = headersOf({
      'x-forwarded-for': '2001:db8::1, ::1',
    });
    expect(clientIp(headers, PROD_ENV)).toBe('2001:db8::1');
  });

  it('an IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) is still recognised as loopback', () => {
    const headers = headersOf({
      'x-forwarded-for': '203.0.113.9, ::ffff:127.0.0.1',
    });
    expect(clientIp(headers, PROD_ENV)).toBe('203.0.113.9');
  });

  it('a malformed rightmost entry is returned verbatim rather than throwing', () => {
    const headers = headersOf({
      'x-forwarded-for': '203.0.113.9, not-an-ip-at-all',
    });
    expect(() => clientIp(headers, PROD_ENV)).not.toThrow();
    expect(clientIp(headers, PROD_ENV)).toBe('not-an-ip-at-all');
  });

  it('an empty X-Forwarded-For value falls back to X-Real-Ip', () => {
    const headers = headersOf({ 'x-forwarded-for': '', 'x-real-ip': '203.0.113.1' });
    expect(clientIp(headers, PROD_ENV)).toBe('203.0.113.1');
  });

  it('a chain made entirely of trusted hops falls back to the leftmost rather than throwing', () => {
    const headers = headersOf({ 'x-forwarded-for': '127.0.0.1, ::1' });
    expect(clientIp(headers, PROD_ENV)).toBe('127.0.0.1');
  });

  it('an IPv4 entry carrying a stray port is matched against loopback correctly', () => {
    const headers = headersOf({
      'x-forwarded-for': '203.0.113.9, 127.0.0.1:5000',
    });
    expect(clientIp(headers, PROD_ENV)).toBe('203.0.113.9');
  });
});
