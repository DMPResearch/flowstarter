/**
 * The public capture endpoint has to get past the middleware, and the only
 * reason to write this test is that it did not.
 *
 * Every unit test for the route passed while the feature was completely dead
 * in a running app: `middleware.ts` refused the request twice before the
 * handler was ever reached, once as an unauthenticated API call and once as
 * cross-origin CSRF. Both refusals were correct for every other route and
 * wrong for this one, which is cross-origin by design - it is the contact form
 * on a client's own site, on a hostname that is deliberately not ours.
 *
 * So the three exemptions are pinned here as source assertions rather than by
 * booting the middleware, whose Clerk and edge dependencies make it
 * unimportable in a unit suite. Reading the file is a blunt test; it is also
 * the one that would have caught this.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ROUTES } from '@/lib/route-manifest';

const MIDDLEWARE = readFileSync(
  path.resolve(__dirname, '..', 'middleware.ts'),
  'utf8'
);

describe('the lead capture endpoint is reachable without a session', () => {
  it('is a public route, so the 401 gate lets it through', () => {
    expect(PUBLIC_ROUTES).toContain('/api/leads/capture/(.*)');
  });

  it('is only the capture path, not every leads route', () => {
    // `/api/leads/list` reads one client's enquiries and must stay behind the
    // session check. A wildcard on `/api/leads` would have published it.
    expect(PUBLIC_ROUTES).not.toContain('/api/leads(.*)');
    for (const entry of PUBLIC_ROUTES) {
      if (!entry.startsWith('/api/leads')) continue;
      expect(entry).toBe('/api/leads/capture/(.*)');
    }
  });

  it('is exempt from the blanket same-origin CSRF check', () => {
    expect(MIDDLEWARE).toContain(
      "const isLeadCapture = pathname.startsWith('/api/leads/capture/')"
    );
    expect(MIDDLEWARE).toContain('!isLeadCapture &&');
  });

  it('answers its own preflight instead of the blanket CORS allowlist', () => {
    expect(MIDDLEWARE).toContain(
      'if (isLeadCapture) return NextResponse.next();'
    );
  });
});
