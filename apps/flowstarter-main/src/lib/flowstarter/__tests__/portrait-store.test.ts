/**
 * The write half of "load my portrait from my social pages".
 *
 * Everything pinned here is a product argument rather than an implementation
 * detail:
 *
 *   - a person who connected an account is recorded even when the account had
 *     no picture, because the fact that they connected is what the intake and
 *     the brief have to be able to say something true about;
 *   - a picture that arrives through a connect flow is filed with its rights
 *     ALREADY CONFIRMED, because the person authorised it at the provider, and
 *     asking again on the brief would be asking a question they have answered;
 *   - a hundred-pixel Instagram portrait is filed as an avatar and is never
 *     given a role that would let something scale it into a hero;
 *   - nothing in this path throws. A portrait we could not get is a preview
 *     that looks less like the client, not a broken funnel.
 *
 * The Supabase double below implements only the chain `portrait-store.ts`
 * actually uses. Anything else throwing is the point, not an omission.
 */
import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeFunnelAsset = vi.fn();
vi.mock('../funnel-assets', () => ({
  TENANT_ASSET_BUCKET: 'tenant-assets',
  storeFunnelAsset: (...args: unknown[]) => storeFunnelAsset(...args),
}));

import { CURRENT_RIGHTS_STATEMENT_VERSION } from '@/components/flowstarter/rights-statement';

import type { PortraitProfile } from '../portrait-connect';
import {
  capturePortraitFromProvider,
  loadPortraitConnections,
} from '../portrait-store';

const PREVIEW = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE = '3a3a2c8e-1f3a-4b4a-9b0e-2f6a1d3c4e5f';
const CONNECTION = 'b2d0d0c6-2f2b-4a3f-8d51-7f0f2a9c1e44';
const AT = new Date('2026-09-13T12:00:00.000Z');
const FETCHED_AT = AT.toISOString();

/** The floors and the budgets, named rather than inherited from the shell. */
const ENV = {};

type Row = Record<string, unknown>;

interface QueuedError {
  table: string;
  mode: 'select' | 'insert' | 'update';
  error: { code?: string; message: string };
  /** Rows the loser of a race finds waiting when it looks again. */
  seed?: Row[];
}

function fakeSupabase(
  seed: { portrait_connections?: Row[]; assets?: Row[] } = {}
) {
  const tables: Record<string, Row[]> = {
    portrait_connections: [...(seed.portrait_connections ?? [])],
    assets: [...(seed.assets ?? [])],
  };
  const uploads: Array<{ bucket: string; path: string; contentType?: string }> =
    [];
  const queued: QueuedError[] = [];
  let uploadError: { message: string } | null = null;
  let sequence = 0;

  function takeError(table: string, mode: QueuedError['mode']) {
    const index = queued.findIndex(
      (entry) => entry.table === table && entry.mode === mode
    );
    if (index === -1) return null;
    const [entry] = queued.splice(index, 1) as [QueuedError];
    if (entry.seed) (tables[entry.table] ??= []).push(...entry.seed);
    return entry.error;
  }

  function builder(table: string) {
    let mode: QueuedError['mode'] = 'select';
    const filters: Array<[string, unknown]> = [];
    let payload: Row = {};
    const rows = () => (tables[table] ??= []);
    const matched = () =>
      rows().filter((row) =>
        filters.every(([column, value]) => row[column] === value)
      );

    function resolve(): { data: Row[] | null; error: unknown } {
      const failure = takeError(table, mode);
      if (failure) return { data: null, error: failure };
      if (mode === 'insert') {
        sequence += 1;
        const row: Row = { id: `${table}-${sequence}`, ...payload };
        rows().push(row);
        return { data: [{ ...row }], error: null };
      }
      if (mode === 'update') {
        const target = matched();
        for (const row of target) Object.assign(row, payload);
        return { data: target.map((row) => ({ ...row })), error: null };
      }
      return { data: matched().map((row) => ({ ...row })), error: null };
    }

    const self = {
      select() {
        return self;
      },
      insert(values: Row) {
        mode = 'insert';
        payload = values;
        return self;
      },
      update(values: Row) {
        mode = 'update';
        payload = values;
        return self;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return self;
      },
      order() {
        return self;
      },
      maybeSingle() {
        const { data, error } = resolve();
        return Promise.resolve({ data: data?.[0] ?? null, error });
      },
      single() {
        return self.maybeSingle();
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

  return {
    tables,
    uploads,
    fail(entry: QueuedError) {
      queued.push(entry);
    },
    failUpload(message: string) {
      uploadError = { message };
    },
    client: {
      from: builder,
      storage: {
        from(bucket: string) {
          return {
            async upload(path: string, _bytes: Buffer, options?: Row) {
              uploads.push({
                bucket,
                path,
                contentType: options?.contentType as string | undefined,
              });
              return uploadError
                ? { data: null, error: uploadError }
                : { data: { path }, error: null };
            },
          };
        },
      },
    },
  };
}

/**
 * A real PNG header, so the byte check and the size probe both read the same
 * dimensions this test claims. A made-up buffer would be refused for the wrong
 * reason and would prove nothing.
 */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR', 'ascii'),
    ihdr,
  ]);
}

