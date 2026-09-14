// @vitest-environment node
/**
 * The client upload loop, through the REAL route handlers.
 *
 * Four things are being defended here, and each of them has already been a
 * real bug in something:
 *
 *  1. TENANCY. These handlers query and upload with the service role, which
 *     bypasses RLS and bucket policies alike. `requireWorkspaceAccess` running
 *     first is the entire boundary, so the cross-tenant case asserts not only
 *     the 404 but that `storage.upload` was never called — a 404 that still
 *     wrote an object into another tenant's prefix would be a green test and a
 *     live leak.
 *  2. FILE TYPE. An SVG is XML that can carry script, and these files end up
 *     on the client's own website. The test sends one named `logo.png` with a
 *     spoofed `image/png` type, because that is exactly what an attacker sends.
 *  3. DEDUPE. `assets` has a partial unique index on (workspace_id, sha256).
 *     The route inserts and handles 23505 rather than checking first, so the
 *     fake raises 23505 for real and the same photograph twice must yield one
 *     row, not an error and not two.
 *  4. RIGHTS. Confirmation is over a named set. Stamping a neighbouring asset,
 *     or recording a confirmer taken from the body rather than the session,
 *     would make the evidence table worthless — so both are asserted.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
// Static imports: vi.mock is hoisted above them, and the app's tsconfig does
// not allow top-level await in tests.
import { GET, POST } from '../route';
import { POST as CONFIRM_RIGHTS } from '../rights/route';
import {
  AssetUploadError,
  MAX_FILES_PER_REQUEST,
  MAX_UPLOAD_BYTES,
  clientIp,
  usableForSlot,
  verifyUpload,
} from '../../asset-storage';
import { createFakeAssetSupabase, type Row } from './fake-asset-supabase';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';

// Asset ids are real UUIDs because the rights endpoint validates them as such
// before it queries — a readable string like 'asset-chosen' would be rejected
// by the schema and the test would pass for the wrong reason.
const ASSET_CHOSEN = '11111111-1111-4111-8111-111111111111';
const ASSET_UNTOUCHED = '22222222-2222-4222-8222-222222222222';
const ASSET_OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const ASSET_CONFIRMED = '44444444-4444-4444-8444-444444444444';
const ASSET_UNCONFIRMED = '55555555-5555-4555-8555-555555555555';

// ── Clerk ──────────────────────────────────────────────────────────────────
// Mirrors src/lib/__tests__/workspace-access.test.ts.
const authState: { userId: string | null; role: string | undefined } = {
  userId: 'user_client_a',
  role: undefined,
};

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: { metadata: { role: authState.role } },
    getToken: async () => 'test-token',
  }),
  clerkClient: async () => ({
    users: {
      getUser: async () => ({
        publicMetadata: { role: authState.role },
        emailAddresses: [],
        primaryEmailAddressId: null,
      }),
    },
  }),
  currentUser: async () => null,
}));

// One client backs the membership lookup, the routes' own queries and storage —
// same module, same import, in production and here.
const db = createFakeAssetSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

/**
 * Only the non-asset half of the sufficiency input is faked. The images are
 * read back out of the fake database so the gate sees exactly what the route
 * decided to hand it — which is the whole point of the "unconfirmed rights do
 * not count" case. `evaluateSufficiency` itself is the real, pure module.
 */
/**
 * Knobs for the half of the sufficiency input that does not come out of the
 * fake database: whether the gate is reachable at all, and whether the
 * workspace has a logo. Both are states the route has to answer honestly
 * rather than guess at, so they are settable per test.
 */
const gate = vi.hoisted(() => ({
  /** The gate itself is down, e.g. the workspace has no template yet. */
  unavailable: false,
  /** Report the workspace's images, or say nothing about them at all. */
  reportImages: true,
  /** The logo the workspace holds, if it holds one. */
  logo: null as null | {
    id: string;
    width: number | null;
    height: number | null;
    usableFor: string[];
    isPlaceholder: boolean;
    kind: string | null;
  },
}));

