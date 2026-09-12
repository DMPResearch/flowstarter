import 'server-only';
/**
 * A client's own files.
 *
 * GET  — every asset the workspace holds, each with a short-lived signed URL,
 *        and a `usable` flag that is false until rights are confirmed.
 * POST — multipart upload of one or a few images.
 *
 * Both handlers call `requireWorkspaceAccess` before they touch anything at
 * all — before the body is read, before a byte is written, before a query
 * runs. Everything underneath uses the service-role client, which bypasses
 * RLS, so that check is the entire tenant boundary. A non-member gets 404 and
 * no storage call is ever attempted; the route tests assert on both halves,
 * because a 404 that still wrote an object would be a passing test and a real
 * leak.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import {
  AssetUploadError,
  MAX_FILES_PER_REQUEST,
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  listWorkspaceAssets,
  readinessAfterUpload,
  recordAssetEvent,
  storeUpload,
  verifyUpload,
  type UploadedAsset,
} from '../asset-storage';

/** Uploads stream through this route; it can never be statically rendered. */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  try {
    const assets = await listWorkspaceAssets(access.workspaceId);
    const confirmed = new Set(
      assets.filter((asset) => asset.usable).map((asset) => asset.id)
    );
    return NextResponse.json({
      assets,
      // Named so a caller cannot mistake "we hold it" for "we may use it".
      usableAssetIds: Array.from(confirmed),
      sufficiency: await readinessAfterUpload(access.workspaceId, confirmed),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return NextResponse.json(
      { error: 'Send the files as multipart/form-data' },
      { status: 400 }
    );
  }

  // A declared length over the whole-request cap is refused before the body is
  // buffered at all, so a 100MB POST costs us a header parse rather than
  // 100MB of memory.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return NextResponse.json(
      {
        error: 'That upload is too large. Please send fewer or smaller files.',
      },
      { status: 413 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: 'That upload could not be read' },
      { status: 400 }
    );
  }

  // `files` is the documented field; `file` is accepted so a plain single-input
  // form works without JavaScript rewriting the field name.
  const files = [...form.getAll('files'), ...form.getAll('file')].filter(
    (value): value is File =>
      typeof value === 'object' && value !== null && 'arrayBuffer' in value
  );

  if (files.length === 0) {
    return NextResponse.json({ error: 'No files were sent' }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      { error: `Please send at most ${MAX_FILES_PER_REQUEST} files at a time` },
      { status: 400 }
    );
  }

  // Sizes are checked from the File metadata first: refusing a 40MB file
  // before `arrayBuffer()` means we never hold it.
  let total = 0;
  for (const file of files) {
    const size = typeof file.size === 'number' ? file.size : 0;
    if (size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: `"${fileLabel(file)}" is larger than ${Math.floor(
            MAX_UPLOAD_BYTES / (1024 * 1024)
          )}MB. Please send a smaller version.`,
        },
        { status: 413 }
      );
    }
    total += size;
  }
  if (total > MAX_REQUEST_BYTES) {
    return NextResponse.json(
      {
        error: 'That upload is too large. Please send fewer or smaller files.',
      },
      { status: 413 }
    );
  }

  const slot = stringField(form, 'slot');
  const kind = stringField(form, 'kind');
  const askKey = stringField(form, 'askKey');

  try {
    const stored: UploadedAsset[] = [];
    for (const file of files) {
      const bytes = Buffer.from(await file.arrayBuffer());
      // Second size check, on the bytes we actually received: `File.size` is
      // whatever the sender claimed, and this is what we are about to store.
      const verified = verifyUpload(bytes);
      stored.push(
        await storeUpload({
          workspaceId: access.workspaceId,
          file: verified,
          slot,
          kind,
          originalName: sanitizedOriginalName(file),
        })
      );
    }

    await recordAssetEvent(
      access.workspaceId,
      'asset_uploaded',
      access.userId,
      {
        assetIds: stored.map((asset) => asset.id),
        count: stored.length,
        deduplicated: stored.filter((asset) => asset.deduplicated).length,
        ...(slot ? { slot } : {}),
        ...(askKey ? { askKey } : {}),
      }
    );

    const assets = await listWorkspaceAssets(access.workspaceId);
    const confirmed = new Set(
      assets.filter((asset) => asset.usable).map((asset) => asset.id)
    );

    return NextResponse.json(
      {
        uploaded: stored,
        assets,
        usableAssetIds: Array.from(confirmed),
        // Recomputed from confirmed assets only, so an upload that nobody has
        // claimed the rights to does not appear to close an ask.
        sufficiency: await readinessAfterUpload(access.workspaceId, confirmed),
      },
      { status: 201 }
    );
  } catch (error) {
    return failure(error);
  }
}

function fileLabel(file: File): string {
  const name = typeof file.name === 'string' ? file.name : '';
  // Never echo a raw filename: it is attacker-controlled and lands in the DOM.
  return name.replace(/[^\w.\- ]+/g, '').slice(0, 80) || 'That file';
}

/**
 * Comfortably longer than any real camera or phone filename, short enough
 * that a pathological one cannot bloat a row or an operator's picker.
 */
const MAX_ORIGINAL_NAME_CHARS = 120;

/**
 * `file.name`, kept only as prose for later display — the operator's
 * change-request asset picker, eventually. It is trimmed, stripped of any
 * directory component (a hostile or merely confused browser can send
 * `../../etc/passwd.jpg`; only the last segment survives), and capped. It is
 * a caption, never a path: it is stored as `assets.original_name` and never
 * reaches `assetObjectPath` or a storage call.
 */
function sanitizedOriginalName(file: File): string | null {
  const raw = typeof file.name === 'string' ? file.name : '';
  const basename = raw.split(/[\\/]/).pop() ?? '';
  const trimmed = basename.trim().slice(0, MAX_ORIGINAL_NAME_CHARS);
  return trimmed || null;
}

function stringField(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 64 ? trimmed : null;
}

/**
 * An `AssetUploadError` was raised deliberately and its text is meant for the
 * client. Anything else may carry a storage key or a connection string, so
 * only its shape crosses the wire.
 */
function failure(error: unknown): NextResponse {
  if (error instanceof AssetUploadError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status }
    );
  }
  console.error('[api/client/assets] failed', error);
  return NextResponse.json({ error: 'Request failed' }, { status: 500 });
}
