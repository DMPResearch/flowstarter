/**
 * Frame proxy: local previews must be reachable same-origin over HTTPS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getJob = vi.fn();

vi.mock('@/lib/discovery/live-jobs', () => ({
  getJob: (id: string) => getJob(id),
}));

describe('GET /api/discovery/preview/live/frame/[demoId]', () => {
  beforeEach(() => {
    getJob.mockReset();
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
});