vi.mock('@/lib/flowstarter/messaging', () => ({
  collectSufficiencyInput: async (workspaceId: string) => {
    if (gate.unavailable) {
      throw new Error('no template chosen, the gate cannot be evaluated');
    }
    const images = db
      .rows('assets')
      .filter((row) => row.workspace_id === workspaceId && row.kind !== 'logo')
      .map((row) => ({
        id: row.id as string,
        width: row.width as number | null,
        height: row.height as number | null,
        usableFor: (row.usable_for as string[]) ?? [],
        isPlaceholder: false,
        kind: row.kind as string | null,
      }));
    return {
      slots: [],
      ...(gate.reportImages ? { images } : {}),
      logo: gate.logo,
      businessText: 'A real description of the business. '.repeat(20),
      contact: { email: 'a@example.com', phone: null, bookingUrl: null },
      services: ['One', 'Two', 'Three'],
    };
  },
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * A PNG whose header is real and whose body is not. Both `assertSafeUploadedImage`
 * (magic bytes) and `probeImageSize` (IHDR) read only the header, so this is a
 * genuine exercise of the validator without checking a binary into the repo.
 * `salt` changes the bytes, and therefore the sha256, without changing the shape.
 */
function pngBytes(width = 1600, height = 900, salt = 0): Buffer {
  const bytes = Buffer.alloc(64, 0);
  bytes.writeUInt32BE(0x89504e47, 0); // \x89PNG
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8); // IHDR chunk length
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[63] = salt;
  return bytes;
}

/** An SVG. Never acceptable as an upload, whatever it claims to be. */
const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/steal")</script></svg>',
  'utf8'
);

function upload(
  workspaceId: string,
  files: Array<{ name: string; type: string; bytes: Buffer }>,
  fields: Record<string, string> = {}
): NextRequest {
  const form = new FormData();
  for (const file of files) {
    form.append(
      'files',
      new File([new Uint8Array(file.bytes)], file.name, { type: file.type })
    );
  }
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new NextRequest(`http://localhost/api/client/assets/${workspaceId}`, {
    method: 'POST',
    body: form,
  });
}

function confirm(workspaceId: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/client/assets/${workspaceId}/rights`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'user-agent': 'TestBrowser/1.0',
      },
      body: JSON.stringify(body),
    }
  );
}

function params(workspaceId: string) {
  return { params: Promise.resolve({ workspaceId }) };
}

function assetsIn(workspaceId: string): Row[] {
  return db.rows('assets').filter((row) => row.workspace_id === workspaceId);
}

beforeEach(() => {
  db.reset();
  gate.unavailable = false;
  gate.reportImages = true;
  gate.logo = null;
  authState.userId = 'user_client_a';
  authState.role = undefined;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.seed('workspace_memberships', [
    { workspace_id: WORKSPACE_A, clerk_user_id: 'user_client_a' },
  ]);
});

// ───────────────────────────────────────────────────────────────────────────

describe('cross-tenant uploads', () => {
  it('refuses another tenant, and never reaches storage', async () => {
    const response = await POST(
      upload(WORKSPACE_B, [
        { name: 'photo.png', type: 'image/png', bytes: pngBytes() },
      ]),
      params(WORKSPACE_B)
    );

    // 404, not 403: a 403 would confirm the workspace is real.
    expect(response.status).toBe(404);
    // The assertion that actually matters.
    expect(db.uploads).toHaveLength(0);
    expect(assetsIn(WORKSPACE_B)).toHaveLength(0);
    expect(db.rows('assets')).toHaveLength(0);
  });

  it('refuses another tenant on read, and signs nothing', async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_B}`),
      params(WORKSPACE_B)
    );
    expect(response.status).toBe(404);
    expect(db.signed).toHaveLength(0);
  });

  it('refuses a signed-out caller', async () => {
    authState.userId = null;
    const response = await POST(
      upload(WORKSPACE_A, [
        { name: 'photo.png', type: 'image/png', bytes: pngBytes() },
      ]),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(401);
    expect(db.uploads).toHaveLength(0);
  });
});

describe('what counts as an image', () => {
  it('rejects an SVG renamed .png with a spoofed content type', async () => {
    const response = await POST(
      upload(WORKSPACE_A, [
        { name: 'logo.png', type: 'image/png', bytes: SVG_BYTES },
      ]),
      params(WORKSPACE_A)
    );

    expect(response.status).toBe(400);
    // Nothing was stored and nothing was recorded: the bytes lost, not the name.
    expect(db.uploads).toHaveLength(0);
    expect(assetsIn(WORKSPACE_A)).toHaveLength(0);
  });

  it('refuses a file over the per-file cap', async () => {
    const oversized = Buffer.concat([
      pngBytes(),
      Buffer.alloc(9 * 1024 * 1024, 0),
    ]);
    const response = await POST(
      upload(WORKSPACE_A, [
        { name: 'huge.png', type: 'image/png', bytes: oversized },
      ]),
      params(WORKSPACE_A)
    );

    expect(response.status).toBe(413);
    expect(db.uploads).toHaveLength(0);
  });

  it('refuses a body that is not multipart at all', async () => {
    const response = await POST(
      new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [] }),
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect(db.uploads).toHaveLength(0);
  });
});

