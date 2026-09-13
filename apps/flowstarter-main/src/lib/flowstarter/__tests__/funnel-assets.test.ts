/**
 * Codex audit F14: anonymous funnel uploads used to have no reaping parent.
 *
 * `funnel_assets.preview_id` carries no foreign key on purpose — a picture
 * is frequently uploaded before `funnel_previews` exists at all — but that
 * left two gaps:
 *
 *   1. `storeFunnelAsset`'s per-preview cap was a `select count(*)` followed
 *      by a separate `insert`. Two concurrent uploads for the same preview
 *      id could both pass the check before either landed.
 *   2. The reaper only ever swept rows in `funnel_previews`. A preview id
 *      that was only ever used to upload a picture — the visitor abandons
 *      the wizard before generating anything — has no row there to expire,
 *      so nothing ever reaped it: a fresh UUID per attempt accumulated
 *      unclaimed pictures forever.
 *
 * `reserve_funnel_upload_slot` (a database function) and
 * `funnel_upload_sessions` (its table) close both: the cap is now an atomic
 * compare-and-set, and the session it reserves against has its own short
 * TTL that `reapExpiredFunnelUploadSessions` sweeps independently of
 * `funnel_previews`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createFakeSupabase, type Row } from './fake-supabase';
import {
  storeFunnelAsset,
  reapExpiredFunnelUploadSessions,
  deleteFunnelAssets,
  MAX_FUNNEL_ASSETS_PER_PREVIEW,
  FunnelAssetError,
} from '../funnel-assets';

vi.mock('server-only', () => ({}));

const loadFunnelPreview = vi.fn();
vi.mock('@/lib/hosting/funnel-previews', () => ({
  loadFunnelPreview: (...args: unknown[]) => loadFunnelPreview(...args),
}));

const PREVIEW_A = '11111111-1111-4111-8111-111111111111';
const PREVIEW_B = '22222222-2222-4222-8222-222222222222';

function file(seed: string) {
  const bytes = Buffer.from(seed);
  return {
    bytes,
    extension: 'png',
    mime: 'image/png',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: 100,
    height: 100,
  };
}

/**
 * Wraps the shared row-store fake with the two things `funnel-assets.ts`
 * needs that it does not otherwise model: object storage, and the
 * `reserve_funnel_upload_slot` RPC. The RPC body below is a faithful,
 * synchronous restatement of the SQL function in
 * `20260913180000_funnel_upload_sessions.sql` — find-or-create the session,
 * then reserve only if under quota — which is what makes it a meaningful
 * stand-in for the database's own atomicity: there is no `await` between
 * reading and writing the counter, so a batch of concurrent JS callers is
 * still serialized exactly the way concurrent Postgres transactions
 * contending for the same row would be.
 */
function fakeClient(db: ReturnType<typeof createFakeSupabase>) {
  const objects = new Set<string>();

  const storage = {
    from() {
      return {
        upload: async (path: string) => {
          objects.add(path);
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          for (const path of paths) objects.delete(path);
          return { data: null, error: null };
        },
      };
    },
  };

  async function rpc(name: string, args: Record<string, unknown>) {
    if (name !== 'reserve_funnel_upload_slot') {
      throw new Error(`fake rpc: unknown function ${name}`);
    }
    const previewId = args.p_preview_id as string;
    const maxAssets = args.p_max_assets as number;
    const ttlSeconds = args.p_ttl_seconds as number;
    const sessions = db.rows('funnel_upload_sessions');
    const newExpiry = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    let session = sessions.find((row) => row.preview_id === previewId);
    if (!session) {
      session = {
        id: `session-${sessions.length + 1}`,
        preview_id: previewId,
        assets_reserved: 0,
        max_assets: maxAssets,
        created_at: new Date().toISOString(),
        expires_at: newExpiry,
      };
      sessions.push(session);
    } else {
      session.expires_at =
        String(session.expires_at) > newExpiry ? session.expires_at : newExpiry;
      session.max_assets = maxAssets;
    }

    let reserved = false;
    if ((session.assets_reserved as number) < (session.max_assets as number)) {
      session.assets_reserved = (session.assets_reserved as number) + 1;
      reserved = true;
    }
    return {
      data: [{ session_id: session.id, reserved }],
      error: null,
    };
  }

  return {
    from: db.client.from,
    storage,
    rpc,
  } as unknown as SupabaseClient<Database>;
}

beforeEach(() => {
  loadFunnelPreview.mockReset();
});

