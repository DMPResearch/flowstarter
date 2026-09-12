/**
 * Frame proxy: local previews must be reachable same-origin over HTTPS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getJob = vi.fn();

vi.mock('@/lib/discovery/live-jobs', () => ({
  getJob: (id: string) => getJob(id),
}));

describe('GET /api/discovery/preview/live/frame/[demoId]', () => {
  beforeEach(() => {
    getJob.mockReset();
    // The proxy now refuses to serve anything unless local preview is
    // explicitly enabled AND the resolved env is development — most tests
    // below opt in explicitly; the "disabled" tests unset these.
    vi.stubEnv('FLOWSTARTER_LOCAL_PREVIEW', 'true');
    vi.stubEnv('FLOWSTARTER_ENV', 'development');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            [
              '<html><head><title>Site</title></head>',
              '<body><img src="/flowstarter-assets/generated-hero.png" alt="hero">hi</body></html>',
            ].join(''),
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            }
          )
      )
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('404s when the demo is not a ready local preview', async () => {
    getJob.mockReturnValue(undefined);
    const { GET } = await import('../[demoId]/[[...path]]/route');
    const res = await GET(
      new NextRequest(
        'http://localhost/api/discovery/preview/live/frame/e691fc76-1489-404f-9ff5-73cd4910d9c5/'
      ),
      {
        params: Promise.resolve({
          demoId: 'e691fc76-1489-404f-9ff5-73cd4910d9c5',
        }),
      }
    );
    expect(res.status).toBe(404);
  });

  it('404s regardless of job state when FLOWSTARTER_LOCAL_PREVIEW is not set', async () => {
    vi.stubEnv('FLOWSTARTER_LOCAL_PREVIEW', '');
    getJob.mockReturnValue({
      demoId: 'e691fc76-1489-404f-9ff5-73cd4910d9c5',
      status: 'ready',
      previewUrl: 'http://127.0.0.1:8910',
      contentRel: 'src/content/site-labels.md',
      editsUsed: 0,
      createdAt: Date.now(),
    });
    const { GET } = await import('../[demoId]/[[...path]]/route');
    const res = await GET(
      new NextRequest(
        'http://localhost/api/discovery/preview/live/frame/e691fc76-1489-404f-9ff5-73cd4910d9c5/'
      ),
      {
        params: Promise.resolve({
          demoId: 'e691fc76-1489-404f-9ff5-73cd4910d9c5',
        }),
      }
    );
    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('404s even with the flag on when the resolved env is not development (e.g. staging)', async () => {
    vi.stubEnv('FLOWSTARTER_ENV', 'staging');
    getJob.mockReturnValue({
      demoId: 'e691fc76-1489-404f-9ff5-73cd4910d9c5',
      status: 'ready',
      previewUrl: 'http://127.0.0.1:8910',
      contentRel: 'src/content/site-labels.md',
      editsUsed: 0,
      createdAt: Date.now(),
    });
    const { GET } = await import('../[demoId]/[[...path]]/route');
    const res = await GET(
      new NextRequest(
        'http://localhost/api/discovery/preview/live/frame/e691fc76-1489-404f-9ff5-73cd4910d9c5/'
      ),
      {
        params: Promise.resolve({
          demoId: 'e691fc76-1489-404f-9ff5-73cd4910d9c5',
        }),
      }
    );
    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('proxies HTML and injects a same-origin base tag', async () => {
    getJob.mockReturnValue({
      demoId: 'e691fc76-1489-404f-9ff5-73cd4910d9c5',
      status: 'ready',
      previewUrl: 'http://127.0.0.1:8910',
      contentRel: 'src/content/site-labels.md',
      editsUsed: 0,
      createdAt: Date.now(),
    });
    const { GET } = await import('../[demoId]/[[...path]]/route');
    const res = await GET(
      new NextRequest(
        'http://localhost/api/discovery/preview/live/frame/e691fc76-1489-404f-9ff5-73cd4910d9c5/'
      ),
      {
        params: Promise.resolve({
          demoId: 'e691fc76-1489-404f-9ff5-73cd4910d9c5',
        }),
      }
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      '<base href="/api/discovery/preview/live/frame/e691fc76-1489-404f-9ff5-73cd4910d9c5/">'
    );
    expect(html).toContain(
      'src="/api/discovery/preview/live/frame/e691fc76-1489-404f-9ff5-73cd4910d9c5/flowstarter-assets/generated-hero.png"'
    );
    expect(html).toContain('hi');
    expect(html).not.toContain('src="/flowstarter-assets/generated-hero.png"');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'http://127.0.0.1:8910/',
      }),
      expect.any(Object)
    );
  });

  it('sandboxes the served document: CSP has no allow-same-origin, frame-ancestors and X-Frame-Options are app-origin only', async () => {
    getJob.mockReturnValue({
      demoId: 'e691fc76-1489-404f-9ff5-73cd4910d9c5',
      status: 'ready',
      previewUrl: 'http://127.0.0.1:8910',
      contentRel: 'src/content/site-labels.md',
      editsUsed: 0,
      createdAt: Date.now(),
    });
    const { GET } = await import('../[demoId]/[[...path]]/route');
    const res = await GET(
      new NextRequest(
        'http://localhost/api/discovery/preview/live/frame/e691fc76-1489-404f-9ff5-73cd4910d9c5/'
      ),
      {
        params: Promise.resolve({
          demoId: 'e691fc76-1489-404f-9ff5-73cd4910d9c5',
        }),
      }
    );
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain('sandbox allow-scripts allow-forms');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });
});