/** Valid WebP magic and nothing the probe can read a size out of. */
const WEBP_UNMEASURABLE = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBPVP8 ', 'ascii'),
  Buffer.alloc(8),
]);

function responding(
  body: Buffer,
  init: { ok?: boolean; contentLength?: string } = {}
): Response {
  return {
    ok: init.ok ?? true,
    headers: new Headers(
      init.contentLength ? { 'content-length': init.contentLength } : {}
    ),
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

function serving(
  body: Buffer,
  init?: { ok?: boolean; contentLength?: string }
) {
  return vi.fn(async () => responding(body, init)) as unknown as typeof fetch;
}

function profileOf(overrides: Partial<PortraitProfile> = {}): PortraitProfile {
  return {
    provider: 'linkedin',
    accountId: 'sub-9f31',
    name: 'Darius Popescu',
    headline: 'Builds funnels that book work',
    pictureUrl: 'https://media.licdn.example/portrait.png',
    accountType: 'unknown',
    ...overrides,
  };
}

beforeEach(() => {
  storeFunnelAsset.mockReset();
  storeFunnelAsset.mockImplementation(async (input: Row) => ({
    id: 'funnel-asset-1',
    previewId: input.previewId,
    source: input.source,
    kind: input.kind,
    storagePath: 'funnel/x/assets/a.png',
    sha256: 'abc',
    mime: 'image/png',
    width: 100,
    height: 100,
    usableFor: input.usableFor ?? [],
    rightsConfirmedAt: FETCHED_AT,
    claimedAssetId: null,
    sourceUrl: null,
    fetchedAt: FETCHED_AT,
  }));
});

describe('capturePortraitFromProvider', () => {
  it('records the connection even when the account has no picture', async () => {
    // The picture is the point, but it is not the only thing the connection is
    // worth: a name and a line of the person's own prose are two of the three
    // things the brief asks for, and the fact that they connected at all is
    // what lets the intake say something true about what happened.
    const fake = fakeSupabase();
    const outcome = await capturePortraitFromProvider({
      connectionId: CONNECTION,
      profile: profileOf({ pictureUrl: '' }),
      previewId: PREVIEW,
      workspaceId: null,
      supabase: fake.client as never,
      env: ENV,
      now: AT,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_public_url' });
    expect(fake.tables.portrait_connections).toHaveLength(1);
    expect(fake.tables.portrait_connections?.[0]).toMatchObject({
      id: CONNECTION,
      provider: 'linkedin',
      provider_account_id: 'sub-9f31',
      preview_id: PREVIEW,
      display_name: 'Darius Popescu',
      headline: 'Builds funnels that book work',
    });
    expect(storeFunnelAsset).not.toHaveBeenCalled();
  });

  it('refuses a picture URL we are not willing to request', async () => {
    // A provider that hands us a loopback or a plain http URL is not a source,
    // and a server that fetches whatever it is told to is a server somebody
    // will eventually point at our own network.
    const fake = fakeSupabase();
    const fetchImpl = serving(png(400, 400));
    const outcome = await capturePortraitFromProvider({
      connectionId: CONNECTION,
      profile: profileOf({ pictureUrl: 'http://127.0.0.1/portrait.png' }),
      previewId: PREVIEW,
      workspaceId: null,
      fetchImpl,
      supabase: fake.client as never,
      env: ENV,
      now: AT,
    });

    expect(outcome).toMatchObject({ reason: 'not_public_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
    // The connection still stands. The URL was the problem, not the person.
    expect(fake.tables.portrait_connections).toHaveLength(1);
  });

  it('treats a refused download as nothing to file', async () => {
    const fake = fakeSupabase();
    const outcome = await capturePortraitFromProvider({
      connectionId: CONNECTION,
      profile: profileOf(),
      previewId: PREVIEW,
      workspaceId: null,
      fetchImpl: serving(png(400, 400), { ok: false }),
      supabase: fake.client as never,
      env: ENV,
      now: AT,
    });
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'unreadable' });
  });

  it('never throws when the CDN drops the connection', async () => {
    // A socket hang up on a provider's CDN is a preview that looks less like
    // the client. It is not a funnel that stops working.
    const fake = fakeSupabase();
    const thrower = vi.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: thrower,
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toMatchObject({ status: 'skipped', reason: 'unreadable' });
  });

  it('refuses a body the provider says is over the cap', async () => {
    // The header is checked before the body is read, so a CDN that announces
    // a hundred megabytes never gets to send them.
    const fake = fakeSupabase();
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: serving(png(400, 400), { contentLength: '99000000' }),
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toMatchObject({ reason: 'too_large' });
  });

  it('refuses a body that turns out to be over the cap', async () => {
    // A content-length header is a claim. The bytes are the fact, and the cap
    // is read from the environment rather than written into the rule.
    const fake = fakeSupabase();
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: serving(png(400, 400)),
        supabase: fake.client as never,
        env: { FLOWSTARTER_PORTRAIT_MAX_BYTES: '16' },
        now: AT,
      })
    ).toMatchObject({ reason: 'too_large' });
  });

  it('refuses bytes that are not an image, whatever the CDN said', async () => {
    // A provider's CDN is not a trusted source of image bytes, and a
    // content-type header is a claim rather than a fact.
    const fake = fakeSupabase();
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: serving(Buffer.from('<svg onload=alert(1)></svg>')),
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toMatchObject({ status: 'skipped', reason: 'not_an_image' });
    expect(storeFunnelAsset).not.toHaveBeenCalled();
  });

  it('files nothing it could not measure', async () => {
    // We do not place what we have not measured, and a picture with no
    // dimensions cannot be shown to clear any floor. The connection stands;
    // the file does not.
    const fake = fakeSupabase();
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: serving(WEBP_UNMEASURABLE),
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toMatchObject({ reason: 'below_avatar_floor' });
    expect(storeFunnelAsset).not.toHaveBeenCalled();
    expect(fake.tables.portrait_connections).toHaveLength(1);
  });

  it("files Instagram's hundred-pixel portrait as an avatar and nothing more", async () => {
    // This is the case the whole feature turns on. Instagram's public picture
    // is 100 square: too small for a hero, real enough for a byline. It is
    // filed with the avatar role only, so nothing downstream can upscale it
    // into a slot it was never big enough for.
    const fake = fakeSupabase();
    const outcome = await capturePortraitFromProvider({
      connectionId: CONNECTION,
      profile: profileOf({
        provider: 'instagram',
        accountType: 'creator',
        pictureUrl: 'https://scontent.cdninstagram.example/p100.png',
      }),
      previewId: PREVIEW,
      workspaceId: null,
      fetchImpl: serving(png(100, 100)),
      supabase: fake.client as never,
      env: ENV,
      now: AT,
    });

    expect(outcome).toMatchObject({
      status: 'captured',
      portrait: {
        connectionId: CONNECTION,
        funnelAssetId: 'funnel-asset-1',
        assetId: null,
        width: 100,
        height: 100,
        verdict: 'avatar',
        placements: ['avatar'],
      },
    });
    expect(storeFunnelAsset.mock.calls[0]?.[0]).toMatchObject({
      previewId: PREVIEW,
      kind: 'photo',
      source: 'instagram',
      usableFor: ['avatar'],
    });
  });

  it('files a full-size portrait as placeable, and records where it came from', async () => {
    // Above the portrait floor the picture may carry the about section, and
    // the provenance travels with it: a picture we downloaded is not a file
    // the client sent, and in six months the row is the only thing that can
    // tell them apart.
    const fake = fakeSupabase();
    const outcome = await capturePortraitFromProvider({
      connectionId: CONNECTION,
      profile: profileOf(),
      previewId: PREVIEW,
      workspaceId: null,
      fetchImpl: serving(png(1000, 1000)),
      supabase: fake.client as never,
      env: ENV,
      now: AT,
    });

    expect(outcome).toMatchObject({
      status: 'captured',
      portrait: {
        verdict: 'portrait',
        placements: ['hero', 'about', 'avatar'],
        width: 1000,
        height: 1000,
      },
    });
    expect(storeFunnelAsset.mock.calls[0]?.[0]).toMatchObject({
      usableFor: ['section', 'portrait'],
      provenance: {
        sourceUrl: 'https://media.licdn.example/portrait.png',
        fetchedAt: FETCHED_AT,
      },
    });
  });

  it('files it with the rights already confirmed, because connecting IS the consent', async () => {
    // The opposite of `profile-picture.ts`, deliberately. Reading somebody's
    // OpenGraph tag is not consent and is filed with nothing. A person who
    // went to LinkedIn, saw what we were asking for and approved it has
    // already answered the question the brief would ask them again.
    const fake = fakeSupabase();
    await capturePortraitFromProvider({
      connectionId: CONNECTION,
      profile: profileOf(),
      previewId: PREVIEW,
      workspaceId: null,
      fetchImpl: serving(png(1000, 1000)),
      supabase: fake.client as never,
      env: ENV,
      now: AT,
    });

    expect(storeFunnelAsset.mock.calls[0]?.[0]).toMatchObject({
      rights: {
        confirmed: true,
        statementVersion: CURRENT_RIGHTS_STATEMENT_VERSION,
        ip: null,
        userAgent: null,
      },
    });
    expect(fake.tables.portrait_connections?.[0]).toMatchObject({
      funnel_asset_id: 'funnel-asset-1',
      asset_id: null,
      picture_width: 1000,
      picture_height: 1000,
      fetched_at: FETCHED_AT,
      rights_confirmed_at: FETCHED_AT,
      rights_statement_version: CURRENT_RIGHTS_STATEMENT_VERSION,
    });
  });

  it("writes a claimed workspace's portrait inside that workspace's own prefix", async () => {
    // Once there is a workspace the picture is a tenant asset, and a tenant
    // asset lives under tenant/{workspaceId}/ or it does not get written at
    // all. Selected and rights-confirmed, so the generator can actually use
    // the face the client authorised.
    const fake = fakeSupabase();
    const outcome = await capturePortraitFromProvider({
      connectionId: CONNECTION,
      profile: profileOf(),
      previewId: null,
      workspaceId: WORKSPACE,
      fetchImpl: serving(png(1000, 1000)),
      supabase: fake.client as never,
      env: ENV,
      now: AT,
    });

    expect(outcome).toMatchObject({
      status: 'captured',
      portrait: { assetId: 'assets-2', funnelAssetId: null },
    });
    expect(storeFunnelAsset).not.toHaveBeenCalled();
    expect(fake.uploads[0]?.bucket).toBe('tenant-assets');
    expect(
      fake.uploads[0]?.path.startsWith(`tenant/${WORKSPACE}/assets/`)
    ).toBe(true);
    expect(fake.uploads[0]?.contentType).toBe('image/png');
    expect(fake.tables.assets?.[0]).toMatchObject({
      workspace_id: WORKSPACE,
      source: 'linkedin',
      kind: 'portrait',
      mime: 'image/png',
      width: 1000,
      height: 1000,
      usable_for: ['section', 'portrait'],
      source_url: 'https://media.licdn.example/portrait.png',
      fetched_at: FETCHED_AT,
      rights_confirmed_at: FETCHED_AT,
      selected: true,
    });
  });

  it('adopts the picture a workspace already holds rather than duplicating it', async () => {
    // `assets` is unique on (workspace_id, sha256). A second connect of the
    // same account is the same photograph, and one file deserves one row.
    const fake = fakeSupabase({
      assets: [
        {
          id: 'asset-existing',
          workspace_id: WORKSPACE,
          // The lookup is content addressed, so the digest is what makes this
          // row the same photograph rather than merely another one.
          sha256: createHash('sha256').update(png(1000, 1000)).digest('hex'),
        },
      ],
    });
    fake.fail({
      table: 'assets',
      mode: 'insert',
      error: { code: '23505', message: 'duplicate key' },
    });

    const outcome = await capturePortraitFromProvider({
      connectionId: CONNECTION,
      profile: profileOf(),
      previewId: null,
      workspaceId: WORKSPACE,
      fetchImpl: serving(png(1000, 1000)),
      supabase: fake.client as never,
      env: ENV,
      now: AT,
    });

    expect(outcome).toMatchObject({
      status: 'captured',
      portrait: { assetId: 'asset-existing' },
    });
    expect(fake.tables.assets).toHaveLength(1);
  });

  it('degrades to a skip when the bucket will not take the object', async () => {
    const fake = fakeSupabase();
    fake.failUpload('bucket unavailable');
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: null,
        workspaceId: WORKSPACE,
        fetchImpl: serving(png(1000, 1000)),
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toEqual({ status: 'skipped', reason: 'store_failed' });
  });

  it('degrades to a skip when the funnel asset cannot be filed', async () => {
    storeFunnelAsset.mockRejectedValue(new Error('storage down'));
    const fake = fakeSupabase();
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: serving(png(1000, 1000)),
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toEqual({ status: 'skipped', reason: 'store_failed' });
  });

  it('degrades to a skip when the connection itself cannot be written', async () => {
    const fake = fakeSupabase();
    fake.fail({
      table: 'portrait_connections',
      mode: 'select',
      error: { message: 'connection lookup failed' },
    });
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: serving(png(1000, 1000)),
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toEqual({ status: 'skipped', reason: 'store_failed' });
  });

  it('updates the row a reconnect belongs to instead of adding a second', async () => {
    // A person who connects twice is one person. Two rows disagreeing about
    // them is a table nobody can read an answer out of.
    const fake = fakeSupabase({
      portrait_connections: [
        {
          id: 'connection-existing',
          provider: 'linkedin',
          provider_account_id: 'sub-9f31',
          preview_id: PREVIEW,
          display_name: 'An older name',
        },
      ],
    });

    const outcome = await capturePortraitFromProvider({
      connectionId: CONNECTION,
      profile: profileOf(),
      previewId: PREVIEW,
      workspaceId: null,
      fetchImpl: serving(png(1000, 1000)),
      supabase: fake.client as never,
      env: ENV,
      now: AT,
    });

    expect(outcome).toMatchObject({
      status: 'captured',
      portrait: { connectionId: 'connection-existing' },
    });
    expect(fake.tables.portrait_connections).toHaveLength(1);
    expect(fake.tables.portrait_connections?.[0]).toMatchObject({
      display_name: 'Darius Popescu',
    });
  });

  it('re-reads the row when two callbacks race for it', async () => {
    // Two tabs, or a provider that delivered the callback twice. The partial
    // unique index is what settles it, and the loser adopts the winner's row
    // rather than failing a person who did nothing wrong.
    const fake = fakeSupabase();
    fake.fail({
      table: 'portrait_connections',
      mode: 'insert',
      error: { code: '23505', message: 'duplicate key' },
      seed: [
        {
          id: 'connection-raced',
          provider: 'linkedin',
          provider_account_id: 'sub-9f31',
          preview_id: PREVIEW,
        },
      ],
    });

    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: serving(png(1000, 1000)),
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toMatchObject({
      status: 'captured',
      portrait: { connectionId: 'connection-raced' },
    });
    expect(fake.tables.portrait_connections).toHaveLength(1);
  });

  it('gives up on a provider that never answers', async () => {
    // The timeout is the budget from portrait-config.ts, not a number written
    // into the rule. A CDN that holds the socket open must not hold the whole
    // callback open with it.
    const fake = fakeSupabase();
    const hanging = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        })
    ) as unknown as typeof fetch;

    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: hanging,
        supabase: fake.client as never,
        env: { FLOWSTARTER_PORTRAIT_PROVIDER_TIMEOUT_MS: '1' },
        now: AT,
      })
    ).toEqual({ status: 'skipped', reason: 'unreadable' });
  });

  it('skips rather than throws when the connection insert fails outright', async () => {
    // Anything that is not the unique violation is a database problem, and a
    // database problem is still not a reason to hand a person mid-flow a
    // stack trace instead of their preview.
    const fake = fakeSupabase();
    fake.fail({
      table: 'portrait_connections',
      mode: 'insert',
      error: { code: '42501', message: 'permission denied' },
    });
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: serving(png(1000, 1000)),
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toEqual({ status: 'skipped', reason: 'store_failed' });
  });

  it('skips rather than throws when the asset insert fails outright', async () => {
    // Only 23505 means "the workspace already has this file". Every other
    // code means we do not know what happened, and adopting a row on that
    // basis would be a guess about somebody's photograph.
    const fake = fakeSupabase();
    fake.fail({
      table: 'assets',
      mode: 'insert',
      error: { code: '23503', message: 'foreign key violation' },
    });
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: null,
        workspaceId: WORKSPACE,
        fetchImpl: serving(png(1000, 1000)),
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toEqual({ status: 'skipped', reason: 'store_failed' });
  });

  it('skips when a raced insert leaves no row to adopt', async () => {
    // A unique violation with nothing behind it is a database we cannot
    // explain. It is still not worth throwing at a person mid-flow.
    const fake = fakeSupabase();
    fake.fail({
      table: 'portrait_connections',
      mode: 'insert',
      error: { code: '23505', message: 'duplicate key' },
    });
    expect(
      await capturePortraitFromProvider({
        connectionId: CONNECTION,
        profile: profileOf(),
        previewId: PREVIEW,
        workspaceId: null,
        fetchImpl: serving(png(1000, 1000)),
        supabase: fake.client as never,
        env: ENV,
        now: AT,
      })
    ).toEqual({ status: 'skipped', reason: 'store_failed' });
  });

  it('keys a connection by its own id when it belongs to neither half yet', async () => {
    // A connect flow started before there is a preview row still has to leave
    // exactly one connection behind, addressed by the id the signed state
    // minted for it.
    const fake = fakeSupabase();
    const outcome = await capturePortraitFromProvider({
      connectionId: CONNECTION,
      profile: profileOf(),
      previewId: null,
      workspaceId: null,
      fetchImpl: serving(png(1000, 1000)),
      supabase: fake.client as never,
      env: ENV,
      now: AT,
    });

    expect(outcome).toMatchObject({
      status: 'captured',
      portrait: { funnelAssetId: null, assetId: null, verdict: 'portrait' },
    });
    expect(fake.tables.portrait_connections?.[0]).toMatchObject({
      id: CONNECTION,
      preview_id: null,
      workspace_id: null,
      rights_confirmed_at: FETCHED_AT,
    });
  });
});

