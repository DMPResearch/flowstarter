// @vitest-environment node
/**
 * The brief endpoint, through the REAL route handlers.
 *
 * Four things are defended here, and each of them is the kind of bug that only
 * shows up in production:
 *
 *  1. TENANCY. The handlers read and write with the service role, which
 *     bypasses RLS. `requireWorkspaceAccess` running first is the whole
 *     boundary, so the stranger cases assert not only the refusal but that no
 *     row was written and no file was listed.
 *  2. THE WHOLE REQUEST OR NONE. A body naming one asset the workspace does
 *     not own is refused outright. Saving the rest would silently drop a
 *     client's photograph while telling them it saved.
 *  3. `ready_at` IS A TRANSITION. It is the flag the build worker waits on: it
 *     must keep the instant the brief first became complete, and must clear
 *     the moment the brief stops being complete. `override_at` is an
 *     operator's column and this route must never touch it.
 *  4. THE AUDIT TRAIL CARRIES COUNTS, NOT PROSE. The offer is the client's own
 *     words about their business and does not belong in an events table.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
// Static imports: vi.mock is hoisted above them, and the app's tsconfig does
// not allow top-level await in tests.
import { GET, PUT } from '../route';
import { MIN_OFFER_CHARS } from '@/lib/flowstarter/brief-readiness';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';

const PHOTO_ONE = '11111111-1111-4111-8111-111111111111';
const PHOTO_TWO = '22222222-2222-4222-8222-222222222222';
const PHOTO_SMALL = '33333333-3333-4333-8333-333333333333';
const REFERENCE = '44444444-4444-4444-8444-444444444444';
const SCREENSHOT = '55555555-5555-4555-8555-555555555555';
const FOREIGN_ASSET = '66666666-6666-4666-8666-666666666666';

/** Long enough to clear `MIN_OFFER_CHARS` with room to spare. */
const GOOD_OFFER =
  'We fit and service gas boilers for homes across the county, and we take on ' +
  'the emergency call-outs nobody else will.';

// ── Clerk ──────────────────────────────────────────────────────────────────
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

// ── The database ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface QueryFailure {
  table: string;
  mode?: 'select' | 'insert' | 'update' | 'upsert';
  error?: unknown;
  throws?: unknown;
  /** Let this many matching queries through first. */
  skip?: number;
}

/**
 * An in-memory stand-in for the service-role client, in the same spirit as
 * `assets/[workspaceId]/__tests__/fake-asset-supabase.ts`: it filters for
 * real, it counts the calls that cross a tenant boundary, and it can be armed
 * to fail one query, because "the write failed" is a branch this route has to
 * survive rather than a branch nobody ever runs.
 */
const tables: Record<string, Row[]> = {};
const failures: QueryFailure[] = [];
const signed: string[] = [];
let signFailure = false;

function rows(table: string): Row[] {
  return (tables[table] ??= []);
}

function takeFailure(
  table: string,
  mode: 'select' | 'insert' | 'update' | 'upsert'
): QueryFailure | undefined {
  const index = failures.findIndex(
    (failure) =>
      failure.table === table && (!failure.mode || failure.mode === mode)
  );
  if (index < 0) return undefined;
  const failure = failures[index] as QueryFailure;
  if (failure.skip && failure.skip > 0) {
    failure.skip -= 1;
    return undefined;
  }
  failures.splice(index, 1);
  return failure;
}