describe('storing an upload', () => {
  it('stores under the tenant prefix and records the row', async () => {
    const response = await POST(
      upload(
        WORKSPACE_A,
        [{ name: 'hero.png', type: 'image/png', bytes: pngBytes() }],
        { slot: 'hero' }
      ),
      params(WORKSPACE_A)
    );

    expect(response.status).toBe(201);
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0]?.bucket).toBe('tenant-assets');
    expect(db.uploads[0]?.path).toMatch(
      new RegExp(`^tenant/${WORKSPACE_A}/assets/[0-9a-f]{64}\\.png$`)
    );
    // The content type comes from the verified bytes, not the upload's claim.
    expect(db.uploads[0]?.contentType).toBe('image/png');

    const [row] = assetsIn(WORKSPACE_A);
    expect(row).toMatchObject({
      workspace_id: WORKSPACE_A,
      source: 'upload',
      mime: 'image/png',
      width: 1600,
      height: 900,
      usable_for: ['hero'],
      rights_confirmed_at: null,
    });

    const events = db
      .rows('project_events')
      .filter((event) => event.kind === 'asset_uploaded');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspace_id: WORKSPACE_A,
      actor: 'user_client_a',
    });
  });

  it('is idempotent: the same file twice yields one asset row', async () => {
    const bytes = pngBytes();
    const first = await POST(
      upload(WORKSPACE_A, [{ name: 'photo.png', type: 'image/png', bytes }]),
      params(WORKSPACE_A)
    );
    const second = await POST(
      // A different filename, deliberately: dedupe is on content, not name.
      upload(WORKSPACE_A, [
        { name: 'photo-copy.png', type: 'image/png', bytes },
      ]),
      params(WORKSPACE_A)
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(assetsIn(WORKSPACE_A)).toHaveLength(1);

    const firstBody = (await first.json()) as {
      uploaded: Array<{ id: string; deduplicated: boolean }>;
    };
    const secondBody = (await second.json()) as {
      uploaded: Array<{ id: string; deduplicated: boolean }>;
    };
    // Same row, and the second call says so rather than pretending it was new.
    expect(secondBody.uploaded[0]?.id).toBe(firstBody.uploaded[0]?.id);
    expect(firstBody.uploaded[0]?.deduplicated).toBe(false);
    expect(secondBody.uploaded[0]?.deduplicated).toBe(true);
  });

  it('marks a logo as one, so the sufficiency gate can find it', async () => {
    const response = await POST(
      upload(
        WORKSPACE_A,
        [{ name: 'mark.png', type: 'image/png', bytes: pngBytes() }],
        { slot: 'logo' }
      ),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(201);
    expect(assetsIn(WORKSPACE_A)[0]).toMatchObject({
      kind: 'logo',
      usable_for: ['logo'],
    });
  });

  it('returns the row it already had, however sparse that row is', async () => {
    const bytes = pngBytes();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // A row from before the columns below were always written. Dedupe has to
    // hand back what is there rather than fail on the gaps.
    db.seed('assets', [
      {
        id: ASSET_CHOSEN,
        workspace_id: WORKSPACE_A,
        source: 'upload',
        kind: null,
        storage_path: null,
        sha256,
        mime: null,
        width: null,
        height: null,
        usable_for: null,
        selected: false,
        rights_confirmed_at: null,
        created_at: '2026-08-30T10:00:00.000Z',
      },
    ]);

    const response = await POST(
      upload(WORKSPACE_A, [{ name: 'again.png', type: 'image/png', bytes }]),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      uploaded: Array<{
        id: string;
        deduplicated: boolean;
        storagePath: string;
        mime: string;
        usableFor: string[];
      }>;
    };
    expect(body.uploaded[0]).toMatchObject({
      id: ASSET_CHOSEN,
      deduplicated: true,
      storagePath: '',
      mime: '',
      usableFor: [],
    });
    expect(assetsIn(WORKSPACE_A)).toHaveLength(1);
  });

  it('keeps two different files apart', async () => {
    await POST(
      upload(WORKSPACE_A, [
        { name: 'a.png', type: 'image/png', bytes: pngBytes(1600, 900, 1) },
      ]),
      params(WORKSPACE_A)
    );
    await POST(
      upload(WORKSPACE_A, [
        { name: 'b.png', type: 'image/png', bytes: pngBytes(1600, 900, 2) },
      ]),
      params(WORKSPACE_A)
    );
    expect(assetsIn(WORKSPACE_A)).toHaveLength(2);
  });
});

describe('rights confirmation', () => {
  beforeEach(() => {
    db.seed('assets', [
      {
        id: ASSET_CHOSEN,
        workspace_id: WORKSPACE_A,
        source: 'upload',
        kind: null,
        storage_path: `tenant/${WORKSPACE_A}/assets/${'a'.repeat(64)}.png`,
        sha256: 'a'.repeat(64),
        mime: 'image/png',
        width: 1600,
        height: 900,
        usable_for: [],
        selected: false,
        rights_confirmed_at: null,
        created_at: '2026-08-30T10:00:00.000Z',
      },
      {
        id: ASSET_UNTOUCHED,
        workspace_id: WORKSPACE_A,
        source: 'upload',
        kind: null,
        storage_path: `tenant/${WORKSPACE_A}/assets/${'b'.repeat(64)}.png`,
        sha256: 'b'.repeat(64),
        mime: 'image/png',
        width: 1600,
        height: 900,
        usable_for: [],
        selected: false,
        rights_confirmed_at: null,
        created_at: '2026-08-30T11:00:00.000Z',
      },
      {
        id: ASSET_OTHER_TENANT,
        workspace_id: WORKSPACE_B,
        source: 'upload',
        kind: null,
        storage_path: `tenant/${WORKSPACE_B}/assets/${'c'.repeat(64)}.png`,
        sha256: 'c'.repeat(64),
        mime: 'image/png',
        width: 1600,
        height: 900,
        usable_for: [],
        selected: false,
        rights_confirmed_at: null,
        created_at: '2026-08-30T12:00:00.000Z',
      },
    ]);
  });

  it('stamps only the listed assets, and records who confirmed', async () => {
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, {
        assetIds: [ASSET_CHOSEN],
        statementVersion: '2026-08-30',
      }),
      params(WORKSPACE_A)
    );

    expect(response.status).toBe(201);

    const chosen = db
      .rows('assets')
      .find((row) => row.id === ASSET_CHOSEN) as Row;
    const untouched = db
      .rows('assets')
      .find((row) => row.id === ASSET_UNTOUCHED) as Row;
    expect(chosen.rights_confirmed_at).toEqual(expect.any(String));
    expect(chosen.selected).toBe(true);
    // The neighbour was not swept up.
    expect(untouched.rights_confirmed_at).toBeNull();
    expect(untouched.selected).toBe(false);

    const [record] = db.rows('asset_rights_confirmations');
    expect(record).toMatchObject({
      workspace_id: WORKSPACE_A,
      asset_ids: [ASSET_CHOSEN],
      // From the session, never from the body.
      confirmed_by: 'user_client_a',
      statement_version: '2026-08-30',
      user_agent: 'TestBrowser/1.0',
    });
    // First hop of the proxy chain only.
    expect(record?.ip).toBe('203.0.113.7');
  });

  it('ignores a confirmer supplied in the body', async () => {
    await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, {
        assetIds: [ASSET_CHOSEN],
        confirmedBy: 'user_someone_else',
      }),
      params(WORKSPACE_A)
    );
    expect(db.rows('asset_rights_confirmations')[0]?.confirmed_by).toBe(
      'user_client_a'
    );
  });

  it('will not confirm another tenant’s asset, even alongside its own', async () => {
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, {
        assetIds: [ASSET_CHOSEN, ASSET_OTHER_TENANT],
      }),
      params(WORKSPACE_A)
    );

    expect(response.status).toBe(404);
    // All-or-nothing: the caller's own asset is not quietly confirmed either.
    expect(
      db.rows('assets').find((row) => row.id === ASSET_CHOSEN)
        ?.rights_confirmed_at
    ).toBeNull();
    expect(db.rows('asset_rights_confirmations')).toHaveLength(0);
  });

  it('refuses a statement version it does not know', async () => {
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, {
        assetIds: [ASSET_CHOSEN],
        statementVersion: '1999-01-01',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect(db.rows('asset_rights_confirmations')).toHaveLength(0);
  });

  it('refuses a non-member outright', async () => {
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_B, { assetIds: [ASSET_OTHER_TENANT] }),
      params(WORKSPACE_B)
    );
    expect(response.status).toBe(404);
    expect(db.rows('asset_rights_confirmations')).toHaveLength(0);
  });
});

