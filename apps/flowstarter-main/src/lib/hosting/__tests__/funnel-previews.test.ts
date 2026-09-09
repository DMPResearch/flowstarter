/**
 * The durable record behind an anonymous funnel preview.
 *
 * Two properties are worth more than the rest of this file put together:
 *
 *  - nothing here throws at the caller. A preview that could not be persisted
 *    must not cost the visitor the preview they are looking at, so every
 *    failure — a Postgrest error, a client that throws outright, Storage that
 *    is not even wired — has to come back as null/false and a warning, never
 *    as an exception unwinding a generation that ran for minutes;
 *  - the reaper's delete refuses anything outside `funnel/`. A claimed
 *    preview's artifact sits under `tenant/{workspaceId}/` and belongs to the
 *    client who paid for it; "reclaim what nobody owns" must not be one typo
 *    away from deleting somebody's build.
 *
 * Static imports: vi.mock is hoisted above them, and the app's tsconfig does
 * not allow top-level await in tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostingSupabase, type Row } from './fake-hosting-supabase';

vi.mock('server-only', () => ({}));

const db = createFakeHostingSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

import {
  CLAIMED_PREVIEW_TTL_MS,
  PREVIEW_TTL_MS,
  claimFunnelPreview,
  copyFunnelArtifactToTenant,
  deleteFunnelPreviewArtifact,
  isExpired,
  listExpiredFunnelPreviews,
  loadFunnelPreview,
  manifestSafeForJson,
  markFunnelPreviewDeployment,
  readGuestIntakeChat,
  saveFunnelPreview,
  signFunnelPreviewArtifact,
  stashGuestIntakeChat,
  uploadFunnelPreviewArtifact,
} from '../funnel-previews';

const PREVIEW_ID = 'a1b2c3d4-1111-4111-8111-111111111111';
const OTHER_PREVIEW_ID = 'a1b2c3d4-1111-4111-8111-111111111112';
const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const NOT_A_UUID = 'preview-1';

const FUNNEL_PATH = `funnel/${PREVIEW_ID}/site.tar.gz`;
const TENANT_PATH = `tenant/${WORKSPACE_ID}/previews/${PREVIEW_ID}/site.tar.gz`;

function row(overrides: Row = {}): Row {
  return {
    preview_id: PREVIEW_ID,
    template_slug: 'wellness-therapy',
    template_version: '1.2.0',
    brand_config: { primary: '#123456' },
    manifest: { files: [{ path: 'index.html', content: '<h1>hi</h1>' }] },
    artifact_path: FUNNEL_PATH,
    hostname: 'p-0123456789abcdef.preview.flowstarter.net',
    deploy_status: 'live',
    deployment_error: null,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    claimed_workspace_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** A client that blows up rather than answering — the `catch` arms. */
const throwingClient = {
  from() {
    throw new Error('connection reset by peer');
  },
  storage: {
    from() {
      return {
        upload() {
          throw new Error('storage exploded');
        },
        download() {
          throw new Error('storage exploded');
        },
        remove() {
          throw new Error('storage exploded');
        },
        createSignedUrl() {
          throw new Error('storage exploded');
        },
      };
    },
  },
} as never;

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.reset();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('manifestSafeForJson', () => {
  it('re-encodes a file whose content carries NUL as base64 and leaves the rest alone', () => {
    const nul = 'ab\u0000cd';
    const { value, reencoded } = manifestSafeForJson({
      files: [
        { path: 'public/images/x.jpg', content: nul, type: 'file' },
        { path: 'src/content/site.md', content: 'hello', type: 'file' },
      ],
      note: 'plain',
    });
    expect(reencoded).toEqual(['public/images/x.jpg']);
    const files = (
      value as {
        files: Array<{ path: string; content: string; encoding?: string }>;
      }
    ).files;
    expect(files[0].encoding).toBe('base64');
    expect(Buffer.from(files[0].content, 'base64').toString('utf8')).toBe(nul);
    expect(files[1]).toEqual({
      path: 'src/content/site.md',
      content: 'hello',
      type: 'file',
    });
    expect(JSON.stringify(value).includes('\\u0000')).toBe(false);
  });

  it('strips NUL out of a bare string that is not a file entry', () => {
    const { value, reencoded } = manifestSafeForJson({
      businessName: 'Ionescu\u0000 Dental',
      nested: { note: 'a\u0000b' },
    });
    // Nothing was a {path, content} pair, so nothing is reported as re-encoded
    // — the NUL is simply gone, and jsonb will accept the row.
    expect(reencoded).toEqual([]);
    expect(value).toEqual({
      businessName: 'Ionescu Dental',
      nested: { note: 'ab' },
    });
  });
});