describe('storeFunnelAsset — the atomic cap', () => {
  it('allows uploads up to the configured cap', async () => {
    const db = createFakeSupabase();
    const client = fakeClient(db);
    for (let i = 0; i < MAX_FUNNEL_ASSETS_PER_PREVIEW; i++) {
      await storeFunnelAsset({
        previewId: PREVIEW_A,
        file: file(`a${i}`),
        kind: 'photo',
        rights: null,
        supabase: client,
      });
    }
    expect(db.rows('funnel_assets')).toHaveLength(
      MAX_FUNNEL_ASSETS_PER_PREVIEW
    );
  });

  it('refuses an upload past the cap', async () => {
    const db = createFakeSupabase();
    const client = fakeClient(db);
    for (let i = 0; i < MAX_FUNNEL_ASSETS_PER_PREVIEW; i++) {
      await storeFunnelAsset({
        previewId: PREVIEW_A,
        file: file(`a${i}`),
        kind: 'photo',
        rights: null,
        supabase: client,
      });
    }
    await expect(
      storeFunnelAsset({
        previewId: PREVIEW_A,
        file: file('one-too-many'),
        kind: 'photo',
        rights: null,
        supabase: client,
      })
    ).rejects.toBeInstanceOf(FunnelAssetError);
    expect(db.rows('funnel_assets')).toHaveLength(
      MAX_FUNNEL_ASSETS_PER_PREVIEW
    );
  });

  it('does not count a re-upload of the same file against the cap', async () => {
    const db = createFakeSupabase();
    const client = fakeClient(db);
    const same = file('duplicate');
    for (let i = 0; i < MAX_FUNNEL_ASSETS_PER_PREVIEW + 2; i++) {
      const row = await storeFunnelAsset({
        previewId: PREVIEW_A,
        file: same,
        kind: 'photo',
        rights: null,
        supabase: client,
      });
      expect(row.sha256).toBe(same.sha256);
    }
    expect(db.rows('funnel_assets')).toHaveLength(1);
  });

  it('scopes the cap to one preview at a time', async () => {
    const db = createFakeSupabase();
    const client = fakeClient(db);
    for (let i = 0; i < MAX_FUNNEL_ASSETS_PER_PREVIEW; i++) {
      await storeFunnelAsset({
        previewId: PREVIEW_A,
        file: file(`a${i}`),
        kind: 'photo',
        rights: null,
        supabase: client,
      });
    }
    // A different preview id starts with its own, fresh quota.
    await expect(
      storeFunnelAsset({
        previewId: PREVIEW_B,
        file: file('b0'),
        kind: 'photo',
        rights: null,
        supabase: client,
      })
    ).resolves.toMatchObject({ previewId: PREVIEW_B });
  });

  // The bug this exists to close: a `select count(*)` then a separate
  // `insert` lets concurrent uploads for the same preview all pass the
  // check before any of them land. Firing more uploads than the cap allows
  // at once must still leave exactly the cap's worth of rows stored.
  it('never exceeds the cap under concurrent uploads for the same preview', async () => {
    const db = createFakeSupabase();
    const client = fakeClient(db);
    const attempts = MAX_FUNNEL_ASSETS_PER_PREVIEW + 5;

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) =>
        storeFunnelAsset({
          previewId: PREVIEW_A,
          file: file(`concurrent-${i}`),
          kind: 'photo',
          rights: null,
          supabase: client,
        })
      )
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(MAX_FUNNEL_ASSETS_PER_PREVIEW);
    expect(failed).toHaveLength(attempts - MAX_FUNNEL_ASSETS_PER_PREVIEW);
    expect(db.rows('funnel_assets')).toHaveLength(
      MAX_FUNNEL_ASSETS_PER_PREVIEW
    );
    // Every failure is the cap, not something else going wrong.
    for (const r of failed) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(FunnelAssetError);
      }
    }
  });
});

