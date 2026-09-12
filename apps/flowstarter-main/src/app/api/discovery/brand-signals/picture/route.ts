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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A logo or a profile picture, not a photo library. Deliberately a quarter of
 * the client uploader's 8 MiB: the only thing we do with this file is read
 * four colours out of a downscaled copy of it.
 */
export const MAX_PICTURE_BYTES = 2 * 1024 * 1024;

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

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return bad('Send the picture as a form upload.');
  }

  // Refuse on the declared length before buffering anything: a cap enforced
  // only after the body is in memory is not a cap.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_PICTURE_BYTES) {
    return NextResponse.json(
      {
        error: 'That picture is larger than 2MB. A logo or a headshot is fine.',
        code: 'TOO_LARGE',
      },
      { status: 413 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad('That upload did not arrive in one piece. Try again.');
  }

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
  if (file.size > MAX_PICTURE_BYTES) {
    return NextResponse.json(
      {
        error: 'That picture is larger than 2MB. A logo or a headshot is fine.',
        code: 'TOO_LARGE',
      },
      { status: 413 }
    );
  }

  try {
    // The same byte sniff the client uploader uses. The declared content type
    // is a claim; the magic bytes are the fact.
    const verified = verifyUpload(Buffer.from(await file.arrayBuffer()));
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