describe('saveFunnelPreview', () => {
  it('refuses an id that is not a uuid without touching the database', async () => {
    expect(
      await saveFunnelPreview({
        previewId: NOT_A_UUID,
        supabase: db.client as never,
      })
    ).toBe(false);
    expect(db.rows('funnel_previews')).toHaveLength(0);
  });

  it('writes the row with a seven day TTL and no claim', async () => {
    const before = Date.now();
    expect(
      await saveFunnelPreview({
        previewId: PREVIEW_ID,
        templateSlug: 'wellness-therapy',
        templateVersion: '1.2.0',
        brandConfig: { primary: '#123456' },
        manifest: { files: [] },
        artifactPath: FUNNEL_PATH,
        supabase: db.client as never,
      })
    ).toBe(true);

    const saved = db.rows('funnel_previews')[0]!;
    expect(saved).toMatchObject({
      preview_id: PREVIEW_ID,
      template_slug: 'wellness-therapy',
      template_version: '1.2.0',
      artifact_path: FUNNEL_PATH,
    });
    const ttl = Date.parse(saved.expires_at as string) - before;
    expect(ttl).toBeGreaterThan(PREVIEW_TTL_MS - 10_000);
    expect(ttl).toBeLessThanOrEqual(PREVIEW_TTL_MS + 10_000);
    // A regenerated preview must never un-claim one somebody already owns.
    expect(saved).not.toHaveProperty('claimed_workspace_id');
  });

  it('overwrites its own row rather than forking a second one', async () => {
    await saveFunnelPreview({
      previewId: PREVIEW_ID,
      templateSlug: 'first',
      supabase: db.client as never,
    });
    await saveFunnelPreview({
      previewId: PREVIEW_ID,
      templateSlug: 'second',
      supabase: db.client as never,
    });
    expect(db.rows('funnel_previews')).toHaveLength(1);
    expect(db.rows('funnel_previews')[0]!.template_slug).toBe('second');
  });

  it('honours an explicit expiry', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');
    await saveFunnelPreview({
      previewId: PREVIEW_ID,
      expiresAt,
      supabase: db.client as never,
    });
    expect(db.rows('funnel_previews')[0]!.expires_at).toBe(
      expiresAt.toISOString()
    );
  });

  it('re-encodes a NUL-bearing manifest and says so, rather than losing the row', async () => {
    expect(
      await saveFunnelPreview({
        previewId: PREVIEW_ID,
        manifest: {
          files: [{ path: 'public/logo.png', content: '\u0000PNG' }],
        },
        supabase: db.client as never,
      })
    ).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('re-encoded 1 manifest file(s)')
    );
    const manifest = db.rows('funnel_previews')[0]!.manifest as {
      files: Array<{ encoding?: string }>;
    };
    expect(manifest.files[0].encoding).toBe('base64');
  });

  it('degrades to false on a Postgrest error', async () => {
    db.failing.add('funnel_previews');
    expect(
      await saveFunnelPreview({
        previewId: PREVIEW_ID,
        supabase: db.client as never,
      })
    ).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not persist preview')
    );
  });

  it('degrades to false when the client throws outright', async () => {
    expect(
      await saveFunnelPreview({
        previewId: PREVIEW_ID,
        supabase: throwingClient,
      })
    ).toBe(false);
  });

  it('falls back to the service-role client when no client is handed in', async () => {
    expect(await saveFunnelPreview({ previewId: PREVIEW_ID })).toBe(true);
    expect(db.rows('funnel_previews')).toHaveLength(1);
  });
});

