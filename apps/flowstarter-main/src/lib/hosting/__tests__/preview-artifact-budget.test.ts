/**
 * The artifact size ceiling, and the refusal that happens before the upload.
 *
 * The defect this replaces was not "an artifact was too big". It was that
 * nothing on our side knew a ceiling existed, so the only thing anybody got
 * was Supabase Storage's own sentence — "The object exceeded the maximum
 * allowed size" — which names neither the limit, nor the size, nor the remedy.
 * The assertions below are therefore about *who refuses and what they say*,
 * not only about a number.
 *
 * Static imports throughout, and `vi.mock` for the two modules that would
 * otherwise reach a real Supabase: the publisher is exercised for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostingSupabase } from './fake-hosting-supabase';
import type { DeployAgentClient } from '../deploy';

vi.mock('server-only', () => ({}));

const db = createFakeHostingSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

interface RecordedAlert {
  event: string;
  discriminator: string;
  title: string;
  detail: Record<string, unknown>;
}
const alerts: RecordedAlert[] = [];
vi.mock('@/lib/ops/send-ops-alert', () => ({
  sendOpsAlert: async (input: RecordedAlert) => {
    alerts.push(input);
    return { sent: true };
  },
}));

import {
  PREVIEW_ARTIFACT_BUCKET_LIMIT_BYTES,
  PREVIEW_ARTIFACT_BUDGET_BYTES,
  PREVIEW_ARTIFACT_BUDGET_ENV_VAR,
  checkPreviewArtifactBudget,
  formatBytes,
  previewArtifactBudgetBytes,
} from '../preview-artifact-budget';
import { publishFunnelPreview } from '../preview-publisher';

const PREVIEW_ID = 'c0ffee00-2222-4222-8222-222222222222';

function agent() {
  const calls: string[] = [];
  const client: DeployAgentClient = {
    async push() {
      calls.push('push');
      return { ok: true as const, sha256: 'abc', sizeBytes: 1 };
    },
    async remove() {
      calls.push('remove');
      return { ok: true as const };
    },
  };
  return {
    calls,
    config: {
      deployAgentUrl: 'https://previews.example',
      sharedSecret: 'secret',
      client,
      configured: true,
    },
  };
}

/**
 * A built site whose bytes do not compress: gzip is what the tarball goes
 * through, so a megabyte of `'a'` would pack to nothing and prove nothing.
 */
function incompressibleSite(bytes: number) {
  let content = '';
  // Deterministic rather than random, so a failure is reproducible, and
  // base64-ish so it survives the archive's UTF-8 path unchanged.
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let seed = 1;
  for (let index = 0; index < bytes; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    content += alphabet[seed % alphabet.length];
  }
  return [
    { path: 'index.html', content: '<head></head><h1>Big</h1>' },
    { path: 'assets/bulk.css', content },
  ];
}

describe('previewArtifactBudgetBytes', () => {
  it('defaults to the named budget', () => {
    expect(previewArtifactBudgetBytes({})).toBe(PREVIEW_ARTIFACT_BUDGET_BYTES);
  });

  it('honours the env override', () => {
    expect(
      previewArtifactBudgetBytes({
        [PREVIEW_ARTIFACT_BUDGET_ENV_VAR]: String(5 * 1024 * 1024),
      })
    ).toBe(5 * 1024 * 1024);
  });

  it('ignores a value that is not a positive number of bytes', () => {
    for (const raw of ['nonsense', '0', '-1', '']) {
      expect(
        previewArtifactBudgetBytes({ [PREVIEW_ARTIFACT_BUDGET_ENV_VAR]: raw })
      ).toBe(PREVIEW_ARTIFACT_BUDGET_BYTES);
    }
  });

  /**
   * The invariant the whole change rests on. An operator who raises the budget
   * past the bucket has not raised anything — they have handed the refusal
   * back to Supabase, which is the failure being fixed.
   */
  it('refuses a budget at or above the storage bucket limit', () => {
    expect(PREVIEW_ARTIFACT_BUCKET_LIMIT_BYTES).toBeGreaterThan(
      PREVIEW_ARTIFACT_BUDGET_BYTES
    );
    expect(
      previewArtifactBudgetBytes({
        [PREVIEW_ARTIFACT_BUDGET_ENV_VAR]: String(
          PREVIEW_ARTIFACT_BUCKET_LIMIT_BYTES
        ),
      })
    ).toBe(PREVIEW_ARTIFACT_BUDGET_BYTES);
  });
});