describe('loadPortraitConnections', () => {
  it('answers with nothing when it is asked about neither half', async () => {
    expect(await loadPortraitConnections({})).toEqual([]);
  });

  it("reads a preview's connections back for the intake", async () => {
    const fake = fakeSupabase({
      portrait_connections: [
        {
          id: 'connection-1',
          provider: 'instagram',
          preview_id: PREVIEW,
          display_name: 'Darius Popescu',
          headline: null,
          picture_width: 100,
          picture_height: 100,
          rights_confirmed_at: FETCHED_AT,
          funnel_asset_id: 'funnel-asset-1',
          asset_id: null,
        },
        {
          id: 'connection-2',
          provider: 'linkedin',
          preview_id: 'another-preview',
          display_name: 'Somebody Else',
          headline: 'Not this preview',
          picture_width: null,
          picture_height: null,
          rights_confirmed_at: null,
          funnel_asset_id: null,
          asset_id: null,
        },
      ],
    });

    expect(
      await loadPortraitConnections({
        previewId: PREVIEW,
        supabase: fake.client as never,
      })
    ).toEqual([
      {
        id: 'connection-1',
        provider: 'instagram',
        displayName: 'Darius Popescu',
        headline: null,
        width: 100,
        height: 100,
        rightsConfirmedAt: FETCHED_AT,
        funnelAssetId: 'funnel-asset-1',
        assetId: null,
      },
    ]);
  });

  it("reads a workspace's connections back for the brief", async () => {
    const fake = fakeSupabase({
      portrait_connections: [
        {
          id: 'connection-3',
          provider: 'linkedin',
          workspace_id: WORKSPACE,
          display_name: null,
          headline: 'Builds funnels that book work',
          picture_width: 1000,
          picture_height: 1000,
          rights_confirmed_at: FETCHED_AT,
          funnel_asset_id: null,
          asset_id: 'asset-1',
        },
      ],
    });

    expect(
      await loadPortraitConnections({
        workspaceId: WORKSPACE,
        supabase: fake.client as never,
      })
    ).toMatchObject([{ provider: 'linkedin', assetId: 'asset-1' }]);
  });

  it('answers with an empty list when the read fails', async () => {
    // A connection we cannot read is a page with one fewer thing on it. The
    // intake still has a form to render.
    const fake = fakeSupabase();
    fake.fail({
      table: 'portrait_connections',
      mode: 'select',
      error: { message: 'unavailable' },
    });
    expect(
      await loadPortraitConnections({
        previewId: PREVIEW,
        supabase: fake.client as never,
      })
    ).toEqual([]);
  });
});