describe('loadFunnelPreview', () => {
  it('refuses an id that is not a uuid', async () => {
    expect(
      await loadFunnelPreview(NOT_A_UUID, { supabase: db.client as never })
    ).toBeNull();
  });

  it('returns null when there is no row', async () => {
    expect(
      await loadFunnelPreview(PREVIEW_ID, { supabase: db.client as never })
    ).toBeNull();
  });

  it('maps the row into camelCase', async () => {
    db.seed('funnel_previews', [row()]);
    const loaded = await loadFunnelPreview(PREVIEW_ID, {
      supabase: db.client as never,
    });
    expect(loaded).toMatchObject({
      previewId: PREVIEW_ID,
      templateSlug: 'wellness-therapy',
      templateVersion: '1.2.0',
      artifactPath: FUNNEL_PATH,
      deployStatus: 'live',
      claimedWorkspaceId: null,
    });
  });

  it('defaults a missing deploy status to pending', async () => {
    db.seed('funnel_previews', [row({ deploy_status: null })]);
    const loaded = await loadFunnelPreview(PREVIEW_ID, {
      supabase: db.client as never,
    });
    expect(loaded?.deployStatus).toBe('pending');
  });

  it('hides an expired preview, because the site behind it is gone', async () => {
    db.seed('funnel_previews', [
      row({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
    ]);
    expect(
      await loadFunnelPreview(PREVIEW_ID, { supabase: db.client as never })
    ).toBeNull();
    const forced = await loadFunnelPreview(PREVIEW_ID, {
      includeExpired: true,
      supabase: db.client as never,
    });
    expect(forced?.previewId).toBe(PREVIEW_ID);
  });

  it('still returns an expired preview once it is claimed', async () => {
    db.seed('funnel_previews', [
      row({
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        claimed_workspace_id: WORKSPACE_ID,
      }),
    ]);
    const loaded = await loadFunnelPreview(PREVIEW_ID, {
      supabase: db.client as never,
    });
    expect(loaded?.claimedWorkspaceId).toBe(WORKSPACE_ID);
  });

  it('degrades to null on a Postgrest error', async () => {
    db.failing.add('funnel_previews');
    expect(
      await loadFunnelPreview(PREVIEW_ID, { supabase: db.client as never })
    ).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not read preview')
    );
  });

  it('degrades to null when the client throws outright', async () => {
    expect(
      await loadFunnelPreview(PREVIEW_ID, { supabase: throwingClient })
    ).toBeNull();
  });
});

describe('isExpired', () => {
  const base = {
    previewId: PREVIEW_ID,
    templateSlug: null,
    templateVersion: null,
    brandConfig: {},
    manifest: {},
    artifactPath: null,
    hostname: null,
    deployStatus: 'live' as const,
    deploymentError: null,
    claimedWorkspaceId: null,
    createdAt: '',
    updatedAt: '',
  };

  it('a claim un-expires a preview', () => {
    expect(
      isExpired({
        ...base,
        expiresAt: new Date(0).toISOString(),
        claimedWorkspaceId: WORKSPACE_ID,
      })
    ).toBe(false);
  });

  it('an unparseable expiry is never treated as expired', () => {
    expect(isExpired({ ...base, expiresAt: 'not a date' })).toBe(false);
  });

  it('the boundary counts as expired', () => {
    const at = Date.now();
    expect(
      isExpired({ ...base, expiresAt: new Date(at).toISOString() }, at)
    ).toBe(true);
  });
});

describe('markFunnelPreviewDeployment', () => {
  it('refuses an id that is not a uuid', async () => {
    expect(
      await markFunnelPreviewDeployment({
        previewId: NOT_A_UUID,
        status: 'live',
        supabase: db.client as never,
      })
    ).toBe(false);
  });

  it('records the hostname, status and error the agent came back with', async () => {
    db.seed('funnel_previews', [row({ deploy_status: 'pending' })]);
    expect(
      await markFunnelPreviewDeployment({
        previewId: PREVIEW_ID,
        hostname: 'p-000000000000beef.preview.flowstarter.net',
        status: 'failed',
        error: 'deploy-agent 500',
        supabase: db.client as never,
      })
    ).toBe(true);
    expect(db.rows('funnel_previews')[0]).toMatchObject({
      hostname: 'p-000000000000beef.preview.flowstarter.net',
      deploy_status: 'failed',
      deployment_error: 'deploy-agent 500',
    });
  });

  it('leaves the hostname alone when the caller does not pass one', async () => {
    db.seed('funnel_previews', [row()]);
    await markFunnelPreviewDeployment({
      previewId: PREVIEW_ID,
      status: 'removed',
      supabase: db.client as never,
    });
    expect(db.rows('funnel_previews')[0]).toMatchObject({
      hostname: 'p-0123456789abcdef.preview.flowstarter.net',
      deploy_status: 'removed',
      deployment_error: null,
    });
  });

  it('degrades to false on a Postgrest error and when the client throws', async () => {
    db.failing.add('funnel_previews');
    expect(
      await markFunnelPreviewDeployment({
        previewId: PREVIEW_ID,
        status: 'live',
        supabase: db.client as never,
      })
    ).toBe(false);
    expect(
      await markFunnelPreviewDeployment({
        previewId: PREVIEW_ID,
        status: 'live',
        supabase: throwingClient,
      })
    ).toBe(false);
  });
});

describe('claimFunnelPreview', () => {
  it('has nothing to claim when the preview expired', async () => {
    db.seed('funnel_previews', [
      row({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
    ]);
    expect(
      await claimFunnelPreview({
        previewId: PREVIEW_ID,
        workspaceId: WORKSPACE_ID,
        supabase: db.client as never,
      })
    ).toBeNull();
    expect(db.rows('funnel_previews')[0]!.claimed_workspace_id).toBeNull();
  });

  it('returns the row as it was before the claim and pushes the TTL out', async () => {
    db.seed('funnel_previews', [row()]);
    const before = Date.now();
    const adopted = await claimFunnelPreview({
      previewId: PREVIEW_ID,
      workspaceId: WORKSPACE_ID,
      supabase: db.client as never,
    });
    // The caller needs to know where the artifact was, so the pre-claim row is
    // what comes back — not the row it just wrote.
    expect(adopted?.claimedWorkspaceId).toBeNull();
    expect(adopted?.artifactPath).toBe(FUNNEL_PATH);

    const stored = db.rows('funnel_previews')[0]!;
    expect(stored.claimed_workspace_id).toBe(WORKSPACE_ID);
    const ttl = Date.parse(stored.expires_at as string) - before;
    expect(ttl).toBeGreaterThan(CLAIMED_PREVIEW_TTL_MS - 10_000);
  });

  it('honours a caller-supplied TTL', async () => {
    db.seed('funnel_previews', [row()]);
    const before = Date.now();
    await claimFunnelPreview({
      previewId: PREVIEW_ID,
      workspaceId: WORKSPACE_ID,
      ttlMs: 60_000,
      supabase: db.client as never,
    });
    const ttl =
      Date.parse(db.rows('funnel_previews')[0]!.expires_at as string) - before;
    expect(ttl).toBeLessThanOrEqual(60_000 + 5_000);
  });

  it('still hands the caller the row when the claim write fails', async () => {
    db.seed('funnel_previews', [row()]);
    db.failing.add('funnel_previews:update');
    const adopted = await claimFunnelPreview({
      previewId: PREVIEW_ID,
      workspaceId: WORKSPACE_ID,
      supabase: db.client as never,
    });
    // A failed claim write is a degradation, not a lost workspace: the caller
    // still gets what it adopted.
    expect(adopted?.previewId).toBe(PREVIEW_ID);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not mark preview')
    );
  });

  it('still hands the caller the row when the write path throws', async () => {
    const loadsThenThrows = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row(), error: null }),
          }),
        }),
        update: () => {
          throw new Error('write path exploded');
        },
      }),
    } as never;
    const adopted = await claimFunnelPreview({
      previewId: PREVIEW_ID,
      workspaceId: WORKSPACE_ID,
      supabase: loadsThenThrows,
    });
    expect(adopted?.previewId).toBe(PREVIEW_ID);
  });
});

