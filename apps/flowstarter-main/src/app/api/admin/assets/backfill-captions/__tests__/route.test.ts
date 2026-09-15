/**
 * The backfill route, exercised without ever touching a real stack — every
 * assertion here runs against a hand-rolled fake `assets` table and a fake
 * storage bucket. The one thing this file must never do is prove the route
 * "works" by actually running it against dev/staging/production; per the
 * module's own doc comment, nobody has done that yet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const authState: { userId: string | null; role: string | undefined } = {
  userId: 'user_team_1',
  role: 'team',
};
vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: { metadata: { role: authState.role } },
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
}));

interface AssetRow {
  id: string;
  workspace_id: string;
  storage_path: string | null;
  mime: string | null;
  sha256: string | null;
  caption: string | null;
  caption_source: string | null;
  auto_caption: unknown;
  created_at: string;
}

const state = vi.hoisted(() => ({
  rows: [] as AssetRow[],
  updates: [] as Array<{ id: string; values: Record<string, unknown> }>,
  downloads: [] as string[],
  downloadFails: new Set<string>(),
}));

/**
 * Just enough of a Postgrest-alike to answer this route's own query shape:
 * `.select().is('caption', null).not('storage_path', 'is', null)
 *   [.eq('workspace_id', x)].order(...).limit(n)` for the read,
 * `.select('auto_caption').eq('sha256', x).not('auto_caption', 'is', null)
 *   .limit(1)` for the cache lookup, and `.update({...}).eq('id', x)` for
 * the write. Deliberately not the shared `fake-asset-supabase.ts` builder,
 * which supports neither `.is()` nor `.not()`.
 */
function assetsTable() {
  const filters: Array<[string, unknown]> = [];
  const notNullCols: string[] = [];
  const nullCols: string[] = [];
  let limitN: number | undefined;
  let mode: 'select' | 'update' = 'select';
  let updateValues: Record<string, unknown> = {};

  function matches(row: AssetRow): boolean {
    const asRecord = row as unknown as Record<string, unknown>;
    return (
      filters.every(([col, val]) => asRecord[col] === val) &&
      notNullCols.every(
        (col) => asRecord[col] !== null && asRecord[col] !== undefined
      ) &&
      nullCols.every(
        (col) => asRecord[col] === null || asRecord[col] === undefined
      )
    );
  }

  function resolved() {
    if (mode === 'update') {
      for (const row of state.rows.filter(matches)) {
        Object.assign(row, updateValues);
        state.updates.push({ id: row.id, values: { ...updateValues } });
      }
      return { data: null, error: null };
    }
    let out = state.rows
      .filter(matches)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    if (limitN !== undefined) out = out.slice(0, limitN);
    return { data: out, error: null };
  }

  const self = {
    select: () => self,
    update: (values: Record<string, unknown>) => {
      mode = 'update';
      updateValues = values;
      return self;
    },
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return self;
    },
    is: (col: string, _val: null) => {
      nullCols.push(col);
      return self;
    },
    not: (col: string, _op: string, val?: unknown) => {
      // `.not('storage_path', 'is', null)` and `.not('auto_caption', 'is', null)`
      // are the only two shapes this route ever sends.
      if (val === undefined || val === null) notNullCols.push(col);
      return self;
    },
    order: () => self,
    limit: (n: number) => {
      limitN = n;
      return self;
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolved()).then(resolve),
  };
  return self;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      if (table !== 'assets') throw new Error(`unexpected table ${table}`);
      return assetsTable();
    },
    storage: {
      from: () => ({
        download: async (path: string) => {
          state.downloads.push(path);
          if (state.downloadFails.has(path)) {
            return { data: null, error: new Error('not found') };
          }
          return {
            data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
            error: null,
          };
        },
      }),
    },
  }),
}));

const autoCaption = vi.hoisted(() => ({
  calls: [] as Array<{ workspaceId: string | null | undefined }>,
  result: null as null | {
    subject: string;
    kind: 'screenshot' | 'photo' | 'logo' | 'document';
    showsPerson: boolean;
    visibleName: string | null;
    dominantColors: string[];
  },
}));
vi.mock('@/lib/ai/asset-caption', () => ({
  autoCaptionAsset: async (input: { workspaceId?: string | null }) => {
    autoCaption.calls.push({ workspaceId: input.workspaceId });
    return autoCaption.result;
  },
}));

import { POST } from '../route';

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';