describe('reading assets back', () => {
  beforeEach(() => {
    db.seed('assets', [
      {
        id: ASSET_CONFIRMED,
        workspace_id: WORKSPACE_A,
        source: 'upload',
        source_url: null,
        kind: null,
        storage_path: `tenant/${WORKSPACE_A}/assets/${'a'.repeat(64)}.png`,
        sha256: 'a'.repeat(64),
        mime: 'image/png',
        width: 1600,
        height: 900,
        usable_for: [],
        selected: true,
        rights_confirmed_at: '2026-08-30T09:00:00.000Z',
        created_at: '2026-08-30T09:00:00.000Z',
      },
      {
        // A picture we read off the client's own public Instagram page rather
        // than one they sent. An automatic source is filed with no rights
        // stamp on purpose, and the provenance is the only thing that can
        // answer "where did this come from" six months later.
        id: ASSET_UNCONFIRMED,
        workspace_id: WORKSPACE_A,
        source: 'instagram',
        source_url: 'https://scontent.cdninstagram.com/v/example_100x100.jpg',
        kind: null,
        storage_path: `tenant/${WORKSPACE_A}/assets/${'b'.repeat(64)}.png`,
        sha256: 'b'.repeat(64),
        mime: 'image/png',
        width: 1600,
        height: 900,
        usable_for: [],
        selected: false,
        rights_confirmed_at: null,
        created_at: '2026-08-30T10:00:00.000Z',
      },
    ]);
  });

  it('never reports an unconfirmed asset as usable', async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      assets: Array<{ id: string; usable: boolean; url: string | null }>;
      usableAssetIds: string[];
    };

    expect(body.assets).toHaveLength(2);
    expect(body.usableAssetIds).toEqual([ASSET_CONFIRMED]);
    expect(
      body.assets.find((asset) => asset.id === ASSET_UNCONFIRMED)?.usable
    ).toBe(false);
  });

  // Provenance survives the read. The brief's sourced-portrait card is the
  // only thing that can offer a fetched picture back to the person it is of,
  // and it cannot tell a fetch from an upload without these two fields.
  it('reports where a picture came from, and where it did not', async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
      params(WORKSPACE_A)
    );
    const body = (await response.json()) as {
      assets: Array<{ id: string; source: string; sourceUrl: string | null }>;
    };

    expect(
      body.assets.find((asset) => asset.id === ASSET_UNCONFIRMED)
    ).toMatchObject({
      source: 'instagram',
      sourceUrl: 'https://scontent.cdninstagram.com/v/example_100x100.jpg',
    });
    expect(
      body.assets.find((asset) => asset.id === ASSET_CONFIRMED)
    ).toMatchObject({ source: 'upload', sourceUrl: null });
  });

  it('hands out signed URLs, never raw storage paths', async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
      params(WORKSPACE_A)
    );
    const raw = await response.text();

    expect(raw).not.toContain('storage_path');
    expect(raw).not.toContain('storagePath');
    for (const call of db.signed) {
      expect(call.bucket).toBe('tenant-assets');
      expect(call.path.startsWith(`tenant/${WORKSPACE_A}/`)).toBe(true);
      // Short-lived: a leaked URL stops working in minutes, not forever.
      expect(call.ttl).toBeLessThanOrEqual(600);
    }
    const body = JSON.parse(raw) as { assets: Array<{ url: string | null }> };
    for (const asset of body.assets) {
      expect(asset.url).toContain('token=signed');
    }
  });

  it('does not let an unconfirmed asset make a project look ready', async () => {
    // Only the unconfirmed asset exists, so nothing may be counted.
    db.tables['assets'] = db
      .rows('assets')
      .filter((row) => row.id === ASSET_UNCONFIRMED);

    const withoutRights = (await (
      await GET(
        new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
        params(WORKSPACE_A)
      )
    ).json()) as {
      sufficiency: { ready: boolean; missing: Array<{ code: string }> } | null;
    };
    expect(withoutRights.sufficiency?.ready).toBe(false);
    expect(
      withoutRights.sufficiency?.missing.map((item) => item.code)
    ).toContain('hero_image_missing');

    // Confirm it, and the same picture now counts.
    await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: [ASSET_UNCONFIRMED] }),
      params(WORKSPACE_A)
    );

    const withRights = (await (
      await GET(
        new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
        params(WORKSPACE_A)
      )
    ).json()) as {
      sufficiency: { ready: boolean; missing: Array<{ code: string }> } | null;
    };
    expect(
      withRights.sufficiency?.missing.map((item) => item.code)
    ).not.toContain('hero_image_missing');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The rules that decide what an arriving file is, before any of it is stored.