describe('listExpiredFunnelPreviews', () => {
  it('returns only the unclaimed, not-yet-removed, past-TTL rows, oldest first', async () => {
    const past = (ms: number) => new Date(Date.now() - ms).toISOString();
    db.seed('funnel_previews', [
      row({ preview_id: PREVIEW_ID, expires_at: past(60_000) }),
      row({
        preview_id: OTHER_PREVIEW_ID,
        expires_at: past(600_000),
      }),
      row({
        preview_id: 'a1b2c3d4-1111-4111-8111-111111111113',
        expires_at: past(60_000),
        claimed_workspace_id: WORKSPACE_ID,
      }),
      row({
        preview_id: 'a1b2c3d4-1111-4111-8111-111111111114',
        expires_at: past(60_000),
        deploy_status: 'removed',
      }),
      row({
        preview_id: 'a1b2c3d4-1111-4111-8111-111111111115',
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }),
    ]);

    const expired = await listExpiredFunnelPreviews({
      supabase: db.client as never,
    });
    expect(expired.map((p) => p.previewId)).toEqual([
      OTHER_PREVIEW_ID,
      PREVIEW_ID,
    ]);
  });

  it('respects the sweep cap', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    db.seed('funnel_previews', [
      row({ preview_id: PREVIEW_ID, expires_at: past }),
      row({ preview_id: OTHER_PREVIEW_ID, expires_at: past }),
    ]);
    expect(
      await listExpiredFunnelPreviews({
        limit: 1,
        supabase: db.client as never,
      })
    ).toHaveLength(1);
  });

  it('degrades to an empty sweep on a Postgrest error and when the client throws', async () => {
    db.failing.add('funnel_previews');
    expect(
      await listExpiredFunnelPreviews({ supabase: db.client as never })
    ).toEqual([]);
    expect(
      await listExpiredFunnelPreviews({ supabase: throwingClient })
    ).toEqual([]);
  });
});

