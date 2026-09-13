/**
 * POST /api/discovery/brand-signals/picture — one picture, before anyone is
 * anyone.
 *
 * Measured against the real public pages on 2026-09-12: `instagram.com/<handle>`
 * answers an anonymous GET with 200 and roughly 600 kB of application shell
 * carrying no OpenGraph tags at all, and LinkedIn refuses outright. So for most
 * visitors the profile links produce nothing, and the palette would fall back
 * to the tone chips. This route is the alternative we offer them instead: hand
 * us a logo or a photo of yourself, and the colours come from your material
 * after all.
 *
 * It is the only anonymous upload endpoint in the product, which is why it is
 * narrower than the client one in every dimension:
 *
 *   one file per request, three per preview, never a batch,
 *   the same magic-byte verification the client uploader uses, so the bytes
 *     are a real raster image and not an SVG with a script in it,
 *   a smaller size cap, because this is a logo and not a hero photograph,
 *   the rights statement is required rather than a later step: there is no
 *     dashboard to come back to and confirm on, and an unconfirmed picture is
 *     one the generator may never place.
 *
 * The object lands under `funnel/{previewId}/assets/` and the row in
 * `funnel_assets`, both server-only, both carried into the workspace on claim
 * and both deleted with the preview if the claim never comes.
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  AssetUploadError,
  clientIp,
  verifyUpload,
} from '@/app/api/client/assets/asset-storage';
import {
  CURRENT_RIGHTS_STATEMENT_VERSION,
  KNOWN_RIGHTS_STATEMENT_VERSIONS,
} from '@/components/flowstarter/rights-statement';
import {
  FunnelAssetError,
  storeFunnelAsset,
} from '@/lib/flowstarter/funnel-assets';
import {
  imageDecodeGate,
  imagePixelBudget,
  readFormDataCapped,
} from '@/lib/net/ingress';
import { ingressConfig } from '@/lib/net/net-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A logo or a profile picture, not a photo library. Deliberately a quarter of
 * the client uploader's 8 MiB: the only thing we do with this file is read
 * four colours out of a downscaled copy of it.
 *
 * The number itself lives in `lib/net/net-config.ts` as `maxAnonBodyBytes` and
 * is read per request rather than written here, because the same cap has to
 * bound the STREAM as well as the finished file — one a route knows about and
 * the body reader does not is a cap that is enforced too late, which is the
 * whole of Codex F07.
 */

/** The cap as the visitor reads it, so the number is never said twice. */
function tooLargeMessage(maxBytes: number): string {
  return `That picture is larger than ${Math.floor(
    maxBytes / (1024 * 1024)
  )}MB. A logo or a headshot is fine.`;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Same shape as the intake graph's limiter, tighter because this writes. */
const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

function bad(error: string, status = 400): NextResponse {
  return NextResponse.json({ error, code: 'BAD_REQUEST' }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = clientIp(request) ?? 'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: 'Too many uploads. Give it a minute.', code: 'RATE_LIMITED' },
      { status: 429 }
    );
  }

  const limits = ingressConfig();
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return bad('Send the picture as a form upload.');
  }

  // THE FIX FOR CODEX F07, and the order is the whole of it. What was here
  // trusted `Content-Length` and then called `request.formData()`, which
  // buffers the entire body before anything measures it: a chunked upload
  // carries no length at all, so `?? '0'` read "no header" as "no bytes" and
  // the cap was enforced after the allocation it existed to prevent. The
  // reader below counts bytes as they arrive and abandons the stream the
  // moment the total passes the cap, whatever the headers said.
  const body = await readFormDataCapped(request, limits.maxAnonBodyBytes);
  if (body.status === 'too_large') {
    return NextResponse.json(
      { error: tooLargeMessage(limits.maxAnonBodyBytes), code: 'TOO_LARGE' },
      { status: 413 }
    );
  }
  if (body.status === 'invalid') {
    return bad('That upload did not arrive in one piece. Try again.');
  }
  const form = body.form;

  const previewId = String(form.get('previewId') ?? '').trim();
  if (!UUID.test(previewId)) {
    return bad('That preview id is not one of ours.');
  }

  const kindRaw = String(form.get('kind') ?? 'logo').trim();
  if (kindRaw !== 'logo' && kindRaw !== 'photo') {
    return bad('Tell us whether that is a logo or a photo.');
  }

  // No second step to confirm on, so the statement is part of the upload.
  const statementVersion =
    String(form.get('statementVersion') ?? '').trim() ||
    CURRENT_RIGHTS_STATEMENT_VERSION;
  if (
    !(KNOWN_RIGHTS_STATEMENT_VERSIONS as readonly string[]).includes(
      statementVersion
    )
  ) {
    return bad('That rights statement is not one we recognise.');
  }
  if (String(form.get('rightsConfirmed') ?? '') !== 'true') {
    return bad(
      'We need you to confirm the picture is yours to use before we can take it.'
    );
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return bad('No picture arrived with that request.');
  }
  if (file.size > limits.maxAnonBodyBytes) {
    return NextResponse.json(
      { error: tooLargeMessage(limits.maxAnonBodyBytes), code: 'TOO_LARGE' },
      { status: 413 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Pixels, not bytes. A PNG whose header declares 40000x40000 fits in this
  // route's size cap with room to spare and costs about six gigabytes to
  // decode, so the dimensions are read out of the header — no decoder
  // involved — and refused before anything allocates one.
  if (
    imagePixelBudget(bytes, limits.maxImagePixels).status === 'too_many_pixels'
  ) {
    return NextResponse.json(
      {
        error:
          'That picture is too many pixels to work with. Send a smaller one.',
        code: 'TOO_LARGE',
      },
      { status: 413 }
    );
  }

  try {
    // The same byte sniff the client uploader uses. The declared content type
    // is a claim; the magic bytes are the fact. Through the process-wide gate,
    // because a burst of anonymous uploads all hashing and probing multi-
    // megabyte buffers at once is the amplification this route is the softest
    // target for.
    const verified = await imageDecodeGate(limits).run(async () =>
      verifyUpload(bytes)
    );
    const row = await storeFunnelAsset({
      previewId,
      file: verified,
      kind: kindRaw,
      rights: {
        confirmed: true,
        statementVersion,
        ip,
        userAgent: request.headers.get('user-agent'),
      },
    });
    return NextResponse.json(
      {
        assetId: row.id,
        kind: row.kind,
        width: row.width,
        height: row.height,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof AssetUploadError) {
      return NextResponse.json(
        { error: error.message, code: 'BAD_REQUEST' },
        { status: error.status }
      );
    }
    if (error instanceof FunnelAssetError) {
      return NextResponse.json(
        { error: error.message, code: 'BAD_REQUEST' },
        { status: error.status }
      );
    }
    console.error(
      '[brand-signals/picture] could not store the upload:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json(
      { error: 'We could not keep that picture. Try again.', code: 'FAILED' },
      { status: 500 }
    );
  }
}