// ───────────────────────────────────────────────────────────────────────────

/** A WebP header. Real enough for the magic-byte check, and unmeasurable. */
function webpBytes(): Buffer {
  const bytes = Buffer.alloc(32, 0);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(24, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8 ', 12, 'ascii');
  return bytes;
}

describe('verifying the bytes themselves', () => {
  it('refuses a file over the cap by its bytes, not by what it claimed', () => {
    // `File.size` is whatever the sender said. This is the check on what
    // actually arrived, and it is the one that decides.
    let thrown: unknown;
    try {
      verifyUpload(Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AssetUploadError);
    expect((thrown as AssetUploadError).status).toBe(413);
    expect((thrown as AssetUploadError).message).toMatch(/8MB/);
  });

  it('accepts a WebP and admits that its size is unknown', () => {
    const verified = verifyUpload(webpBytes());
    expect(verified.extension).toBe('webp');
    // Derived from the bytes, never from the upload's own claim.
    expect(verified.mime).toBe('image/webp');
    // A fabricated width would let the sufficiency gate pass a picture nobody
    // has measured, so an unreadable header is reported as no dimensions.
    expect(verified.width).toBeNull();
    expect(verified.height).toBeNull();
  });

  it('maps only the slot hints the sufficiency gate knows', () => {
    expect(usableForSlot('hero')).toEqual(['hero']);
    expect(usableForSlot(' Gallery ')).toEqual(['section']);
    // An unknown hint is dropped: `usable_for` is a claim, and a claim nobody
    // checked is worse than no claim.
    expect(usableForSlot('mood-board')).toEqual([]);
    expect(usableForSlot(null)).toEqual([]);
  });

  it('reads the caller ip from the proxy chain, or admits it has none', () => {
    const forwarded = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    });
    expect(clientIp(forwarded)).toBe('203.0.113.7');
    const real = new Request('http://localhost', {
      headers: { 'x-real-ip': '  198.51.100.4  ' },
    });
    expect(clientIp(real)).toBe('198.51.100.4');
    expect(clientIp(new Request('http://localhost'))).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The shape of the request, refused before a byte is buffered where possible.
// ───────────────────────────────────────────────────────────────────────────

describe('the shape of an upload request', () => {
  const url = `http://localhost/api/client/assets/${WORKSPACE_A}`;

  it('refuses a request that declares no content type at all', async () => {
    const response = await POST(
      new NextRequest(url, { method: 'POST' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/multipart\/form-data/);
    expect(db.uploads).toHaveLength(0);
  });

  it('refuses a declared length over the request cap before reading a byte', async () => {
    const response = await POST(
      new NextRequest(url, {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(64 * 1024 * 1024),
        },
        body: '--x--\r\n',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(413);
    expect(db.uploads).toHaveLength(0);
  });

  it('refuses a multipart body it cannot parse', async () => {
    const response = await POST(
      new NextRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
        body: 'this is not a multipart body at all',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('That upload could not be read');
    expect(db.uploads).toHaveLength(0);
  });

  it('refuses a form with no file in it', async () => {
    const form = new FormData();
    form.append('slot', 'hero');
    const response = await POST(
      new NextRequest(url, { method: 'POST', body: form }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('No files were sent');
  });

  it('refuses more files than one ask is ever about', async () => {
    const response = await POST(
      upload(
        WORKSPACE_A,
        Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, (_, index) => ({
          name: `photo-${index}.png`,
          type: 'image/png',
          bytes: pngBytes(1600, 900, index),
        }))
      ),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/at most 8 files/);
    expect(db.uploads).toHaveLength(0);
  });

  it('refuses a set of files that is only too large together', async () => {
    // Each file is under the per-file cap; the four of them are not.
    const seven = 7 * 1024 * 1024;
    const response = await POST(
      upload(
        WORKSPACE_A,
        Array.from({ length: 4 }, (_, index) => ({
          name: `big-${index}.png`,
          type: 'image/png',
          bytes: Buffer.concat([
            pngBytes(1600, 900, index),
            Buffer.alloc(seven),
          ]),
        }))
      ),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/too large/);
    expect(db.uploads).toHaveLength(0);
  });

  it('never echoes a hostile filename back into the page', async () => {
    const oversized = Buffer.concat([
      pngBytes(),
      Buffer.alloc(9 * 1024 * 1024),
    ]);
    const response = await POST(
      upload(WORKSPACE_A, [
        {
          name: '<img src=x onerror=alert(1)>.png',
          type: 'image/png',
          bytes: oversized,
        },
      ]),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(413);
    const body = await response.text();
    // The label lands in the DOM, so nothing that could open a tag or an
    // attribute survives: only word characters, dots, dashes and spaces.
    expect(body).not.toContain('<');
    expect(body).not.toContain('>');
    expect(body).not.toContain('=');
  });

  it('falls back to "That file" when a name sanitizes away to nothing', async () => {
    const oversized = Buffer.concat([
      pngBytes(),
      Buffer.alloc(9 * 1024 * 1024),
    ]);
    const response = await POST(
      upload(WORKSPACE_A, [
        { name: '<<<>>>', type: 'image/png', bytes: oversized },
      ]),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/^"That file" is larger/);
  });

  it('accepts a plain single-input form, and ignores fields it cannot use', async () => {
    const form = new FormData();
    form.append(
      'file',
      new File([new Uint8Array(pngBytes())], 'hero.png', { type: 'image/png' })
    );
    // Blank after trimming, and a value nobody would have typed: both are
    // dropped rather than stored, so `usable_for` stays a claim we checked.
    form.append('slot', '   ');
    form.append('kind', 'k'.repeat(65));
    form.append('askKey', 'hero_photo');

    const response = await POST(
      new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`, {
        method: 'POST',
        body: form,
      }),
      params(WORKSPACE_A)
    );

    expect(response.status).toBe(201);
    const [row] = assetsIn(WORKSPACE_A);
    expect(row).toMatchObject({ usable_for: [], kind: null });

    const event = db
      .rows('project_events')
      .find((entry) => entry.kind === 'asset_uploaded');
    // The ask the file answers is kept; the fields that failed validation are
    // simply not there.
    expect(event?.payload).toMatchObject({ askKey: 'hero_photo' });
    expect(event?.payload).not.toHaveProperty('slot');
  });

  it('names the files a client may already use alongside the new one', async () => {
    db.seed('assets', [
      {
        id: ASSET_CONFIRMED,
        workspace_id: WORKSPACE_A,
        source: 'upload',
        kind: null,
        storage_path: `tenant/${WORKSPACE_A}/assets/${'a'.repeat(64)}.png`,
        sha256: 'a'.repeat(64),
        mime: 'image/png',
        width: 1600,
        height: 900,
        usable_for: ['hero'],
        selected: true,
        rights_confirmed_at: '2026-08-30T09:00:00.000Z',
        created_at: '2026-08-30T09:00:00.000Z',
      },
    ]);

    const response = await POST(
      upload(WORKSPACE_A, [
        { name: 'new.png', type: 'image/png', bytes: pngBytes(1600, 900, 9) },
      ]),
      params(WORKSPACE_A)
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { usableAssetIds: string[] };
    // The file that arrived is not usable yet; the one with rights on it is.
    expect(body.usableAssetIds).toEqual([ASSET_CONFIRMED]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// What the client is told when storage or the database will not play.
// ───────────────────────────────────────────────────────────────────────────

describe('when storage or the database refuses', () => {
  const onePng = [{ name: 'photo.png', type: 'image/png', bytes: pngBytes() }];

  it('records nothing about a file the bucket would not take', async () => {
    db.failStorage({ upload: { message: 'bucket unavailable' } });
    const response = await POST(
      upload(WORKSPACE_A, onePng),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/Could not store that file/);
    // No row for an object that is not there.
    expect(assetsIn(WORKSPACE_A)).toHaveLength(0);
  });

  it('reports an insert failure that is not the dedupe index', async () => {
    db.failQuery({
      table: 'assets',
      mode: 'insert',
      error: { code: '42501', message: 'permission denied for table assets' },
    });
    const response = await POST(
      upload(WORKSPACE_A, onePng),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toMatch(/Could not record that file/);
    // The database's own words stay in the log, not in the response.
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });

  it('refuses rather than inventing a row when the dedupe target has gone', async () => {
    // 23505 says "this workspace already has that file", but nothing matches
    // the hash: the row went between the two statements. Answering 201 here
    // would hand the client an asset id that does not exist.
    db.failQuery({
      table: 'assets',
      mode: 'insert',
      error: { code: '23505', message: 'duplicate key value' },
    });
    const response = await POST(
      upload(WORKSPACE_A, onePng),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/Could not record that file/);
  });

  it('says only that the request failed when the connection drops', async () => {
    db.failQuery({
      table: 'assets',
      mode: 'insert',
      throws: new Error('connect ECONNREFUSED 127.0.0.1:54322'),
    });
    const response = await POST(
      upload(WORKSPACE_A, onePng),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: 'Request failed' });
    // A connection string is not the client's business.
    expect(JSON.stringify(body)).not.toContain('54322');
  });

  it('keeps a file the client successfully sent when the audit row fails', async () => {
    db.failQuery({
      table: 'project_events',
      mode: 'insert',
      error: { message: 'project_events is read only' },
    });
    const response = await POST(
      upload(WORKSPACE_A, onePng),
      params(WORKSPACE_A)
    );
    // Losing the audit trail must never lose the photograph.
    expect(response.status).toBe(201);
    expect(assetsIn(WORKSPACE_A)).toHaveLength(1);
    expect(db.rows('project_events')).toHaveLength(0);
  });

  it('keeps the file when the audit insert throws something that is not an Error', async () => {
    db.failQuery({
      table: 'project_events',
      mode: 'insert',
      throws: 'connection terminated',
    });
    const response = await POST(
      upload(WORKSPACE_A, onePng),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(201);
    expect(assetsIn(WORKSPACE_A)).toHaveLength(1);
  });

  it('reports a readable failure when the library cannot be listed', async () => {
    db.failQuery({
      table: 'assets',
      mode: 'select',
      error: { message: 'statement timeout' },
    });
    const response = await GET(
      new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('Could not load your files.');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Display URLs. The bucket is private, so a path is not a URL.
// ───────────────────────────────────────────────────────────────────────────

describe('signing a display url', () => {
  function seedAsset(overrides: Row): void {
    db.seed('assets', [
      {
        id: ASSET_CONFIRMED,
        workspace_id: WORKSPACE_A,
        source: 'upload',
        kind: null,
        mime: 'image/png',
        width: 1600,
        height: 900,
        usable_for: [],
        selected: true,
        rights_confirmed_at: '2026-08-30T09:00:00.000Z',
        created_at: '2026-08-30T09:00:00.000Z',
        ...overrides,
      },
    ]);
  }

  async function listed(): Promise<Array<{ url: string | null }>> {
    const response = await GET(
      new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);
    return (
      (await response.json()) as { assets: Array<{ url: string | null }> }
    ).assets;
  }

  it('refuses to sign a row that points at another tenant', async () => {
    // The row is this workspace's; the path is not. Signing it would hand a
    // client a working URL to somebody else's photograph.
    seedAsset({
      storage_path: `tenant/${WORKSPACE_B}/assets/${'c'.repeat(64)}.png`,
    });
    const assets = await listed();
    expect(assets[0]?.url).toBeNull();
    expect(db.signed).toHaveLength(0);
  });

  it('has no url for a row with no stored copy', async () => {
    seedAsset({ storage_path: null, usable_for: null });
    const assets = await listed();
    expect(assets[0]).toMatchObject({ url: null, usableFor: [] });
    expect(db.signed).toHaveLength(0);
  });

  it('has no url when storage declines to sign', async () => {
    seedAsset({
      storage_path: `tenant/${WORKSPACE_A}/assets/${'a'.repeat(64)}.png`,
    });
    db.failStorage({ sign: { message: 'object not found' } });
    const assets = await listed();
    expect(assets[0]?.url).toBeNull();
  });

  it('has no url when the storage client throws', async () => {
    seedAsset({
      storage_path: `tenant/${WORKSPACE_A}/assets/${'a'.repeat(64)}.png`,
    });
    db.failStorage({ signThrows: new Error('socket hang up') });
    const assets = await listed();
    // One picture that will not render is not a reason to fail the list.
    expect(assets[0]?.url).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Readiness. A missing figure is honest; a fabricated one is not.
// ───────────────────────────────────────────────────────────────────────────

describe('the readiness figure', () => {
  it('is absent, not invented, when the gate cannot be evaluated', async () => {
    gate.unavailable = true;
    const response = await GET(
      new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);
    expect((await response.json()).sufficiency).toBeNull();
  });

  it('still answers when the gate knows of no images at all', async () => {
    gate.reportImages = false;
    const response = await GET(
      new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
      params(WORKSPACE_A)
    );
    const body = (await response.json()) as {
      sufficiency: { ready: boolean; missing: Array<{ code: string }> } | null;
    };
    expect(body.sufficiency?.ready).toBe(false);
    expect(body.sufficiency?.missing.map((item) => item.code)).toContain(
      'hero_image_missing'
    );
  });

  it('does not count a logo whose rights were never confirmed', async () => {
    const LOGO = '66666666-6666-4666-8666-666666666666';
    db.seed('assets', [
      {
        id: LOGO,
        workspace_id: WORKSPACE_A,
        source: 'upload',
        kind: 'logo',
        storage_path: `tenant/${WORKSPACE_A}/assets/${'d'.repeat(64)}.png`,
        sha256: 'd'.repeat(64),
        mime: 'image/png',
        width: 800,
        height: 800,
        usable_for: ['logo'],
        selected: false,
        rights_confirmed_at: null,
        created_at: '2026-08-30T09:00:00.000Z',
      },
    ]);
    gate.logo = {
      id: LOGO,
      width: 800,
      height: 800,
      usableFor: ['logo'],
      isPlaceholder: false,
      kind: 'logo',
    };

    const before = (await (
      await GET(
        new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
        params(WORKSPACE_A)
      )
    ).json()) as {
      sufficiency: { missing: Array<{ code: string }> } | null;
    };
    expect(before.sufficiency?.missing.map((item) => item.code)).toContain(
      'logo_missing'
    );

    await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: [LOGO] }),
      params(WORKSPACE_A)
    );

    const after = (await (
      await GET(
        new NextRequest(`http://localhost/api/client/assets/${WORKSPACE_A}`),
        params(WORKSPACE_A)
      )
    ).json()) as {
      sufficiency: { missing: Array<{ code: string }> } | null;
    };
    expect(after.sufficiency?.missing.map((item) => item.code)).not.toContain(
      'logo_missing'
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The rights confirmation is evidence. Its two writes are ordered so that a
// failure leaves a confirmation nobody acted on, never an asset marked usable
// with nothing on record saying why.
// ───────────────────────────────────────────────────────────────────────────

describe('confirming rights when a write fails', () => {
  beforeEach(() => {
    db.seed('assets', [
      {
        id: ASSET_CHOSEN,
        workspace_id: WORKSPACE_A,
        source: 'upload',
        kind: null,
        storage_path: `tenant/${WORKSPACE_A}/assets/${'a'.repeat(64)}.png`,
        sha256: 'a'.repeat(64),
        mime: 'image/png',
        width: 1600,
        height: 900,
        usable_for: [],
        selected: false,
        rights_confirmed_at: null,
        created_at: '2026-08-30T10:00:00.000Z',
      },
    ]);
  });

  it('refuses a body that is not JSON', async () => {
    const response = await CONFIRM_RIGHTS(
      new NextRequest(
        `http://localhost/api/client/assets/${WORKSPACE_A}/rights`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'these are mine, honest',
        }
      ),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Invalid JSON');
    expect(db.rows('asset_rights_confirmations')).toHaveLength(0);
  });

  it('asks for at least one file, in words a panel can print', async () => {
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: [] }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      'Choose at least one file to confirm'
    );
  });

  it('refuses an id that is not an id at all', async () => {
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: ['../../etc/passwd'] }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect(db.rows('asset_rights_confirmations')).toHaveLength(0);
  });

  it('records one confirmation for the same file listed twice', async () => {
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: [ASSET_CHOSEN, ASSET_CHOSEN] }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(201);
    const [record] = db.rows('asset_rights_confirmations');
    // Duplicates would inflate the stored array without changing what was
    // confirmed, so they are collapsed before anything is written.
    expect(record?.asset_ids).toEqual([ASSET_CHOSEN]);
  });

  it('records what it could not see about the caller as null', async () => {
    const response = await CONFIRM_RIGHTS(
      new NextRequest(
        `http://localhost/api/client/assets/${WORKSPACE_A}/rights`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-real-ip': '198.51.100.4',
          },
          body: JSON.stringify({ assetIds: [ASSET_CHOSEN] }),
        }
      ),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(201);
    const [record] = db.rows('asset_rights_confirmations');
    expect(record?.ip).toBe('198.51.100.4');
    // No user agent was sent, and an invented one would be worse than none.
    expect(record?.user_agent).toBeNull();
  });

  it('answers 201 with a null confirmation id when the row comes back empty', async () => {
    db.failQuery({
      table: 'asset_rights_confirmations',
      mode: 'insert',
      data: [],
    });
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: [ASSET_CHOSEN] }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(201);
    expect((await response.json()).confirmationId).toBeNull();
  });

  it('says the files are not on this project when the check finds nothing', async () => {
    db.failQuery({ table: 'assets', mode: 'select', data: null });
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: [ASSET_CHOSEN] }),
      params(WORKSPACE_A)
    );
    // 404, not 403: the answer must not tell a prober that an id it does not
    // own is nonetheless real.
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('NOT_FOUND');
    expect(db.rows('asset_rights_confirmations')).toHaveLength(0);
  });

  it('stamps nothing when the ownership check itself fails', async () => {
    db.failQuery({
      table: 'assets',
      mode: 'select',
      error: { message: 'statement timeout' },
    });
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: [ASSET_CHOSEN] }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('Request failed');
    expect(
      db.rows('assets').find((row) => row.id === ASSET_CHOSEN)
        ?.rights_confirmed_at
    ).toBeNull();
  });

  it('stamps nothing when the evidence row cannot be written', async () => {
    // The evidence is written first on purpose: no confirmation on record
    // means no asset marked usable.
    db.failQuery({
      table: 'asset_rights_confirmations',
      mode: 'insert',
      error: { message: 'insert failed' },
    });
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: [ASSET_CHOSEN] }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    expect(
      db.rows('assets').find((row) => row.id === ASSET_CHOSEN)
        ?.rights_confirmed_at
    ).toBeNull();
  });

  it('leaves a confirmation nobody acted on when the stamp fails', async () => {
    db.failQuery({
      table: 'assets',
      mode: 'update',
      error: { message: 'update failed' },
    });
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: [ASSET_CHOSEN] }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    // The recoverable half of the failure: the statement is on record, the
    // asset is not yet usable.
    expect(db.rows('asset_rights_confirmations')).toHaveLength(1);
    expect(
      db.rows('assets').find((row) => row.id === ASSET_CHOSEN)
        ?.rights_confirmed_at
    ).toBeNull();
  });

  it('reports the library failure in its own words once everything is written', async () => {
    // The first `assets` select is the ownership check; the one after the
    // stamp is the listing that builds the response. Only the second fails,
    // so the confirmation stands and the client is told what actually broke.
    db.failQuery({
      table: 'assets',
      mode: 'select',
      skip: 1,
      error: { message: 'statement timeout' },
    });
    const response = await CONFIRM_RIGHTS(
      confirm(WORKSPACE_A, { assetIds: [ASSET_CHOSEN] }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('Could not load your files.');
    expect(db.rows('asset_rights_confirmations')).toHaveLength(1);
    expect(
      db.rows('assets').find((row) => row.id === ASSET_CHOSEN)
        ?.rights_confirmed_at
    ).toEqual(expect.any(String));
  });
});