describe('uploadFunnelPreviewArtifact', () => {
  const tarball = new Uint8Array([31, 139, 8, 0]);

  it('refuses an id that is not a uuid', async () => {
    expect(
      await uploadFunnelPreviewArtifact({
        previewId: NOT_A_UUID,
        tarball,
        supabase: db.client as never,
      })
    ).toBeNull();
  });

  it('writes the tarball outside the tenant prefix', async () => {
    const path = await uploadFunnelPreviewArtifact({
      previewId: PREVIEW_ID,
      tarball,
      supabase: db.client as never,
    });
    expect(path).toBe(FUNNEL_PATH);
    expect(path?.startsWith('tenant/')).toBe(false);
    expect(db.objects.get(FUNNEL_PATH)?.contentType).toBe('application/gzip');
  });

  it('degrades to null when Storage is not wired at all', async () => {
    db.storageAvailable = false;
    expect(
      await uploadFunnelPreviewArtifact({
        previewId: PREVIEW_ID,
        tarball,
        supabase: db.client as never,
      })
    ).toBeNull();
  });

  it('degrades to null when Storage errors and when it throws', async () => {
    db.storageBroken = true;
    expect(
      await uploadFunnelPreviewArtifact({
        previewId: PREVIEW_ID,
        tarball,
        supabase: db.client as never,
      })
    ).toBeNull();
    expect(
      await uploadFunnelPreviewArtifact({
        previewId: PREVIEW_ID,
        tarball,
        supabase: throwingClient,
      })
    ).toBeNull();
  });
});

