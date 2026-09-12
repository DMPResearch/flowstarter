/**
 * GET /api/discovery/preview/live/frame/[demoId]/[[...path]]
 *
 * Same-origin reverse proxy for FLOWSTARTER_LOCAL_PREVIEW iframes. The job
 * store keeps the real http://127.0.0.1:<port> URL; the client only ever sees
 * this path, so HTTPS tunnel hosts can frame the site without mixed content.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/discovery/live-jobs';
import { isLocalPreviewFrameAllowed } from '@/lib/discovery/local-preview-guard';
import {
  framedPreviewBaseHref,
  framedPreviewPath,
  injectFrameBase,
  isLocalPreviewUrl,
  rewriteRootAbsoluteUrls,
} from '@/lib/discovery/local-preview-frame';

/**
 * Headers applied to every response this proxy serves, sandboxing the
 * generated content it re-hosts on the app's own origin.
 *
 * `sandbox allow-scripts allow-forms` (no `allow-same-origin`) forces the
 * served document into an opaque origin: its scripts can still run and its
 * forms still submit, but it cannot read/write cookies or storage as the app
 * origin, and it cannot reach `window.parent`'s document even though the
 * bytes came from the same host. `frame-ancestors 'self'` plus
 * `X-Frame-Options: SAMEORIGIN` keep this content from being embedded by any
 * origin other than the app itself.
 */
function applyFrameSandboxHeaders(headers: Headers): void {
  headers.set(
    'Content-Security-Policy',
    "sandbox allow-scripts allow-forms; frame-ancestors 'self'"
  );
  headers.set('X-Frame-Options', 'SAMEORIGIN');
}

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
  // Refuse outright unless a developer has explicitly opted into local
  // preview AND this process is actually running as `development`. Without
  // this, a build/staging misconfiguration that merely leaves the env var
  // set would let generated content run on the signed-in app origin.
  if (!isLocalPreviewFrameAllowed()) {
    const response = NextResponse.json(
      { error: 'local preview disabled' },
      { status: 404 }
    );
    applyFrameSandboxHeaders(response.headers);
    return response;
  }

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
  // We are the frame document / asset host now — replace upstream
  // frame-busting headers with our own sandboxed versions rather than just
  // deleting them, so this response is never served without them.
  applyFrameSandboxHeaders(headers);

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
