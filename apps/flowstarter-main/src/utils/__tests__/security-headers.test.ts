import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `next-secure-headers` is deliberately NOT mocked. A mock that returned a
// plain record is what hid the production bug: the real
// `createSecureHeaders()` returns an ARRAY of `{ key, value }` pairs, and
// `applySecurityHeaders` used to walk it with `Object.entries`, which shipped
// headers named "0" through "5" with the value "[object Object]" and dropped
// Referrer-Policy and HSTS entirely. The tests below run against the real
// library so that regression fails here instead of on flowstarter.net.
//
// Only `next/server` is stubbed, with a real `Headers` so the case-insensitive
// lookup and the key enumeration behave like a response on the wire.
vi.mock('next/server', () => ({
  NextResponse: class {
    headers = new Headers();
  },
}));

import {
  applySecurityHeaders,
  buildCSPHeader,
  getStaticCSPHeader,
} from '../security-headers';
import type { NextResponse } from 'next/server';

function renderHeaders(nonce?: string, frameable = false): Headers {
  const response = { headers: new Headers() } as unknown as NextResponse;
  applySecurityHeaders(response, nonce, frameable);
  return response.headers;
}

describe('security-headers', () => {
  describe('buildCSPHeader', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
    });

    it('returns a string', () => {
      expect(typeof buildCSPHeader()).toBe('string');
    });

    it('includes default-src self', () => {
      expect(buildCSPHeader()).toContain("default-src 'self'");
    });

    it('includes script-src', () => {
      expect(buildCSPHeader()).toContain('script-src');
    });

    it('includes style-src', () => {
      expect(buildCSPHeader()).toContain('style-src');
    });

    it('includes img-src', () => {
      expect(buildCSPHeader()).toContain('img-src');
    });

    it('allows assets.flowstarter.dev in img-src', () => {
      expect(buildCSPHeader()).toContain('https://assets.flowstarter.dev');
    });

    it('includes frame-ancestors none', () => {
      expect(buildCSPHeader()).toContain("frame-ancestors 'none'");
    });

    it('allows Daytona sandbox previews in frame-src (concierge funnel)', () => {
      // The discovery wizard step-7 live preview frames the generated
      // site running in its Daytona sandbox; without this the browser
      // blocks it under our own CSP and the preview stays blank.
      const frameSrc = buildCSPHeader()
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith('frame-src'));
      expect(frameSrc).toContain('https://*.daytonaproxy01.net');
    });

    it('allows local preview origins in frame-src only in local-preview dev', () => {
      // FLOWSTARTER_LOCAL_PREVIEW serves the generated site from a local
      // astro dev on its own port; the wizard iframe is blocked by our own
      // frame-src unless that origin is allowed. Both showcase filming runs
      // recorded a white pane because of this.
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('FLOWSTARTER_LOCAL_PREVIEW', 'true');
      const frameSrc = buildCSPHeader()
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith('frame-src'));
      expect(frameSrc).toContain('http://127.0.0.1:*');
      expect(frameSrc).toContain('http://localhost:*');
    });

    it('never allows local preview origins in production, even with the flag', () => {
      vi.stubEnv('FLOWSTARTER_LOCAL_PREVIEW', 'true');
      const frameSrc = buildCSPHeader()
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith('frame-src'));
      expect(frameSrc).not.toContain('http://127.0.0.1');
      expect(frameSrc).not.toContain('http://localhost');
    });

    it('includes object-src none', () => {
      expect(buildCSPHeader()).toContain("object-src 'none'");
    });

    it('includes upgrade-insecure-requests in production, where publicAppOrigin() is always https', () => {
      // `buildCSPHeader` only emits this directive when `!isDev` AND
      // `publicAppOrigin()` (platform-config) is https — which it always is
      // in production, regardless of `NEXT_PUBLIC_SITE_URL` (production
      // never consults it). Staging / LAN HTTP access would otherwise
      // silently break (see `utils/security-headers.ts`).
      expect(buildCSPHeader()).toContain('upgrade-insecure-requests');
    });

    it('does NOT emit a per-request nonce in script-src (caching mismatch)', () => {
      // The site is statically rendered + CDN-cached, so a per-request CSP
      // nonce never matches the cached HTML's build-time <script> nonce and
      // blocks every inline script (blank page). buildCSPHeader therefore
      // ignores the nonce for script-src and relies on 'unsafe-inline' + the
      // host allowlist. See the comment in `security-headers.ts`.
      const csp = buildCSPHeader('test-nonce-123');
      expect(csp).not.toContain("'nonce-test-nonce-123'");
      expect(csp).toContain("'unsafe-inline'");
      // `'strict-dynamic'` is intentionally NOT emitted — it would override
      // the host allowlist and break Clerk's external script load.
      expect(csp).not.toContain("'strict-dynamic'");
    });

    it('uses unsafe-inline without nonce in production', () => {
      const csp = buildCSPHeader();
      expect(csp).toContain("'unsafe-inline'");
    });

    describe('development mode', () => {
      beforeEach(() => {
        vi.stubEnv('NODE_ENV', 'development');
      });

      afterEach(() => {
        delete process.env.NEXT_PUBLIC_SITE_URL;
        delete process.env.NEXT_PUBLIC_EDITOR_URL;
      });

      it('includes unsafe-eval in dev', () => {
        const csp = buildCSPHeader();
        expect(csp).toContain("'unsafe-eval'");
      });

      it('includes localhost connect-src in dev', () => {
        const csp = buildCSPHeader();
        expect(csp).toContain('ws://localhost:*');
      });

      it('includes NEXT_PUBLIC_SITE_URL http and ws in dev connect-src', () => {
        process.env.NEXT_PUBLIC_SITE_URL = 'http://192.168.55.2:3000';
        const csp = buildCSPHeader();
        expect(csp).toContain('http://192.168.55.2:3000');
        expect(csp).toContain('ws://192.168.55.2:3000');
      });

      it('does not include upgrade-insecure-requests in dev', () => {
        const csp = buildCSPHeader();
        expect(csp).not.toContain('upgrade-insecure-requests');
      });
    });
  });

  describe('applySecurityHeaders', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://flowstarter.net');
    });

    it('sets Referrer-Policy to the configured value', () => {
      // `referrerPolicy: 'strict-origin-when-cross-origin'` in
      // security-headers.ts. Absent in production until the iteration fix.
      expect(renderHeaders().get('Referrer-Policy')).toBe(
        'strict-origin-when-cross-origin'
      );
    });

    it('sets Strict-Transport-Security to the configured 730-day max-age', () => {
      // `forceHTTPSRedirect: [true, { maxAge: 60 * 60 * 24 * 730,
      // includeSubDomains: true }]` — 63072000 seconds.
      const hsts = renderHeaders().get('Strict-Transport-Security');
      expect(hsts).toContain('max-age=63072000');
      expect(hsts).toContain('includeSubDomains');
    });

    it('sets Content-Security-Policy to the built policy', () => {
      expect(renderHeaders().get('Content-Security-Policy')).toBe(
        buildCSPHeader()
      );
    });

    it('sets the explicit hardening headers', () => {
      const headers = renderHeaders();
      expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(headers.get('X-Frame-Options')).toBe('DENY');
      expect(headers.get('X-XSS-Protection')).toBe('1; mode=block');
      expect(headers.get('Permissions-Policy')).toBe(
        'camera=(), microphone=(), geolocation=()'
      );
    });

    it('allows same-origin framing for the template previews', () => {
      const headers = renderHeaders(undefined, true);
      expect(headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
      expect(headers.get('Content-Security-Policy')).toContain(
        "frame-ancestors 'self'"
      );
    });

    it('emits no numeric header names', () => {
      // The `Object.entries` bug produced "0".."5" with "[object Object]".
      const names: string[] = [];
      renderHeaders().forEach((_value, name) => names.push(name));
      const numeric = names.filter((name) => /^\d+$/.test(name));
      expect(
        numeric,
        `numeric header names leaked: ${numeric.join(', ')}`
      ).toEqual([]);
    });

    it('emits no header whose value stringified an object', () => {
      const broken: string[] = [];
      renderHeaders().forEach((value, name) => {
        if (value.includes('[object Object]')) broken.push(name);
      });
      expect(broken).toEqual([]);
    });
  });

  describe('getStaticCSPHeader', () => {
    it('returns a string', () => {
      expect(typeof getStaticCSPHeader()).toBe('string');
    });

    it('returns CSP without nonce', () => {
      const csp = getStaticCSPHeader();
      expect(csp).not.toContain('nonce-');
    });
  });
});