describe('signFunnelPreviewArtifact', () => {
  it('signs an object that exists', async () => {
    db.objects.set(FUNNEL_PATH, { bytes: new Uint8Array([1]) });
    const signed = await signFunnelPreviewArtifact({
      path: FUNNEL_PATH,
      expiresInSeconds: 120,
      supabase: db.client as never,
    });
    expect(signed).toContain(FUNNEL_PATH);
    expect(signed).toContain('exp=120');
  });

  it('degrades to null when Storage is not wired', async () => {
    db.storageAvailable = false;
    expect(
      await signFunnelPreviewArtifact({
        path: FUNNEL_PATH,
        supabase: db.client as never,
      })
    ).toBeNull();
  });

  it('degrades to null when there is nothing to sign and when Storage throws', async () => {
    expect(
      await signFunnelPreviewArtifact({
        path: FUNNEL_PATH,
        supabase: db.client as never,
      })
    ).toBeNull();
    expect(
      await signFunnelPreviewArtifact({
        path: FUNNEL_PATH,
        supabase: throwingClient,
      })
    ).toBeNull();
  });
});

describe('copyFunnelArtifactToTenant', () => {
  it('copies the bytes under the claiming workspace and leaves the funnel copy alone', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    db.objects.set(FUNNEL_PATH, { bytes });
    const target = await copyFunnelArtifactToTenant({
      previewId: PREVIEW_ID,
      workspaceId: WORKSPACE_ID,
      sourcePath: FUNNEL_PATH,
      supabase: db.client as never,
    });
    expect(target).toBe(TENANT_PATH);
    expect(Array.from(db.objects.get(TENANT_PATH)!.bytes)).toEqual([
      1, 2, 3, 4,
    ]);
    // A copy, not a move: the hosted preview is still being served from the
    // funnel object while the client signs in.
    expect(db.objects.has(FUNNEL_PATH)).toBe(true);
  });

  it('degrades to null when Storage is not wired', async () => {
    db.storageAvailable = false;
    expect(
      await copyFunnelArtifactToTenant({
        previewId: PREVIEW_ID,
        workspaceId: WORKSPACE_ID,
        sourcePath: FUNNEL_PATH,
        supabase: db.client as never,
      })
    ).toBeNull();
  });

  it('degrades to null when the source object is gone', async () => {
    expect(
      await copyFunnelArtifactToTenant({
        previewId: PREVIEW_ID,
        workspaceId: WORKSPACE_ID,
        sourcePath: FUNNEL_PATH,
        supabase: db.client as never,
      })
    ).toBeNull();
  });

  it('degrades to null when the tenant-side write is refused', async () => {
    const uploadRefused = {
      from: () => ({}),
      storage: {
        from: () => ({
          async download() {
            return {
              data: {
                arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
              } as unknown as Blob,
              error: null,
            };
          },
          async upload() {
            return { error: { message: 'bucket quota exceeded' } };
          },
        }),
      },
    } as never;
    expect(
      await copyFunnelArtifactToTenant({
        previewId: PREVIEW_ID,
        workspaceId: WORKSPACE_ID,
        sourcePath: FUNNEL_PATH,
        supabase: uploadRefused,
      })
    ).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not copy artifact')
    );
  });

  it('degrades to null when Storage throws', async () => {
    expect(
      await copyFunnelArtifactToTenant({
        previewId: PREVIEW_ID,
        workspaceId: WORKSPACE_ID,
        sourcePath: FUNNEL_PATH,
        supabase: throwingClient,
      })
    ).toBeNull();
  });
});

describe('deleteFunnelPreviewArtifact', () => {
  it('refuses to delete anything outside the funnel prefix', async () => {
    db.objects.set(TENANT_PATH, { bytes: new Uint8Array([1]) });
    expect(
      await deleteFunnelPreviewArtifact({
        path: TENANT_PATH,
        supabase: db.client as never,
      })
    ).toBe(false);
    // The client's artifact is untouched. This is the whole guarantee.
    expect(db.objects.has(TENANT_PATH)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('refusing to delete a non-funnel artifact path')
    );
  });

  it('deletes the anonymous funnel copy', async () => {
    db.objects.set(FUNNEL_PATH, { bytes: new Uint8Array([1]) });
    expect(
      await deleteFunnelPreviewArtifact({
        path: FUNNEL_PATH,
        supabase: db.client as never,
      })
    ).toBe(true);
    expect(db.objects.has(FUNNEL_PATH)).toBe(false);
  });

  it('degrades to false when Storage is not wired, errors, or throws', async () => {
    db.storageAvailable = false;
    expect(
      await deleteFunnelPreviewArtifact({
        path: FUNNEL_PATH,
        supabase: db.client as never,
      })
    ).toBe(false);
    db.storageAvailable = true;
    db.storageBroken = true;
    expect(
      await deleteFunnelPreviewArtifact({
        path: FUNNEL_PATH,
        supabase: db.client as never,
      })
    ).toBe(false);
    expect(
      await deleteFunnelPreviewArtifact({
        path: FUNNEL_PATH,
        supabase: throwingClient,
      })
    ).toBe(false);
  });
});