function row(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: `asset-${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: WORKSPACE_A,
    storage_path: 'tenant/x/assets/a.png',
    mime: 'image/png',
    sha256: 'a'.repeat(64),
    caption: null,
    caption_source: null,
    auto_caption: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function request(body: unknown): NextRequest {
  return new NextRequest(
    'http://localhost/api/admin/assets/backfill-captions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

const GUESS = {
  subject: 'A logo on a white background',
  kind: 'logo' as const,
  showsPerson: false,
  visibleName: null,
  dominantColors: ['white'],
};

beforeEach(() => {
  state.rows = [];
  state.updates = [];
  state.downloads = [];
  state.downloadFails = new Set();
  autoCaption.calls = [];
  autoCaption.result = null;
  authState.userId = 'user_team_1';
  authState.role = 'team';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/admin/assets/backfill-captions', () => {
  it('refuses a non-team caller before it reads anything', async () => {
    authState.role = undefined;
    state.rows = [row()];

    const response = await POST(request({}));

    expect(response.status).toBe(403);
    expect(state.downloads).toHaveLength(0);
    expect(autoCaption.calls).toHaveLength(0);
  });

  it('captions every uncaptioned row it finds and writes the result back', async () => {
    autoCaption.result = GUESS;
    state.rows = [row({ id: 'a1' }), row({ id: 'a2', sha256: 'b'.repeat(64) })];

    const response = await POST(request({}));
    const body = await response.json();

    expect(body.summary).toMatchObject({
      scanned: 2,
      captioned: 2,
      failed: 0,
      hasMore: false,
    });
    expect(state.updates).toHaveLength(2);
    expect(state.updates[0]?.values).toEqual({
      caption: GUESS.subject,
      caption_source: 'auto',
      auto_caption: GUESS,
    });
  });

  it('reuses an existing auto-caption for the same content hash instead of asking again', async () => {
    autoCaption.result = GUESS;
    state.rows = [
      row({
        id: 'already-captioned',
        sha256: 'c'.repeat(64),
        auto_caption: GUESS,
        caption: GUESS.subject,
      }),
      row({ id: 'needs-one', sha256: 'c'.repeat(64) }),
    ];

    // Only the second row is a candidate (`caption is null`); the cache
    // lookup for its sha256 finds the first row's already-written guess.
    const response = await POST(request({}));
    const body = await response.json();

    expect(body.summary).toMatchObject({
      scanned: 1,
      reusedFromCache: 1,
      captioned: 0,
    });
    expect(autoCaption.calls).toHaveLength(0);
    expect(state.downloads).toHaveLength(0);
    expect(state.updates[0]?.values.auto_caption).toEqual(GUESS);
  });

  it('fails closed to no caption at all, and leaves the row untouched, when the vision call cannot answer', async () => {
    autoCaption.result = null;
    state.rows = [row({ id: 'unanswerable' })];

    const response = await POST(request({}));
    const body = await response.json();

    expect(body.summary).toMatchObject({
      scanned: 1,
      captioned: 0,
      skippedNoBytes: 1,
      failed: 0,
    });
    expect(state.updates).toHaveLength(0);
  });

  it('a dry run reports what it would do and writes nothing', async () => {
    autoCaption.result = GUESS;
    state.rows = [row({ id: 'preview-only' })];

    const response = await POST(request({ dryRun: true }));
    const body = await response.json();

    expect(body.summary).toMatchObject({ scanned: 1, captioned: 1 });
    expect(state.updates).toHaveLength(0);
  });

  it('pages: reports hasMore and processes only the requested limit', async () => {
    autoCaption.result = GUESS;
    state.rows = [
      row({ id: 'p1', sha256: '1'.repeat(64) }),
      row({ id: 'p2', sha256: '2'.repeat(64) }),
      row({ id: 'p3', sha256: '3'.repeat(64) }),
    ];

    const response = await POST(request({ limit: 2 }));
    const body = await response.json();

    expect(body.summary).toMatchObject({ scanned: 2, hasMore: true });
    expect(state.updates).toHaveLength(2);
  });

  it('scopes the sweep to one workspace when asked', async () => {
    autoCaption.result = GUESS;
    state.rows = [
      row({
        id: 'in-scope',
        workspace_id: WORKSPACE_A,
        sha256: '4'.repeat(64),
      }),
      row({
        id: 'out-of-scope',
        workspace_id: WORKSPACE_B,
        sha256: '5'.repeat(64),
      }),
    ];

    const response = await POST(request({ workspaceId: WORKSPACE_A }));
    const body = await response.json();

    expect(body.summary.scanned).toBe(1);
    expect(state.updates.map((u) => u.id)).toEqual(['in-scope']);
  });

  it('a row with no readable bytes is skipped, not failed', async () => {
    state.rows = [
      row({ id: 'missing-bytes', storage_path: 'tenant/x/assets/gone.png' }),
    ];
    state.downloadFails.add('tenant/x/assets/gone.png');

    const response = await POST(request({}));
    const body = await response.json();

    expect(body.summary).toMatchObject({
      scanned: 1,
      skippedNoBytes: 1,
      failed: 0,
    });
    expect(autoCaption.calls).toHaveLength(0);
  });
});