function builder(table: string) {
  let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select';
  const filters: Array<[string, unknown]> = [];
  const inFilters: Array<[string, unknown[]]> = [];
  let payload: Row[] = [];
  let orderColumn: string | undefined;
  let ascending = true;
  let limit: number | undefined;

  function matches(row: Row): boolean {
    return (
      filters.every(([column, value]) => row[column] === value) &&
      inFilters.every(([column, values]) => values.includes(row[column]))
    );
  }

  function selected(): Row[] {
    let out = rows(table).filter(matches);
    if (orderColumn) {
      const column = orderColumn;
      out = [...out].sort((a, b) => {
        const left = String(a[column] ?? '');
        const right = String(b[column] ?? '');
        return (
          (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1)
        );
      });
    }
    if (limit !== undefined) out = out.slice(0, limit);
    return out;
  }

  function resolve(): { data: Row[] | null; error: unknown } {
    const failure = takeFailure(table, mode);
    if (failure) {
      if ('throws' in failure) throw failure.throws;
      return { data: null, error: failure.error ?? null };
    }
    if (mode === 'insert') {
      const inserted = payload.map((values, index) => ({
        id: `${table}-${rows(table).length + index}`,
        created_at: new Date(1_700_000_000_000).toISOString(),
        ...values,
      }));
      rows(table).push(...inserted);
      return { data: inserted, error: null };
    }
    if (mode === 'upsert') {
      for (const values of payload) {
        const existing = rows(table).find(
          (row) => row.workspace_id === values.workspace_id
        );
        if (existing) Object.assign(existing, values);
        else rows(table).push({ ...values });
      }
      return { data: payload, error: null };
    }
    if (mode === 'update') {
      const target = rows(table).filter(matches);
      for (const row of target) Object.assign(row, payload[0]);
      return { data: target, error: null };
    }
    return { data: selected(), error: null };
  }

  const self = {
    select() {
      return self;
    },
    insert(values: Row | Row[]) {
      mode = 'insert';
      payload = Array.isArray(values) ? values : [values];
      return self;
    },
    upsert(values: Row | Row[]) {
      mode = 'upsert';
      payload = Array.isArray(values) ? values : [values];
      return self;
    },
    update(values: Row) {
      mode = 'update';
      payload = [values];
      return self;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return self;
    },
    in(column: string, values: unknown[]) {
      inFilters.push([column, values]);
      return self;
    },
    order(column: string, options?: { ascending?: boolean }) {
      orderColumn = column;
      ascending = options?.ascending !== false;
      return self;
    },
    limit(count: number) {
      limit = count;
      return self;
    },
    maybeSingle() {
      const { data, error } = resolve();
      return Promise.resolve({ data: data?.[0] ?? null, error });
    },
    then(
      onFulfilled: (value: { data: Row[] | null; error: unknown }) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };
  return self;
}

const storage = {
  from(bucket: string) {
    return {
      async createSignedUrl(path: string, ttl: number) {
        signed.push(path);
        if (signFailure) return { data: null, error: { message: 'no' } };
        return {
          data: {
            signedUrl: `https://storage.test/${bucket}/${path}?t=${ttl}`,
          },
          error: null,
        };
      },
    };
  },
};

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builder, storage }),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A storage path `assertTenantPath` will accept, so signing is exercised. */
function pathFor(workspaceId: string, seed: string): string {
  return `tenant/${workspaceId}/assets/${seed.repeat(64).slice(0, 64)}.png`;
}

function assetRow(overrides: Row = {}): Row {
  const workspaceId = (overrides.workspace_id as string) ?? WORKSPACE_A;
  const id = (overrides.id as string) ?? PHOTO_ONE;
  return {
    id,
    workspace_id: workspaceId,
    source: 'upload',
    kind: null,
    mime: 'image/png',
    width: 2400,
    height: 1600,
    usable_for: ['hero'],
    selected: true,
    rights_confirmed_at: '2026-09-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    storage_path: pathFor(workspaceId, id.slice(0, 1)),
    ...overrides,
  };
}

function briefRow(overrides: Row = {}): Row {
  return {
    workspace_id: WORKSPACE_A,
    offer: '',
    projects: [],
    no_projects: false,
    design_reference_asset_ids: [],
    photo_asset_ids: [],
    ready_at: null,
    override_at: null,
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    offer: GOOD_OFFER,
    projects: [],
    noProjects: true,
    designReferenceAssetIds: [],
    photoAssetIds: [],
    ...overrides,
  };
}

function getRequest(): NextRequest {
  return new NextRequest('https://app.test/api/client/brief/x');
}

