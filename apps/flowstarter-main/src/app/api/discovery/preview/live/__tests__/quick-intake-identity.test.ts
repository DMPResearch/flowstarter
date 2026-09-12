/**
 * Regression: PR #108 cut the pre-preview intake to four questions and moved
 * the business-name question behind the deposit, into the Brief. It did not
 * update this route's readiness gate, which still required `businessName` —
 * so every quick-intake draft (which has `businessName: ''` by design) hit
 * `{ skip: true }` and the live preview never started. 100% of takes fell
 * back to the deterministic JSON preview.
 *
 * Two things are pinned here:
 *
 *   `hasPreviewIdentity` — the gate itself — is a pure predicate, tested on
 *   its own so the exact rule ("fullName or businessName") cannot drift
 *   silently.
 *
 *   The route, driven end to end with a quick-intake-shaped body (the four
 *   quick answers, `businessName` empty), no longer answers `{ skip: true }`.
 *   The generator is mocked at the same boundary
 *   `live-preview-teardown.test.ts` uses, so this proves the route's own
 *   gating logic without spending on a real generation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { getJob } from '@/lib/discovery/live-jobs';

vi.mock('server-only', () => ({}));

let workspaceRoot = '';

vi.mock('@flowstarter/daytona-utils', () => ({
  previewInSandbox: vi.fn(async () => ({
    success: true,
    previewUrl: 'https://sandbox.example/preview',
    sandboxId: 'sandbox-123',
    teardown: vi.fn(async () => undefined),
  })),
}));

vi.mock('@flowstarter/agentic-codegen', async () => ({
  ...(await import('@flowstarter/agentic-codegen/src/integrations')),
  FlowstarterMcpTemplateLibrary: class {
    close() {
      return Promise.resolve();
    }
  },
  PiSdkFlowstarterAgents: class {},
  PreviewGenerationPipeline: class {
    publisher: {
      publish: (input: unknown) => Promise<Record<string, unknown>>;
    };
    constructor(
      _agents: unknown,
      _library: unknown,
      _validator: unknown,
      publisher: {
        publish: (input: unknown) => Promise<Record<string, unknown>>;
      }
    ) {
      this.publisher = publisher;
    }
    async run(input: {
      intake: { projectId: string };
      onPhase?: (p: string) => void;
    }) {
      input.onPhase?.('Publishing your live preview');
      const published = await this.publisher.publish({
        projectId: input.intake.projectId,
        workspaceRoot,
        template: { slug: 'test-template' },
        brandConfig: {},
      });
      return {
        brandConfig: {},
        template: { slug: 'test-template' },
        generatedAssetsCostUsd: 0,
        ...published,
      };
    }
  },
}));

vi.mock('@/lib/ai/funnel-cost', () => ({
  funnelBudgetState: vi.fn(async () => ({ state: 'ok' as const })),
  recordGenerationCost: vi.fn(async () => undefined),
}));

vi.mock('@/lib/ai/llm', () => ({
  llmActionConfig: vi.fn(() => ({ maxTokens: 100_000 })),
  recordLlmUsage: vi.fn(async () => undefined),
}));

vi.mock('@/lib/flowstarter/claim', () => ({
  rememberClaimablePreview: vi.fn(async () => undefined),
}));

vi.mock('@/lib/hosting/preview-publisher', () => ({
  publishFunnelPreview: vi.fn(async () => ({ status: 'ready' as const })),
}));

import { POST, hasPreviewIdentity } from '../route';

describe('hasPreviewIdentity', () => {
  it('is true with only a full name — the one thing the quick intake still requires', () => {
    expect(hasPreviewIdentity({ fullName: 'Ana Pop', businessName: '' })).toBe(
      true
    );
  });

  it('is true with only a business name — the Brief-corrected case', () => {
    expect(
      hasPreviewIdentity({ fullName: '', businessName: 'Sable Fig' })
    ).toBe(true);
  });

  it('is true with both', () => {
    expect(
      hasPreviewIdentity({ fullName: 'Ana Pop', businessName: 'Sable Fig' })
    ).toBe(true);
  });

  it('is false with neither — a draft nobody has started', () => {
    expect(hasPreviewIdentity({ fullName: '', businessName: '' })).toBe(false);
  });

  it('ignores whitespace-only answers', () => {
    expect(hasPreviewIdentity({ fullName: '   ', businessName: '  ' })).toBe(
      false
    );
  });
});

function quickIntakeDraftRequest(): NextRequest {
  // Exactly the shape `previewPayload()` sends for a quick-intake draft:
  // `businessName` empty (PR #108 moved that question behind the deposit),
  // `fullName` and the one link present.
  return new NextRequest('http://localhost/api/discovery/preview/live', {
    method: 'POST',
    body: JSON.stringify({
      businessName: '',
      fullName: 'Ana Pop',
      email: 'ana@example.com',
      description: 'A small yoga studio in the neighbourhood.',
      websiteUrl: 'https://sablefig.ro',
    }),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/discovery/preview/live — quick-intake draft', () => {
  beforeEach(async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('FLOWSTARTER_MCP_URL', 'http://127.0.0.1:3001/mcp');
    vi.stubEnv('FLOWSTARTER_MCP_INTERNAL_TOKEN', 'test-token');
    vi.stubEnv('DAYTONA_API_KEY', 'test-daytona-key');
    workspaceRoot = await mkdtemp(join(tmpdir(), 'fs-preview-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('does not answer { skip: true } for a draft with an empty businessName', async () => {
    const res = await POST(quickIntakeDraftRequest());
    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as {
      demoId?: string;
      skip?: boolean;
    };
    expect(responseBody.skip).not.toBe(true);
    expect(responseBody.demoId).toBeTruthy();
  });

  it('carries a derived, non-empty businessName onto the job', async () => {
    const res = await POST(quickIntakeDraftRequest());
    const { demoId } = (await res.json()) as { demoId: string };
    const job = getJob(demoId);
    // The link resolves to a hostname-derived name; either way it must not
    // be empty — an unnamed business is not something the generator can
    // introduce a site with.
    expect(job?.businessName?.trim()).toBeTruthy();
  });
});
