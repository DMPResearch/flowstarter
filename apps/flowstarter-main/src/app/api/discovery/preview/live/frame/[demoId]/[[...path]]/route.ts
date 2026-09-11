/**
 * GET /api/discovery/preview/live/frame/[demoId]/[[...path]]
 *
 * Same-origin reverse proxy for FLOWSTARTER_LOCAL_PREVIEW iframes. The job
 * store keeps the real http://127.0.0.1:<port> URL; the client only ever sees
 * this path, so HTTPS tunnel hosts can frame the site without mixed content.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/discovery/live-jobs';
import {
  framedPreviewBaseHref,
  framedPreviewPath,
  injectFrameBase,
  isLocalPreviewUrl,
  rewriteRootAbsoluteUrls,
} from '@/lib/discovery/local-preview-frame';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteParams = { demoId: string; path?: string[] };

function upstreamUrl(
  origin: string,
  pathSegments: string[] | undefined,
  search: string
): URL {
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  const rel = (pathSegments ?? []).map(encodeURIComponent).join('/');
  const url = new URL(rel, base);
  url.search = search;
  return url;
}

async function proxy(
  req: NextRequest,
  params: RouteParams
): Promise<NextResponse> {
  const demoId = params.demoId;
  if (!/^[0-9a-f-]{36}$/i.test(demoId)) {
    return NextResponse.json({ error: 'invalid demoId' }, { status: 400 });
  }

  const job = getJob(demoId);
  if (!job || job.status !== 'ready' || !job.previewUrl) {
    return NextResponse.json({ error: 'demo not ready' }, { status: 404 });
  }
  if (!isLocalPreviewUrl(job.previewUrl)) {
    // Daytona / hosted previews are framed directly — this route is local-only.
    return NextResponse.json({ error: 'not a local preview' }, { status: 404 });
  }

  const target = upstreamUrl(job.previewUrl, params.path, req.nextUrl.search);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      redirect: 'manual',
      headers: {
        accept: req.headers.get('accept') ?? '*/*',
        // Astro/Vite sometimes vary on this; keep it honest.
        'accept-language': req.headers.get('accept-language') ?? 'en',
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'local preview unreachable',
        detail: error instanceof Error ? error.message : 'fetch failed',
      },
      { status: 502 }
    );
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  const baseHref = framedPreviewBaseHref(demoId);
  const headers = new Headers();
  headers.set('cache-control', 'no-store');
  if (contentType) headers.set('content-type', contentType);
  // We are the frame document / asset host now — do not inherit upstream
  // frame-busting headers that would blank the wizard pane.
  headers.delete('x-frame-options');
  headers.delete('content-security-policy');

  if (contentType.includes('text/html')) {
    let html = await upstream.text();
    const framePath = framedPreviewPath(demoId);
    html = injectFrameBase(html, baseHref);
    // `/flowstarter-assets/…` and `/_astro/…` are path-absolute: <base> cannot
    // keep them under the frame, so rewrite them onto the proxy path.
    html = rewriteRootAbsoluteUrls(html, framePath);
    // Absolute loopback links in the document would still trip mixed content
    // if the visitor followed them inside the frame.
    const origin = job.previewUrl.replace(/\/$/, '');
    html = html.split(origin).join(framePath);
    headers.set('content-type', 'text/html; charset=utf-8');
    return new NextResponse(html, { status: upstream.status, headers });
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<RouteParams> }
) {
  return proxy(req, await ctx.params);
}

export async function HEAD(
  req: NextRequest,
  ctx: { params: Promise<RouteParams> }
) {
  return proxy(req, await ctx.params);
}
