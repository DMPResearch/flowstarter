import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ChangeRequestAsset,
  TemplateScaffoldFile,
} from '@flowstarter/agentic-codegen';
import {
  ChangeRequestAssetError,
  isTenantAssetPath,
  loadChangeRequestAssetFiles,
  withChangeRequestAssets,
} from '../src/change-request-assets';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const OTHER_WORKSPACE = 'c009105e-f8ec-42bf-bdcf-cf92bb500f45';
const ASSET_ID = 'b104b1e0-6d4c-4a3e-9230-13cc17b426a0';

/** A real 1x1 PNG, so `assertSafeUploadedImage` has honest bytes to read. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A 400x400 PNG header, above the 200px minimum edge the verifier demands. */
function pngOf(width: number, height: number): Buffer {
  const header = Buffer.from(PNG_1X1);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function asset(
  overrides: Partial<ChangeRequestAsset> = {},
): ChangeRequestAsset {
  return {
    assetId: ASSET_ID,
    publicPath: '/flowstarter-media/cr-b104b1e0.png',
    manifestPath: 'public/flowstarter-media/cr-b104b1e0.png',
    caption: 'The client dashboard',
    mime: 'image/png',
    width: 400,
    height: 400,
    ...overrides,
  };
}

/**
 * The narrowest Supabase stand-in that answers what this module asks: one
 * `assets` select filtered by `withTenant`, and one storage download.
 */
function fakeClient(options: {
  rows?: Array<Record<string, unknown>>;
  bytes?: Buffer | null;
  filters?: Array<[string, unknown]>;
}): SupabaseClient {
  const filters = options.filters ?? [];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    in: (column: string, value: unknown) => {
      filters.push([column, value]);
      return Promise.resolve({ data: options.rows ?? [], error: null });
    },
  };
  return {
    from: () => builder,
    storage: {
      from: () => ({
        download: async () =>
          options.bytes
            ? {
                data: {
                  arrayBuffer: async () =>
                    options.bytes!.buffer.slice(
                      options.bytes!.byteOffset,
                      options.bytes!.byteOffset + options.bytes!.byteLength,
                    ),
                },
                error: null,
              }
            : { data: null, error: { message: 'not found' } },
      }),
    },
  } as unknown as SupabaseClient;
}

describe('isTenantAssetPath', () => {
  it('accepts this workspace and refuses everything else', () => {
    expect(
      isTenantAssetPath(`tenant/${WORKSPACE_ID}/assets/abc.png`, WORKSPACE_ID),
    ).toBe(true);
    // Case is not a way in either: the upload path is lower-cased on write.
    expect(
      isTenantAssetPath(
        `tenant/${WORKSPACE_ID.toUpperCase()}/assets/abc.png`,
        WORKSPACE_ID,
      ),
    ).toBe(true);
  });

  it('refuses another tenant, traversal and an absolute path', () => {
    expect(
      isTenantAssetPath(
        `tenant/${OTHER_WORKSPACE}/assets/abc.png`,
        WORKSPACE_ID,
      ),
    ).toBe(false);
    expect(
      isTenantAssetPath(
        `tenant/${WORKSPACE_ID}/../../etc/passwd`,
        WORKSPACE_ID,
      ),
    ).toBe(false);
    expect(
      isTenantAssetPath(`/tenant/${WORKSPACE_ID}/assets/abc.png`, WORKSPACE_ID),
    ).toBe(false);
  });
});

