import 'server-only';
/**
 * "This is what my picture shows."
 *
 * The other half of the caption story: `storeUpload` fills `caption` in on
 * the way in, either from what a client typed or from a bounded vision
 * guess, but a guess is only ever `caption_source: 'auto'` until a human
 * reads it and stands behind it. This route is that standing-behind — a
 * client either edits the sentence or resubmits it unchanged, and either way
 * `caption_source` becomes `'client'`, because from here on a person is
 * answerable for it being right, not a model.
 *
 * There is deliberately no way to clear a caption back to empty through this
 * route (`setAssetCaption` refuses a blank string): a client who wants no
 * caption on a picture leaves the auto-caption as `'auto'` rather than
 * confirming an empty one, which would read everywhere else as "a human
 * checked this and it truly shows nothing" — not what happened.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import { MAX_CLIENT_CAPTION_CHARS, setAssetCaption } from '../../asset-storage';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  assetId: z.string().uuid(),
  caption: z.string().trim().min(1).max(MAX_CLIENT_CAPTION_CHARS),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.errors[0]?.message ??
          `Give this picture a caption of at most ${MAX_CLIENT_CAPTION_CHARS} characters`,
      },
      { status: 400 }
    );
  }

  try {
    const updated = await setAssetCaption(
      access.workspaceId,
      parsed.data.assetId,
      parsed.data.caption
    );
    if (!updated) {
      // 404, not 403 or 422: whether the id belongs to another tenant or the
      // trimmed caption came back empty, the client learns nothing more than
      // "that did not work" — the same posture `rights/route.ts` takes with
      // an id it does not recognise.
      return NextResponse.json(
        { error: 'That picture is not on this project', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }
    return NextResponse.json({ asset: updated });
  } catch (error) {
    console.error('[api/client/assets/caption] failed', error);
    return NextResponse.json({ error: 'Request failed' }, { status: 500 });
  }
}