describe('reapExpiredFunnelUploadSessions', () => {
  function seedSession(
    db: ReturnType<typeof createFakeSupabase>,
    overrides: Row = {}
  ) {
    db.seed('funnel_upload_sessions', [
      {
        id: 'session-1',
        preview_id: PREVIEW_A,
        assets_reserved: 1,
        max_assets: MAX_FUNNEL_ASSETS_PER_PREVIEW,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
        ...overrides,
      },
    ]);
  }

  // Upload-only abandonment: nobody ever generated a preview from this id.
  it('reaps the assets and storage objects of a session whose preview id never became a preview', async () => {
    const db = createFakeSupabase();
    const client = fakeClient(db);
    loadFunnelPreview.mockResolvedValue(null);
    seedSession(db);
    db.seed('funnel_assets', [
      {
        id: 'asset-1',
        preview_id: PREVIEW_A,
        storage_path: `funnel/${PREVIEW_A}/assets/a.png`,
        sha256: 'sha-a',
        source: 'upload',
        kind: 'photo',
        usable_for: ['section'],
      },
    ]);

    const result = await reapExpiredFunnelUploadSessions({ supabase: client });

    expect(result.considered).toBe(1);
    expect(result.sessionsRemoved).toBe(1);
    expect(result.picturesRemoved).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.sessions).toEqual([
      { previewId: PREVIEW_A, orphaned: true, picturesRemoved: 1 },
    ]);
    expect(db.rows('funnel_upload_sessions')).toHaveLength(0);
    expect(db.rows('funnel_assets')).toHaveLength(0);
  });

  // A preview WAS generated from this upload: the main preview reaper now
  // owns the assets' lifecycle on its own (longer) TTL. Only the now-unused
  // session bookkeeping row is removed.
  it('leaves the assets alone once a real preview exists, and only clears the session', async () => {
    const db = createFakeSupabase();
    const client = fakeClient(db);
    loadFunnelPreview.mockResolvedValue({
      previewId: PREVIEW_A,
      claimedWorkspaceId: null,
    });
    seedSession(db);
    db.seed('funnel_assets', [
      {
        id: 'asset-1',
        preview_id: PREVIEW_A,
        storage_path: `funnel/${PREVIEW_A}/assets/a.png`,
        sha256: 'sha-a',
        source: 'upload',
        kind: 'photo',
        usable_for: ['section'],
      },
    ]);

    const result = await reapExpiredFunnelUploadSessions({ supabase: client });

    expect(result.sessionsRemoved).toBe(1);
    expect(result.picturesRemoved).toBe(0);
    expect(result.sessions).toEqual([
      { previewId: PREVIEW_A, orphaned: false, picturesRemoved: 0 },
    ]);
    expect(db.rows('funnel_upload_sessions')).toHaveLength(0);
    // Untouched — that preview's own reaper owns this now.
    expect(db.rows('funnel_assets')).toHaveLength(1);
  });

  it('ignores a session that has not expired yet', async () => {
    const db = createFakeSupabase();
    const client = fakeClient(db);
    seedSession(db, {
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await reapExpiredFunnelUploadSessions({ supabase: client });

    expect(result.considered).toBe(0);
    expect(db.rows('funnel_upload_sessions')).toHaveLength(1);
    expect(loadFunnelPreview).not.toHaveBeenCalled();
  });

  it('does not let one failing session stop the rest of the sweep', async () => {
    const db = createFakeSupabase();
    const client = fakeClient(db);
    db.seed('funnel_upload_sessions', [
      {
        id: 'session-broken',
        preview_id: PREVIEW_A,
        assets_reserved: 1,
        max_assets: MAX_FUNNEL_ASSETS_PER_PREVIEW,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
      {
        id: 'session-ok',
        preview_id: PREVIEW_B,
        assets_reserved: 1,
        max_assets: MAX_FUNNEL_ASSETS_PER_PREVIEW,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    loadFunnelPreview.mockImplementation(async (previewId: string) => {
      if (previewId === PREVIEW_A) throw new Error('boom');
      return null;
    });

    const result = await reapExpiredFunnelUploadSessions({ supabase: client });

    expect(result.considered).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.sessionsRemoved).toBe(1);
    expect(db.rows('funnel_upload_sessions')).toEqual([
      expect.objectContaining({ id: 'session-broken' }),
    ]);
  });
});

describe('deleteFunnelAssets', () => {
  it("removes only objects under the preview's own prefix", async () => {
    const db = createFakeSupabase();
    const client = fakeClient(db);
    db.seed('funnel_assets', [
      {
        id: 'asset-1',
        preview_id: PREVIEW_A,
        storage_path: `funnel/${PREVIEW_A}/assets/a.png`,
        sha256: 'sha-a',
        source: 'upload',
        usable_for: [],
      },
    ]);
    const result = await deleteFunnelAssets({
      previewId: PREVIEW_A,
      supabase: client,
    });
    expect(result.removed).toBe(1);
    expect(db.rows('funnel_assets')).toHaveLength(0);
  });
});