describe('loadChangeRequestAssetFiles', () => {
  it('downloads a rights-confirmed picture as a base64 manifest file', async () => {
    const filters: Array<[string, unknown]> = [];
    const files = await loadChangeRequestAssetFiles({
      client: fakeClient({
        rows: [
          {
            id: ASSET_ID,
            storage_path: `tenant/${WORKSPACE_ID}/assets/abc.png`,
            rights_confirmed_at: '2026-09-12T09:08:06.953Z',
          },
        ],
        bytes: pngOf(400, 400),
        filters,
      }),
      workspaceId: WORKSPACE_ID,
      assets: [asset()],
    });

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('public/flowstarter-media/cr-b104b1e0.png');
    expect(files[0]?.encoding).toBe('base64');
    // The tenant filter is structural, not remembered: `withTenant` puts it on.
    expect(filters).toContainEqual(['workspace_id', WORKSPACE_ID]);
  });

  it('does nothing at all when the request carries no pictures', async () => {
    expect(
      await loadChangeRequestAssetFiles({
        client: fakeClient({}),
        workspaceId: WORKSPACE_ID,
        assets: [],
      }),
    ).toEqual([]);
  });

  it('refuses to publish a picture whose rights were withdrawn', async () => {
    // Rights are a statement a client makes and can take back, and the build
    // is the last moment before those bytes are on a public website.
    await expect(
      loadChangeRequestAssetFiles({
        client: fakeClient({
          rows: [
            {
              id: ASSET_ID,
              storage_path: `tenant/${WORKSPACE_ID}/assets/abc.png`,
              rights_confirmed_at: null,
            },
          ],
          bytes: pngOf(400, 400),
        }),
        workspaceId: WORKSPACE_ID,
        assets: [asset()],
      }),
    ).rejects.toThrow(ChangeRequestAssetError);
  });

  it('refuses a row whose stored path points outside this workspace', async () => {
    await expect(
      loadChangeRequestAssetFiles({
        client: fakeClient({
          rows: [
            {
              id: ASSET_ID,
              storage_path: `tenant/${OTHER_WORKSPACE}/assets/abc.png`,
              rights_confirmed_at: '2026-09-12T09:08:06.953Z',
            },
          ],
          bytes: pngOf(400, 400),
        }),
        workspaceId: WORKSPACE_ID,
        assets: [asset()],
      }),
    ).rejects.toThrow(/no stored copy inside this workspace/);
  });

  it('fails loudly for an asset that is no longer in the library', async () => {
    await expect(
      loadChangeRequestAssetFiles({
        client: fakeClient({ rows: [] }),
        workspaceId: WORKSPACE_ID,
        assets: [asset()],
      }),
    ).rejects.toThrow(/no longer in this workspace's library/);
  });

  it('refuses bytes that are not an image, whatever the row says', async () => {
    await expect(
      loadChangeRequestAssetFiles({
        client: fakeClient({
          rows: [
            {
              id: ASSET_ID,
              storage_path: `tenant/${WORKSPACE_ID}/assets/abc.png`,
              rights_confirmed_at: '2026-09-12T09:08:06.953Z',
            },
          ],
          bytes: Buffer.from('<svg onload="alert(1)"></svg>'),
        }),
        workspaceId: WORKSPACE_ID,
        assets: [asset()],
      }),
    ).rejects.toThrow(/not a PNG, JPEG, GIF or WebP/);
  });
});

describe('withChangeRequestAssets', () => {
  const seed: TemplateScaffoldFile[] = [
    { path: 'src/content/site.md', content: 'copy', type: 'file' },
  ];
  const picture: TemplateScaffoldFile = {
    path: 'public/flowstarter-media/cr-b104b1e0.png',
    content: 'AAAA',
    encoding: 'base64',
    type: 'file',
  };

  it('appends the pictures to the seed', () => {
    const merged = withChangeRequestAssets(seed, [picture]);
    expect(merged.map((file) => file.path)).toEqual([
      'src/content/site.md',
      'public/flowstarter-media/cr-b104b1e0.png',
    ]);
  });

  it('replaces rather than duplicates a path already in the manifest', () => {
    // `materializeScaffold` writes with `wx`, so a duplicate path would fail
    // the build on a filesystem error rather than on anything meaningful.
    const already = [...seed, { ...picture, content: 'OLD' }];
    const merged = withChangeRequestAssets(already, [picture]);
    expect(merged).toHaveLength(2);
    expect(
      merged.find(
        (file) => file.path === 'public/flowstarter-media/cr-b104b1e0.png',
      )?.content,
    ).toBe('AAAA');
  });

  it('leaves the seed untouched when there is nothing to add', () => {
    expect(withChangeRequestAssets(seed, [])).toEqual(seed);
  });
});