describe('the guest intake chat side channel', () => {
  it('refuses an id that is not a uuid, both ways', async () => {
    expect(
      await stashGuestIntakeChat(NOT_A_UUID, { turns: [] }, db.client as never)
    ).toBe(false);
    expect(
      await readGuestIntakeChat(NOT_A_UUID, db.client as never)
    ).toBeUndefined();
  });

  it('merges onto the manifest instead of replacing it', async () => {
    db.seed('funnel_previews', [row()]);
    expect(
      await stashGuestIntakeChat(
        PREVIEW_ID,
        { turns: [{ role: 'user', text: 'we do implants' }] },
        db.client as never
      )
    ).toBe(true);

    const manifest = db.rows('funnel_previews')[0]!.manifest as Record<
      string,
      unknown
    >;
    // The files the claim rebuilds from must survive the stash.
    expect(manifest.files).toHaveLength(1);
    expect(manifest.guestIntakeChat).toEqual({
      turns: [{ role: 'user', text: 'we do implants' }],
    });

    expect(await readGuestIntakeChat(PREVIEW_ID, db.client as never)).toEqual({
      turns: [{ role: 'user', text: 'we do implants' }],
    });
  });

  it('starts from an empty manifest when the stored one is not an object', async () => {
    db.seed('funnel_previews', [row({ manifest: ['not', 'an', 'object'] })]);
    expect(
      await stashGuestIntakeChat(PREVIEW_ID, { turns: [] }, db.client as never)
    ).toBe(true);
    expect(db.rows('funnel_previews')[0]!.manifest).toEqual({
      guestIntakeChat: { turns: [] },
    });
  });

  it('refuses to stash against a preview that does not exist', async () => {
    expect(
      await stashGuestIntakeChat(PREVIEW_ID, { turns: [] }, db.client as never)
    ).toBe(false);
  });

  it('degrades to false when the read fails and when the write fails', async () => {
    db.failing.add('funnel_previews:select');
    expect(
      await stashGuestIntakeChat(PREVIEW_ID, { turns: [] }, db.client as never)
    ).toBe(false);
    db.failing.clear();

    db.seed('funnel_previews', [row()]);
    db.failing.add('funnel_previews:update');
    expect(
      await stashGuestIntakeChat(PREVIEW_ID, { turns: [] }, db.client as never)
    ).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not stash the intake chat')
    );
  });

  it('reads undefined when there is no row, no manifest, or an array manifest', async () => {
    expect(
      await readGuestIntakeChat(PREVIEW_ID, db.client as never)
    ).toBeUndefined();

    db.seed('funnel_previews', [row({ manifest: null })]);
    expect(
      await readGuestIntakeChat(PREVIEW_ID, db.client as never)
    ).toBeUndefined();

    db.seed('funnel_previews', [row({ manifest: [1, 2, 3] })]);
    expect(
      await readGuestIntakeChat(PREVIEW_ID, db.client as never)
    ).toBeUndefined();
  });

  it('degrades to undefined when the read errors or the client throws', async () => {
    db.failing.add('funnel_previews');
    expect(
      await readGuestIntakeChat(PREVIEW_ID, db.client as never)
    ).toBeUndefined();
    expect(
      await readGuestIntakeChat(PREVIEW_ID, throwingClient)
    ).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not read the intake chat')
    );
  });
});