describe('checkPreviewArtifactBudget', () => {
  it('passes an artifact at exactly the budget', () => {
    const verdict = checkPreviewArtifactBudget({ bytes: 100, budget: 100 });
    expect(verdict.withinBudget).toBe(true);
    expect(verdict.detail).toBeNull();
  });

  /**
   * The artifact that actually broke — the portfolio family's 11.35 MiB — now
   * PASSES, and that is the fix rather than an oversight: it was refused by a
   * 10 MiB bucket, the bucket is 32 MiB, and the budget is 16. What the budget
   * catches is the next order of magnitude, which is why the failing case here
   * is 20 MiB rather than the one from the incident.
   */
  it('passes the artifact the 10 MiB bucket refused', () => {
    expect(
      checkPreviewArtifactBudget({
        bytes: 11_591_766,
        budget: PREVIEW_ARTIFACT_BUDGET_BYTES,
      }).withinBudget
    ).toBe(true);
  });

  it('names the size, the budget and the way to raise it', () => {
    const verdict = checkPreviewArtifactBudget({
      bytes: 20 * 1024 * 1024,
      budget: PREVIEW_ARTIFACT_BUDGET_BYTES,
    });
    expect(verdict.withinBudget).toBe(false);
    expect(verdict.detail).toContain('20.0 MiB');
    expect(verdict.detail).toContain('16.0 MiB');
    expect(verdict.detail).toContain(PREVIEW_ARTIFACT_BUDGET_ENV_VAR);
    // The half of the sentence a visitor's claim depends on.
    expect(verdict.detail).toContain('still claimable');
  });
});

describe('formatBytes', () => {
  it('reads the way an operator would say it', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(11_591_766)).toBe('11.1 MiB');
  });
});

describe('publishFunnelPreview: the pre-upload check', () => {
  const ORIGINAL = process.env[PREVIEW_ARTIFACT_BUDGET_ENV_VAR];

  beforeEach(() => {
    db.reset();
    alerts.length = 0;
  });

  afterEach(() => {
    if (ORIGINAL === undefined)
      delete process.env[PREVIEW_ARTIFACT_BUDGET_ENV_VAR];
    else process.env[PREVIEW_ARTIFACT_BUDGET_ENV_VAR] = ORIGINAL;
  });

  it('refuses before the upload, keeps the manifest, and alerts an operator', async () => {
    // Small enough to build quickly, large enough that a real gzip of real
    // incompressible bytes clears it.
    process.env[PREVIEW_ARTIFACT_BUDGET_ENV_VAR] = String(4096);
    const previews = agent();

    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: [{ path: 'src/pages/index.astro', content: '<h1>Big</h1>' }],
      builtFiles: incompressibleSite(200_000),
      templateSlug: 'dorin-portfolio',
      agent: previews.config,
    });

    expect(result.status).toBe('failed');
    expect(result.published).toBe(false);
    // No artifact path: nothing was uploaded, which is the point.
    expect(result.artifactPath).toBeNull();
    // The deploy-agent was never called. A preview with nothing to fetch must
    // not look like a deploy attempt.
    expect(previews.calls).toEqual([]);
    expect(result.detail).toContain('over the');
    expect(result.detail).toContain(PREVIEW_ARTIFACT_BUDGET_ENV_VAR);

    // The manifest is still written, so the visitor can still claim the site
    // they were looking at.
    const row = db
      .rows('funnel_previews')
      .find((candidate) => candidate.preview_id === PREVIEW_ID) as
      | { manifest?: { files?: unknown[] } }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.manifest?.files).toHaveLength(1);

    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as RecordedAlert;
    expect(alert.event).toBe('preview_artifact_over_budget');
    // Per template family, not per preview: the same template going over every
    // time is one piece of news.
    expect(alert.discriminator).toBe('dorin-portfolio');
    expect(alert.detail.previewId).toBe(PREVIEW_ID);
    expect(alert.detail.budgetBytes).toBe(4096);
  });

  it('uploads and deploys an artifact inside the budget', async () => {
    delete process.env[PREVIEW_ARTIFACT_BUDGET_ENV_VAR];
    const previews = agent();

    const result = await publishFunnelPreview({
      previewId: PREVIEW_ID,
      files: [{ path: 'src/pages/index.astro', content: '<h1>Small</h1>' }],
      builtFiles: [
        { path: 'index.html', content: '<head></head><h1>Small</h1>' },
      ],
      templateSlug: 'local-trade',
      agent: previews.config,
    });

    expect(result.status).toBe('live');
    expect(previews.calls).toEqual(['push']);
    expect(alerts).toEqual([]);
  });
});