function putRequest(payload: unknown): NextRequest {
  return new NextRequest('https://app.test/api/client/brief/x', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function callGet(workspaceId: string) {
  return GET(getRequest(), { params: Promise.resolve({ workspaceId }) });
}

function callPut(workspaceId: string, payload: unknown) {
  return PUT(putRequest(payload), {
    params: Promise.resolve({ workspaceId }),
  });
}

/** The saved row for workspace A, or undefined when nothing was written. */
function savedBrief(): Row | undefined {
  return rows('workspace_briefs').find(
    (row) => row.workspace_id === WORKSPACE_A
  );
}

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  failures.length = 0;
  signed.length = 0;
  signFailure = false;
  authState.userId = 'user_client_a';
  authState.role = undefined;
  rows('workspace_memberships').push({
    workspace_id: WORKSPACE_A,
    clerk_user_id: 'user_client_a',
  });
  vi.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/client/brief/[workspaceId]', () => {
  it('refuses a signed-out caller before touching the database', async () => {
    authState.userId = null;
    const response = await callGet(WORKSPACE_A);
    expect(response.status).toBe(401);
    expect(signed).toEqual([]);
  });

  it('refuses a workspace id that is not a UUID', async () => {
    const response = await callGet('not-a-uuid');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('gives a non-member a 404 and lists nobody else s files', async () => {
    rows('assets').push(assetRow({ workspace_id: WORKSPACE_B }));
    const response = await callGet(WORKSPACE_B);
    expect(response.status).toBe(404);
    expect(signed).toEqual([]);
  });

  it('returns an empty brief on a first visit rather than an error', async () => {
    const response = await callGet(WORKSPACE_A);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.brief).toMatchObject({
      offer: '',
      projects: [],
      noProjects: false,
      designReferenceAssetIds: [],
      photoAssetIds: [],
      portraitAssetId: null,
      readyAt: null,
      overrideAt: null,
    });
    expect(payload.readiness.ready).toBe(false);
    expect(payload.readiness.completeness).toBe(0);
    expect(payload.assets).toEqual([]);
  });

  it('returns the stored brief, its files and the portrait it implies', async () => {
    rows('assets').push(
      assetRow({ id: PHOTO_ONE, kind: 'portrait' }),
      assetRow({ id: PHOTO_TWO })
    );
    rows('workspace_briefs').push(
      briefRow({
        offer: GOOD_OFFER,
        projects: [
          {
            name: 'Boiler swap',
            line: 'A same-day replacement',
            link: 'https://example.com',
            screenshotAssetIds: [SCREENSHOT],
          },
        ],
        design_reference_asset_ids: [REFERENCE],
        photo_asset_ids: [PHOTO_ONE, PHOTO_TWO],
        ready_at: '2026-09-10T10:00:00.000Z',
        override_at: '2026-09-11T10:00:00.000Z',
      })
    );

    const payload = await (await callGet(WORKSPACE_A)).json();
    expect(payload.brief.offer).toBe(GOOD_OFFER);
    expect(payload.brief.projects[0].name).toBe('Boiler swap');
    expect(payload.brief.portraitAssetId).toBe(PHOTO_ONE);
    expect(payload.brief.readyAt).toBe('2026-09-10T10:00:00.000Z');
    expect(payload.brief.overrideAt).toBe('2026-09-11T10:00:00.000Z');
    expect(payload.readiness.ready).toBe(true);
    expect(payload.assets).toHaveLength(2);
    expect(payload.assets[0].url).toContain('https://storage.test/');
  });

  it('reads a projects column that is not the shape we expect', async () => {
    rows('workspace_briefs').push(
      briefRow({ projects: 'not an array', offer: null, no_projects: null })
    );
    const payload = await (await callGet(WORKSPACE_A)).json();
    expect(payload.brief.projects).toEqual([]);
    expect(payload.brief.offer).toBe('');
    expect(payload.brief.noProjects).toBe(false);
  });

  it('drops entries in the projects column that are not objects', async () => {
    rows('workspace_briefs').push(
      briefRow({
        projects: [null, 'x', { line: 5, screenshotAssetIds: [1, 'keep'] }],
      })
    );
    const payload = await (await callGet(WORKSPACE_A)).json();
    expect(payload.brief.projects).toEqual([
      { name: '', line: '', link: '', screenshotAssetIds: ['keep'] },
    ]);
  });

  it('ignores a stored photo id whose file has since been deleted', async () => {
    rows('workspace_briefs').push(
      briefRow({ offer: GOOD_OFFER, photo_asset_ids: [PHOTO_ONE] })
    );
    const payload = await (await callGet(WORKSPACE_A)).json();
    expect(payload.brief.photoAssetIds).toEqual([PHOTO_ONE]);
    expect(
      payload.readiness.missing.map((e: { code: string }) => e.code)
    ).toContain('brief_photos_missing');
  });

  it('returns 500 when the brief cannot be read', async () => {
    failures.push({ table: 'workspace_briefs', error: { message: 'down' } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await callGet(WORKSPACE_A);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Request failed' });
  });

  it('reports the asset lister s own refusal with its own status', async () => {
    failures.push({ table: 'assets', error: { message: 'down' } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await callGet(WORKSPACE_A);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Could not load your files.',
    });
  });
});

describe('PUT /api/client/brief/[workspaceId]', () => {
  it('refuses a non-member and writes nothing', async () => {
    const response = await callPut(WORKSPACE_B, body());
    expect(response.status).toBe(404);
    expect(rows('workspace_briefs')).toEqual([]);
  });

  it('refuses a body that is not JSON', async () => {
    const response = await callPut(WORKSPACE_A, 'not json');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON' });
    expect(rows('workspace_briefs')).toEqual([]);
  });

  it('refuses a body the schema does not recognise', async () => {
    const response = await callPut(WORKSPACE_A, { offer: 12 });
    expect(response.status).toBe(400);
    expect(rows('workspace_briefs')).toEqual([]);
  });

  it('refuses an offer past the column s limit', async () => {
    const response = await callPut(
      WORKSPACE_A,
      body({ offer: 'a'.repeat(2001) })
    );
    expect(response.status).toBe(400);
  });

  it('refuses more projects than a brief may carry', async () => {
    const response = await callPut(
      WORKSPACE_A,
      body({
        noProjects: false,
        projects: Array.from({ length: 13 }, (_, index) => ({
          name: `Project ${index}`,
        })),
      })
    );
    expect(response.status).toBe(400);
  });

  it('refuses an asset id that is not a UUID', async () => {
    const response = await callPut(
      WORKSPACE_A,
      body({ photoAssetIds: ['nope'] })
    );
    expect(response.status).toBe(400);
  });

  it('refuses "no past work" and a list of past work in one body', async () => {
    const response = await callPut(
      WORKSPACE_A,
      body({ noProjects: true, projects: [{ name: 'Boiler swap' }] })
    );
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toContain('noProjects');
    expect(error).toContain('projects');
    expect(rows('workspace_briefs')).toEqual([]);
  });

  it('refuses a link that is not an https address, and names the project', async () => {
    const response = await callPut(
      WORKSPACE_A,
      body({
        noProjects: false,
        projects: [{ name: 'Boiler swap', link: 'http://example.com' }],
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Boiler swap');
  });

  it('refuses a link that is not a URL at all, and falls back to a number', async () => {
    const response = await callPut(
      WORKSPACE_A,
      body({
        noProjects: false,
        projects: [{ name: '   ', link: 'example.com' }],
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('project 1');
  });

  it('accepts a project with no link at all', async () => {
    const response = await callPut(
      WORKSPACE_A,
      body({ noProjects: false, projects: [{ name: 'Boiler swap' }] })
    );
    expect(response.status).toBe(200);
    expect(savedBrief()?.projects).toEqual([
      { name: 'Boiler swap', line: '', link: '', screenshotAssetIds: [] },
    ]);
  });

  it('refuses the whole request when one asset id is a stranger s', async () => {
    rows('assets').push(assetRow({ id: PHOTO_ONE }));
    rows('assets').push(
      assetRow({ id: FOREIGN_ASSET, workspace_id: WORKSPACE_B })
    );

    const response = await callPut(
      WORKSPACE_A,
      body({ photoAssetIds: [PHOTO_ONE, FOREIGN_ASSET] })
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
    // Not a partial save: the photo they do own is not written either.
    expect(rows('workspace_briefs')).toEqual([]);
  });

  it('checks screenshot ids too, not only the top-level arrays', async () => {
    const response = await callPut(
      WORKSPACE_A,
      body({
        noProjects: false,
        projects: [{ name: 'Boiler swap', screenshotAssetIds: [SCREENSHOT] }],
      })
    );
    expect(response.status).toBe(404);
  });

  it('refuses a portrait that is not one of the photos', async () => {
    rows('assets').push(
      assetRow({ id: PHOTO_ONE }),
      assetRow({ id: PHOTO_TWO })
    );
    const response = await callPut(
      WORKSPACE_A,
      body({ photoAssetIds: [PHOTO_ONE], portraitAssetId: PHOTO_TWO })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('portrait');
  });

  it('saves an incomplete brief without starting a build', async () => {
    const response = await callPut(
      WORKSPACE_A,
      body({ offer: 'Too short', noProjects: false })
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.readiness.ready).toBe(false);
    expect(payload.brief.readyAt).toBeNull();
    expect(savedBrief()?.ready_at).toBeNull();
    expect(GOOD_OFFER.length).toBeGreaterThan(MIN_OFFER_CHARS);
  });

  it('stamps ready_at the first time the brief is complete', async () => {
    const response = await callPut(WORKSPACE_A, body());
    const payload = await response.json();
    expect(payload.readiness.ready).toBe(true);
    expect(typeof payload.brief.readyAt).toBe('string');
    expect(savedBrief()?.ready_at).toBe(payload.brief.readyAt);
  });

  it('keeps the instant the brief first became complete on a second save', async () => {
    rows('workspace_briefs').push(
      briefRow({ ready_at: '2026-09-01T09:00:00.000Z' })
    );
    const payload = await (await callPut(WORKSPACE_A, body())).json();
    expect(payload.brief.readyAt).toBe('2026-09-01T09:00:00.000Z');
  });

  it('clears ready_at when a complete brief is emptied again', async () => {
    rows('workspace_briefs').push(
      briefRow({
        ready_at: '2026-09-01T09:00:00.000Z',
        override_at: '2026-09-02T09:00:00.000Z',
        override_by: 'operator@flowstarter.dev',
      })
    );
    const payload = await (
      await callPut(WORKSPACE_A, body({ offer: '', noProjects: false }))
    ).json();
    expect(payload.brief.readyAt).toBeNull();
    expect(savedBrief()?.ready_at).toBeNull();
    // An operator's decision is not the client's to revoke.
    expect(savedBrief()?.override_at).toBe('2026-09-02T09:00:00.000Z');
    expect(savedBrief()?.override_by).toBe('operator@flowstarter.dev');
    expect(payload.brief.overrideAt).toBe('2026-09-02T09:00:00.000Z');
  });

  it('updates the one row rather than adding a second', async () => {
    await callPut(WORKSPACE_A, body({ offer: GOOD_OFFER }));
    await callPut(WORKSPACE_A, body({ offer: `${GOOD_OFFER} And more.` }));
    expect(rows('workspace_briefs')).toHaveLength(1);
    expect(savedBrief()?.offer).toContain('And more.');
  });

  it('moves the portrait mark from one photo to another', async () => {
    rows('assets').push(
      assetRow({ id: PHOTO_ONE, kind: 'portrait' }),
      assetRow({ id: PHOTO_TWO })
    );

    const payload = await (
      await callPut(
        WORKSPACE_A,
        body({
          photoAssetIds: [PHOTO_ONE, PHOTO_TWO],
          portraitAssetId: PHOTO_TWO,
        })
      )
    ).json();

    const byId = new Map(rows('assets').map((row) => [row.id, row]));
    expect(byId.get(PHOTO_ONE)?.kind).toBeNull();
    expect(byId.get(PHOTO_TWO)?.kind).toBe('portrait');
    expect(payload.brief.portraitAssetId).toBe(PHOTO_TWO);
  });

  it('clears the portrait when the client sends null', async () => {
    rows('assets').push(assetRow({ id: PHOTO_ONE, kind: 'portrait' }));
    const payload = await (
      await callPut(
        WORKSPACE_A,
        body({ photoAssetIds: [PHOTO_ONE], portraitAssetId: null })
      )
    ).json();
    expect(payload.brief.portraitAssetId).toBeNull();
    expect(rows('assets')[0]?.kind).toBeNull();
  });

  it('leaves the portrait alone when the field is absent', async () => {
    rows('assets').push(assetRow({ id: PHOTO_ONE, kind: 'portrait' }));
    const payload = await (
      await callPut(WORKSPACE_A, body({ photoAssetIds: [PHOTO_ONE] }))
    ).json();
    expect(payload.brief.portraitAssetId).toBe(PHOTO_ONE);
  });

  it('judges the photographs it was given, undersized ones included', async () => {
    rows('assets').push(
      assetRow({ id: PHOTO_ONE, kind: 'portrait' }),
      assetRow({ id: PHOTO_TWO }),
      assetRow({ id: PHOTO_SMALL, width: 800, height: 600 })
    );
    const payload = await (
      await callPut(
        WORKSPACE_A,
        body({
          photoAssetIds: [PHOTO_ONE, PHOTO_TWO, PHOTO_SMALL],
          designReferenceAssetIds: [],
        })
      )
    ).json();
    const codes = payload.readiness.missing.map(
      (entry: { code: string }) => entry.code
    );
    expect(codes).not.toContain('brief_photos_missing');
    expect(codes).not.toContain('brief_portrait_missing');
    expect(codes).toContain('brief_design_reference_missing');
    expect(payload.readiness.ready).toBe(true);
  });

  it('records counts on the event and never the client s prose', async () => {
    rows('assets').push(assetRow({ id: REFERENCE }));
    await callPut(
      WORKSPACE_A,
      body({ offer: GOOD_OFFER, designReferenceAssetIds: [REFERENCE] })
    );

    const event = rows('project_events')[0];
    expect(event).toMatchObject({
      kind: 'brief_updated',
      actor: 'user_client_a',
      workspace_id: WORKSPACE_A,
    });
    const payload = event?.payload as Record<string, unknown>;
    expect(payload.offerChars).toBe(GOOD_OFFER.length);
    expect(payload.designReferenceCount).toBe(1);
    expect(payload.ready).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('boilers');
  });

  it('skips the ownership query when the body names no files', async () => {
    failures.push({ table: 'assets', mode: 'select', error: { message: 'x' } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The only `assets` select left is the lister's, so arming a failure here
    // proves the ownership query did not run first and eat it.
    const response = await callPut(WORKSPACE_A, body());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Could not load your files.',
    });
  });

  it('returns 500 when the ownership check itself fails', async () => {
    rows('assets').push(assetRow({ id: PHOTO_ONE }));
    failures.push({ table: 'assets', mode: 'select', error: { message: 'x' } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await callPut(
      WORKSPACE_A,
      body({ photoAssetIds: [PHOTO_ONE] })
    );
    expect(response.status).toBe(500);
    expect(rows('workspace_briefs')).toEqual([]);
  });

  it('returns 500 when the current row cannot be read', async () => {
    failures.push({
      table: 'workspace_briefs',
      mode: 'select',
      error: { message: 'x' },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await callPut(WORKSPACE_A, body());
    expect(response.status).toBe(500);
  });

  it('returns 500 when the portrait mark cannot be written', async () => {
    rows('assets').push(assetRow({ id: PHOTO_ONE, kind: 'portrait' }));
    rows('assets').push(assetRow({ id: PHOTO_TWO }));
    failures.push({ table: 'assets', mode: 'update', error: { message: 'x' } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await callPut(
      WORKSPACE_A,
      body({
        photoAssetIds: [PHOTO_ONE, PHOTO_TWO],
        portraitAssetId: PHOTO_TWO,
      })
    );
    expect(response.status).toBe(500);
  });

  it('returns 500 when the portrait promotion fails', async () => {
    rows('assets').push(assetRow({ id: PHOTO_ONE }));
    failures.push({
      table: 'assets',
      mode: 'update',
      error: { message: 'x' },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await callPut(
      WORKSPACE_A,
      body({ photoAssetIds: [PHOTO_ONE], portraitAssetId: PHOTO_ONE })
    );
    expect(response.status).toBe(500);
  });

  it('returns 500 when the brief cannot be written', async () => {
    failures.push({
      table: 'workspace_briefs',
      mode: 'upsert',
      error: { message: 'x' },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await callPut(WORKSPACE_A, body());
    expect(response.status).toBe(500);
    expect(rows('project_events')).toEqual([]);
  });

  it('survives a query that rejects rather than reporting an error', async () => {
    failures.push({
      table: 'workspace_briefs',
      mode: 'select',
      throws: new Error('connection lost'),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await callPut(WORKSPACE_A, body());
    expect(response.status).toBe(500);
  });

  it('still saves when a file cannot be signed for display', async () => {
    rows('assets').push(assetRow({ id: PHOTO_ONE }));
    signFailure = true;
    const payload = await (
      await callPut(WORKSPACE_A, body({ photoAssetIds: [PHOTO_ONE] }))
    ).json();
    expect(payload.assets[0].url).toBeNull();
    expect(savedBrief()?.photo_asset_ids).toEqual([PHOTO_ONE]);
  });

  it('lets a team member save for a workspace they are not a member of', async () => {
    authState.role = 'team';
    const response = await callPut(WORKSPACE_B, body());
    expect(response.status).toBe(200);
    expect(
      rows('workspace_briefs').find((row) => row.workspace_id === WORKSPACE_B)
    ).toBeTruthy();
  });
});
