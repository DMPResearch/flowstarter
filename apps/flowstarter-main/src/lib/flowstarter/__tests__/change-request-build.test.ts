import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  changeRequestAssetPath,
  changeRequestBuildPayload,
  currentSiteVersion,
  enqueueChangeRequestBuild,
  selectChangeRequestAssets,
} from '../change-request-build';
import type { ChangeRequestRow } from '../change-requests';
import type { UsableAsset } from '../generation-assets';
import { createFakeSupabase } from './fake-supabase';

const WORKSPACE_ID = 'c009105e-f8ec-42bf-bdcf-cf92bb500f45';
const CHANGE_ID = '72fe7f79-0e83-4cf6-9b4a-2502842b9a54';

const loadUsableAssets =
  vi.fn<(workspaceId: string) => Promise<UsableAsset[]>>();
vi.mock('../generation-assets', () => ({
  loadUsableAssets: (workspaceId: string) => loadUsableAssets(workspaceId),
}));

const db = createFakeSupabase();
const client = () => db.client as unknown as SupabaseClient;

function usable(overrides: Partial<UsableAsset> = {}): UsableAsset {
  return {
    id: 'b104b1e0-6d4c-4a3e-9230-13cc17b426a0',
    storagePath: `tenant/${WORKSPACE_ID}/assets/e1619dc9.jpg`,
    mime: 'image/jpeg',
    width: 1200,
    height: 750,
    usableFor: ['section'],
    caption: 'The Flowstarter client dashboard',
    ...overrides,
  };
}

function request(overrides: Partial<ChangeRequestRow> = {}): ChangeRequestRow {
  return {
    id: CHANGE_ID,
    workspace_id: WORKSPACE_ID,
    message_id: null,
    request:
      'The case study pages only show one picture each. Please add a small ' +
      'gallery with the other screenshots I uploaded.',
    classification: 'structural',
    matched_rules: ['structural:new-thing'],
    status: 'paid',
    quote_minor: 19_000,
    currency: 'eur',
    quote_note: null,
    quoted_by: 'user_operator',
    quoted_at: '2026-09-12T09:12:00.000Z',
    responded_at: '2026-09-12T09:13:00.000Z',
    stripe_checkout_session_id: 'cs_test_1',
    stripe_payment_intent_id: 'pi_test_1',
    paid_at: '2026-09-12T09:14:53.953Z',
    completed_at: null,
    build_job_id: null,
    built_version: null,
    completed_via: null,
    completion_note: null,
    created_by: 'user_client',
    created_at: '2026-09-12T09:10:00.000Z',
    updated_at: '2026-09-12T09:14:53.953Z',
    ...overrides,
  };
}

beforeEach(() => {
  db.reset();
  loadUsableAssets.mockReset();
  loadUsableAssets.mockResolvedValue([usable()]);
});

describe('changeRequestAssetPath', () => {
  it('names the public copy from the asset id, never the uploaded name', () => {
    // The client's file name is whatever their phone called it; the id is a
    // UUID the database minted, and the `cr-` prefix says how it arrived.
    expect(changeRequestAssetPath(usable())).toBe(
      '/flowstarter-media/cr-b104b1e0.jpg'
    );
  });

  it('falls back to the mime type when the stored path has no extension', () => {
    expect(
      changeRequestAssetPath(
        usable({
          storagePath: `tenant/${WORKSPACE_ID}/assets/e1619dc9`,
          mime: 'image/webp',
        })
      )
    ).toBe('/flowstarter-media/cr-b104b1e0.webp');
  });
});

describe('selectChangeRequestAssets', () => {
  it("takes the operator's choice when they made one", () => {
    const other = usable({ id: '1c9d0e93-1d15-4ee8-ba3c-2dc99e5186ff' });
    const chosen = selectChangeRequestAssets({
      assets: [usable(), other],
      request: 'Add a gallery',
      selectedAssetIds: [other.id],
    });
    expect(chosen.map((asset) => asset.assetId)).toEqual([other.id]);
  });

  it('prefers the pictures the request names by caption', () => {
    const named = usable({
      id: '1c9d0e93-1d15-4ee8-ba3c-2dc99e5186ff',
      caption: 'operator pipeline',
    });
    const chosen = selectChangeRequestAssets({
      assets: [usable(), named],
      request: 'Put the operator pipeline screenshot on the case study page',
    });
    expect(chosen.map((asset) => asset.assetId)).toEqual([named.id]);
  });

  it('carries everything rights-confirmed when the request names nothing', () => {
    const chosen = selectChangeRequestAssets({
      assets: [
        usable(),
        usable({ id: '1c9d0e93-1d15-4ee8-ba3c-2dc99e5186ff' }),
      ],
      request: 'Please make the case studies look fuller',
    });
    expect(chosen).toHaveLength(2);
    // Paths and captions come across, so the prompt can be honest about both.
    expect(chosen[0]?.publicPath).toBe('/flowstarter-media/cr-b104b1e0.jpg');
    expect(chosen[0]?.manifestPath).toBe(
      'public/flowstarter-media/cr-b104b1e0.jpg'
    );
    expect(chosen[0]?.caption).toBe('The Flowstarter client dashboard');
  });

  it('caps how many pictures one request can carry', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      usable({
        id: `b104b1e0-6d4c-4a3e-9230-13cc17b4${String(index).padStart(4, '0')}`,
      })
    );
    expect(
      selectChangeRequestAssets({ assets: many, request: 'all of them' })
    ).toHaveLength(12);
  });
});

