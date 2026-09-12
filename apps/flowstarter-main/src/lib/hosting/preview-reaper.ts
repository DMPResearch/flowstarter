import 'server-only';

/**
 * Teardown for expired funnel previews.
 *
 * Every preview is a real hosted site with a real TLS certificate and a real
 * disk footprint on a shared box. Without this, generating one is a permanent
 * commitment: a visitor who never comes back leaves us serving their business's
 * name and our copy, forever, at a URL we can no longer account for. The TTL on
 * `funnel_previews.expires_at` is the promise; this is what keeps it.
 *
 * Two things it will not do, ever:
 *
 *  - touch a CLAIMED preview. `listExpiredFunnelPreviews` filters on
 *    `claimed_workspace_id is null` and this re-checks each row before acting,
 *    because the claim and the sweep can race: a preview claimed a millisecond
 *    after the query would otherwise have its site removed out from under the
 *    client who just paid attention to it.
 *  - delete anything under `tenant/`. The only object it removes is the funnel
 *    copy at `funnel/{previewId}/site.tar.gz`;
 *    `deleteFunnelPreviewArtifact` refuses any other prefix. A claimed
 *    preview's artifact was copied under the client's workspace and belongs to
 *    them.
 *
 * Failure is per-row and non-fatal: one preview whose agent call fails must not
 * stop the other forty from being reclaimed. Failures are counted and returned
 * so an operator sees them.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { deleteFunnelAssets } from '../flowstarter/funnel-assets';
import {
  deleteFunnelPreviewArtifact,
  listExpiredFunnelPreviews,
  loadFunnelPreview,
  type FunnelPreviewRow,
} from './funnel-previews';
import {
  previewsDeployAgentFromEnv,
  unpublishFunnelPreview,
  type PreviewAgentConfig,
} from './preview-publisher';

type Client = SupabaseClient<Database>;

export interface ReapedPreview {
  previewId: string;
  hostname: string | null;
  siteRemoved: boolean;
  artifactRemoved: boolean;
  /** Pictures the visitor uploaded before the claim, deleted with the preview. */
  picturesRemoved: number;
  detail: string | null;
}

export interface ReapResult {
  /** How many expired, unclaimed rows the sweep considered. */
  considered: number;
  /** How many were fully torn down. */
  reaped: number;
  /** How many were skipped because they had been claimed in the meantime. */
  skippedClaimed: number;
  failed: number;
  /** True when the previews agent is not configured (this was a dry run). */
  dryRun: boolean;
  previews: ReapedPreview[];
}

export interface ReapOptions {
  now?: Date;
  /** Cap per sweep, so an operator click cannot spend a minute in the agent. */
  limit?: number;
  agent?: PreviewAgentConfig;
  supabase?: Client;
}

export async function reapExpiredPreviews(
  options: ReapOptions = {}
): Promise<ReapResult> {
  const agent = options.agent ?? previewsDeployAgentFromEnv();
  const now = options.now ?? new Date();
  const candidates = await listExpiredFunnelPreviews({
    now,
    limit: options.limit ?? 50,
    ...(options.supabase ? { supabase: options.supabase } : {}),
  });

  const result: ReapResult = {
    considered: candidates.length,
    reaped: 0,
    skippedClaimed: 0,
    failed: 0,
    dryRun: !agent.configured,
    previews: [],
  };

  for (const candidate of candidates) {
    // Re-read: the claim may have landed between the list query and here.
    const fresh = await reReadClaimState(candidate, options.supabase);
    if (fresh?.claimedWorkspaceId) {
      result.skippedClaimed += 1;
      continue;
    }

    const removal = await unpublishFunnelPreview({
      previewId: candidate.previewId,
      hostname: candidate.hostname,
      agent,
      ...(options.supabase ? { supabase: options.supabase } : {}),
    });

    let artifactRemoved = false;
    if (removal.removed && candidate.artifactPath) {
      artifactRemoved = await deleteFunnelPreviewArtifact({
        path: candidate.artifactPath,
        ...(options.supabase ? { supabase: options.supabase } : {}),
      });
    }

    // A preview may also hold pictures the visitor uploaded before there was a
    // workspace: a logo or a headshot, taken when their profiles would not
    // load, so the palette could come from their own material. Those live
    // under the same `funnel/{previewId}/` prefix and die with the preview.
    //
    // Deliberately not gated on `removal.removed`. The site teardown talks to
    // a deploy agent that may be unreachable, while these are rows and objects
    // we own outright, and leaving a stranger's photograph in the bucket
    // because a Hetzner host was down is the wrong way round.
    let picturesRemoved = 0;
    try {
      const deleted = await deleteFunnelAssets({
        previewId: candidate.previewId,
        ...(options.supabase ? { supabase: options.supabase } : {}),
      });
      picturesRemoved = deleted.removed;
    } catch (error) {
      console.warn(
        `[preview-reaper] ${candidate.previewId}: could not delete the ` +
          'uploaded pictures: ' +
          (error instanceof Error ? error.message : 'unknown error')
      );
    }

    if (removal.removed) result.reaped += 1;
    else result.failed += 1;

    result.previews.push({
      previewId: candidate.previewId,
      hostname: candidate.hostname,
      siteRemoved: removal.removed,
      artifactRemoved,
      picturesRemoved,
      detail: removal.detail,
    });
  }

  return result;
}

/**
 * Reads the row again for its claim state only. `includeExpired` is on: the
 * row is expired by definition here, and refusing to load it would make every
 * candidate look unclaimed — the exact mistake this guard exists to prevent.
 */
async function reReadClaimState(
  candidate: FunnelPreviewRow,
  supabase?: Client
): Promise<FunnelPreviewRow | null> {
  return loadFunnelPreview(candidate.previewId, {
    includeExpired: true,
    ...(supabase ? { supabase } : {}),
  });
}
