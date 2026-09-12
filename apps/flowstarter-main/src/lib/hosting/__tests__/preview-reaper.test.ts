/**
 * Teardown, and the two things it must never do.
 *
 * A reaper that is slightly too eager is worse than no reaper: it takes down a
 * site a client is looking at, or deletes the artifact a paid build was going
 * to be produced from. So the cases here are mostly about restraint —
 *
 *  - a CLAIMED preview is never touched, including when the claim lands
 *    between the candidate query and the teardown (the real race: a visitor
 *    signing in at the moment the sweep runs);
 *  - nothing under `tenant/` is ever deleted. The only object it removes is
 *    the anonymous `funnel/` copy;
 *  - one failure does not stop the sweep, and a failed teardown is not
 *    reported as a success.
 *
 * Static imports: vi.mock is hoisted above them, and the app's tsconfig does
 * not allow top-level await in tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostingSupabase } from './fake-hosting-supabase';
import type { DeployAgentClient } from '../deploy';

vi.mock('server-only', () => ({}));

const db = createFakeHostingSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

import {
  PREVIEW_DOMAIN_SUFFIX,
  previewsDeployAgentFromEnv,
} from '../preview-publisher';
import { reapExpiredPreviews } from '../preview-reaper';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

function previewId(n: number): string {
  return `a1b2c3d4-1111-4111-8111-1111111111${String(n).padStart(2, '0')}`;
}

function expiredRow(n: number, overrides: Record<string, unknown> = {}) {
  const id = previewId(n);
  return {
    preview_id: id,
    template_slug: 'wellness-therapy',
    brand_config: {},
    manifest: { files: [] },
    artifact_path: `funnel/${id}/site.tar.gz`,
    // Derived, not spelled out: the preview zone follows the environment
    // (`preview.flowstarter.dev` here, `preview.flowstarter.net` in
    // production), and a fixture that hardcoded one of them would only ever
    // exercise the reaper against the other environment's names.
    hostname: `p-000000000000000${n}.${PREVIEW_DOMAIN_SUFFIX}`,
    deploy_status: 'live',
    deployment_error: null,
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    claimed_workspace_id: null,
    created_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function recordingAgent(behaviour: 'ok' | 'throw' = 'ok') {
  const calls: Array<{ method: string; siteSlug?: string }> = [];
  const client: DeployAgentClient = {
    async push() {
      calls.push({ method: 'push' });
      return { ok: true as const, sha256: '', sizeBytes: 0 };
    },
    async remove(args) {
      calls.push({ method: 'remove', siteSlug: args.siteSlug });
      if (behaviour === 'throw') throw new Error('agent unreachable');
      return { ok: true as const };
    },
  };
  return {
    calls,
    config: {
      deployAgentUrl: 'https://previews.host:8444',
      sharedSecret: 'previews-secret-token',
      client,
      configured: true,
    },
  };
}

beforeEach(() => {
  db.reset();
});

describe('reapExpiredPreviews', () => {
  it('removes the site and the funnel artifact for an expired preview', async () => {
    const row = expiredRow(1);
    db.seed('funnel_previews', [row]);
    db.objects.set(row.artifact_path, { bytes: new Uint8Array([1, 2, 3]) });

    const agent = recordingAgent();
    const result = await reapExpiredPreviews({ agent: agent.config });

    expect(result.considered).toBe(1);
    expect(result.reaped).toBe(1);
    expect(result.failed).toBe(0);
    expect(agent.calls).toEqual([
      { method: 'remove', siteSlug: 'p-0000000000000001' },
    ]);
    expect(db.objects.has(row.artifact_path)).toBe(false);
    expect(db.rows('funnel_previews')[0].deploy_status).toBe('removed');
  });

  it('never touches a claimed preview', async () => {
    db.seed('funnel_previews', [
      expiredRow(1, { claimed_workspace_id: WORKSPACE_ID }),
    ]);
    const agent = recordingAgent();
    const result = await reapExpiredPreviews({ agent: agent.config });

    expect(result.considered).toBe(0);
    expect(result.reaped).toBe(0);
    expect(agent.calls).toHaveLength(0);
    expect(db.rows('funnel_previews')[0].deploy_status).toBe('live');
  });

  it('skips a preview claimed between the query and the teardown', async () => {
    // The real race: the sweep listed this row, then the visitor signed in.
    const row = expiredRow(1);
    db.seed('funnel_previews', [row]);
    const agent = recordingAgent();

    const original = db.client as { from: (t: string) => unknown };
    const from = original.from.bind(original);
    let listed = false;
    vi.spyOn(original, 'from').mockImplementation((table: string) => {
      if (table === 'funnel_previews' && listed) {
        db.rows('funnel_previews')[0].claimed_workspace_id = WORKSPACE_ID;
      }
      listed = true;
      return from(table);
    });

    const result = await reapExpiredPreviews({ agent: agent.config });
    vi.restoreAllMocks();

    expect(result.considered).toBe(1);
    expect(result.skippedClaimed).toBe(1);
    expect(result.reaped).toBe(0);
    expect(agent.calls).toHaveLength(0);
  });

  it('leaves previews that have not expired yet alone', async () => {
    db.seed('funnel_previews', [
      expiredRow(1, {
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ]);
    const agent = recordingAgent();
    const result = await reapExpiredPreviews({ agent: agent.config });
    expect(result.considered).toBe(0);
    expect(agent.calls).toHaveLength(0);
  });

  it('does not re-reap something already removed', async () => {
    db.seed('funnel_previews', [expiredRow(1, { deploy_status: 'removed' })]);
    const agent = recordingAgent();
    const result = await reapExpiredPreviews({ agent: agent.config });
    expect(result.considered).toBe(0);
    expect(agent.calls).toHaveLength(0);
  });

  it('never deletes anything under a tenant prefix', async () => {
    const tenantPath = `tenant/${WORKSPACE_ID}/previews/${previewId(
      1
    )}/site.tar.gz`;
    // A row whose artifact_path somehow points at tenant storage — the guard
    // in deleteFunnelPreviewArtifact is the thing under test, because a bug
    // upstream must not be able to delete a client's build source.
    db.seed('funnel_previews', [expiredRow(1, { artifact_path: tenantPath })]);
    db.objects.set(tenantPath, { bytes: new Uint8Array([9]) });

    const agent = recordingAgent();
    const result = await reapExpiredPreviews({ agent: agent.config });

    expect(result.reaped).toBe(1);
    expect(result.previews[0].artifactRemoved).toBe(false);
    expect(db.objects.has(tenantPath)).toBe(true);
  });

  it('counts a failed teardown as failed and keeps the artifact', async () => {
    const row = expiredRow(1);
    db.seed('funnel_previews', [row]);
    db.objects.set(row.artifact_path, { bytes: new Uint8Array([1]) });

    const agent = recordingAgent('throw');
    const result = await reapExpiredPreviews({ agent: agent.config });

    expect(result.reaped).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.previews[0].siteRemoved).toBe(false);
    // Still on disk: a site we could not confirm is gone is not one whose
    // source we should throw away.
    expect(db.objects.has(row.artifact_path)).toBe(true);
    expect(db.rows('funnel_previews')[0].deploy_status).toBe('live');
  });

  it('keeps going after one failure', async () => {
    db.seed('funnel_previews', [expiredRow(1), expiredRow(2), expiredRow(3)]);
    let call = 0;
    const client: DeployAgentClient = {
      async push() {
        return { ok: true as const, sha256: '', sizeBytes: 0 };
      },
      async remove() {
        call += 1;
        if (call === 2) throw new Error('agent unreachable');
        return { ok: true as const };
      },
    };
    const result = await reapExpiredPreviews({
      agent: {
        deployAgentUrl: 'https://previews.host:8444',
        sharedSecret: 'previews-secret-token',
        client,
        configured: true,
      },
    });
    expect(result.considered).toBe(3);
    expect(result.reaped).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('reports a dry run when the previews agent is unconfigured', async () => {
    db.seed('funnel_previews', [expiredRow(1)]);
    const result = await reapExpiredPreviews({
      agent: previewsDeployAgentFromEnv({} as unknown as NodeJS.ProcessEnv),
    });
    expect(result.dryRun).toBe(true);
    expect(result.previews[0].detail).toContain('dry run');
  });

  it('honours the sweep limit', async () => {
    db.seed('funnel_previews', [expiredRow(1), expiredRow(2), expiredRow(3)]);
    const agent = recordingAgent();
    const result = await reapExpiredPreviews({ agent: agent.config, limit: 2 });
    expect(result.considered).toBe(2);
    expect(agent.calls).toHaveLength(2);
  });
});

describe('the sweep with nothing configured at all', () => {
  it('reads the service-role client and the env agent, and reports a dry run', async () => {
    // No agent, no client, no `now`: the shape a cron invocation actually uses.
    db.seed('funnel_previews', [expiredRow(1)]);
    const result = await reapExpiredPreviews();
    expect(result.dryRun).toBe(true);
    expect(result.considered).toBe(1);
    expect(result.reaped).toBe(1);
    expect(result.previews[0]!.detail).toMatch(/dry run/);
    expect(db.rows('funnel_previews')[0]!.deploy_status).toBe('removed');
  });
});
