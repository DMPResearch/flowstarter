/**
 * GET /api/locale — the switcher's server side.
 *
 * An explicit choice, a redirect back to where the visitor was, and nothing
 * else: no session, no account, just a cookie write.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { LOCALE_COOKIE_NAME } from '@/lib/locale-resolution';
import { GET } from '../route';

function request(search: string): NextRequest {
  return new NextRequest(`http://localhost/api/locale${search}`);
}

describe('GET /api/locale', () => {
  it('sets the fs_locale cookie to the requested locale and redirects back to `next`', async () => {
    const response = await GET(request('?locale=ro&next=/pricing'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost/pricing');

    const cookie = response.cookies.get(LOCALE_COOKIE_NAME);
    expect(cookie?.value).toBe('ro');
    expect(cookie?.httpOnly).toBeFalsy();
  });

  it('redirects to `/` when `next` is missing', async () => {
    const response = await GET(request('?locale=en'));

    expect(response.headers.get('location')).toBe('http://localhost/');
  });

  it('refuses an absolute URL or a protocol-relative path in `next`, falling back to `/`', async () => {
    const absolute = await GET(
      request('?locale=en&next=https://evil.example/phish')
    );
    expect(absolute.headers.get('location')).toBe('http://localhost/');

    const protocolRelative = await GET(
      request('?locale=en&next=%2F%2Fevil.example')
    );
    expect(protocolRelative.headers.get('location')).toBe('http://localhost/');
  });

  it('rejects an unsupported locale without setting the cookie', async () => {
    const response = await GET(request('?locale=fr&next=/'));

    expect(response.status).toBe(400);
    expect(response.cookies.get(LOCALE_COOKIE_NAME)).toBeUndefined();
  });

  it('rejects a missing locale', async () => {
    const response = await GET(request('?next=/'));

    expect(response.status).toBe(400);
  });
});