describe('changeRequestBuildPayload', () => {
  it("carries the client's words unedited", () => {
    const payload = changeRequestBuildPayload({
      row: request(),
      operatorNote: 'Three across on desktop',
      seedVersion: 4,
      assets: [],
    });
    expect(payload.trigger).toBe('operator_build');
    expect(payload.changeRequest.request).toBe(request().request);
    expect(payload.changeRequest.operatorNote).toBe('Three across on desktop');
    expect(payload.changeRequest.seedVersion).toBe(4);
  });
});

describe('currentSiteVersion', () => {
  it('reads the newest version, or 0 for a site never edited', async () => {
    expect(await currentSiteVersion(client(), WORKSPACE_ID)).toBe(0);
    db.seed('site_versions', [
      { workspace_id: WORKSPACE_ID, version: 3 },
      { workspace_id: WORKSPACE_ID, version: 4 },
    ]);
    expect(await currentSiteVersion(client(), WORKSPACE_ID)).toBe(4);
  });
});

describe('enqueueChangeRequestBuild', () => {
  const enqueue = (overrides: Record<string, unknown> = {}) =>
    enqueueChangeRequestBuild({
      supabase: client(),
      workspaceId: WORKSPACE_ID,
      row: request(),
      projectState: 'HUMAN_QA',
      operatorNote: null,
      ...overrides,
    } as Parameters<typeof enqueueChangeRequestBuild>[0]);

  it('queues one job and links it back to the request', async () => {
    db.seed('site_versions', [{ workspace_id: WORKSPACE_ID, version: 4 }]);
    db.seed('flowstarter_change_requests', [request() as never]);

    const result = await enqueue({ operatorNote: 'Three across' });
    expect(result.created).toBe(true);
    expect(result.seedVersion).toBe(4);
    expect(result.assets).toHaveLength(1);

    const jobs = db.rows('flowstarter_agent_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe('CHANGE_REQUEST_BUILD');
    expect(jobs[0]?.status).toBe('queued');
    const payload = jobs[0]?.payload as {
      changeRequest: { changeRequestId: string; assets: unknown[] };
    };
    expect(payload.changeRequest.changeRequestId).toBe(CHANGE_ID);
    expect(payload.changeRequest.assets).toHaveLength(1);

    // The link the operator's card and the deploy callback both follow.
    expect(db.rows('flowstarter_change_requests')[0]?.build_job_id).toBe(
      result.jobId
    );
    // And the request is still at paid: only the worker may move it.
    expect(db.rows('flowstarter_change_requests')[0]?.status).toBe('paid');
  });

  it('reads the assets through loadUsableAssets and nothing else', async () => {
    await enqueue();
    // Rights are confirmed over a chosen set of files, so holding an asset row
    // is not permission to publish it. This loader is the only reader that
    // answers "what may we build with".
    expect(loadUsableAssets).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it('refuses a project that has no delivered site yet', async () => {
    await expect(
      enqueue({ projectState: 'DEPOSIT_PAID' })
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_STATE', status: 409 });
    await expect(
      enqueue({ projectState: 'PREVIEW_READY' })
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_STATE' });
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(0);
  });

  it('builds from either state a delivered site exists in', async () => {
    await expect(enqueue({ projectState: 'HUMAN_QA' })).resolves.toBeTruthy();
    db.reset();
    await expect(
      enqueue({ projectState: 'LIVE_SUBSCRIPTION' })
    ).resolves.toBeTruthy();
  });

  it('refuses a request nobody has paid for', async () => {
    for (const status of ['requested', 'quoted', 'accepted', 'declined']) {
      await expect(enqueue({ row: request({ status }) })).rejects.toMatchObject(
        { code: 'CHANGE_REQUEST_NOT_PAID', status: 409 }
      );
    }
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(0);
  });

  it('refuses to build a request that already shipped', async () => {
    await expect(
      enqueue({ row: request({ status: 'done' }) })
    ).rejects.toMatchObject({ code: 'CHANGE_REQUEST_NOT_PAID' });
  });

  it('joins a build already in flight rather than racing it', async () => {
    // Two change builds at once would race for the same worktree and the same
    // version number, and the loser would publish a site missing the winner's
    // change.
    db.seed('flowstarter_agent_jobs', [
      {
        id: 'job-live',
        workspace_id: WORKSPACE_ID,
        kind: 'CHANGE_REQUEST_BUILD',
        status: 'running',
        created_at: '2026-09-12T10:00:00.000Z',
      },
    ]);
    const result = await enqueue();
    expect(result).toMatchObject({ jobId: 'job-live', created: false });
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(1);
  });

  it('starts a new job once the previous one has finished', async () => {
    db.seed('flowstarter_agent_jobs', [
      {
        id: 'job-old',
        workspace_id: WORKSPACE_ID,
        kind: 'CHANGE_REQUEST_BUILD',
        status: 'succeeded',
        created_at: '2026-09-12T09:00:00.000Z',
      },
    ]);
    const result = await enqueue();
    expect(result.created).toBe(true);
    expect(result.jobId).not.toBe('job-old');
  });
});
