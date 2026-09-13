/**
 * Regression: a preview whose sandbox/local `astro dev` child came up fine
 * but whose post-publish bookkeeping then threw used to leave that process
 * running forever — the job store never learned a teardown existed, and the
 * 45-minute reaper it should have fallen back to was never actually
 * scheduled. See project-infra-state-2026-08 memory: "~12 zombies were
 * squatting ports on 2026-08-31."
 *
 * This drives the real POST handler through a successful `pipeline.run()`
 * (mocked at the `@flowstarter/agentic-codegen` / `@flowstarter/daytona-utils`
 * boundary, so the route's own publisher/teardown wiring runs for real) and
 * then fails the step right after publish, asserting the sandbox teardown
 * still gets called and the job ends up `failed` rather than stuck
 * `building`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { getJob } from '@/lib/discovery/live-jobs';

vi.mock('server-only', () => ({}));

// The MCP prerequisite is now a real `GET /health` probe (see
// generation-availability.ts) rather than a plain "is the URL set" check;
// this suite is about teardown-on-failure wiring, not that probe, so it
// stubs prerequisites as satisfied instead of hitting the network.
vi.mock('@/lib/discovery/generation-availability', () => ({
  missingGenerationPrerequisites: vi.fn(async () => []),
}));

const teardownSpy = vi.fn(async () => undefined);
let workspaceRoot = '';

vi.mock('@flowstarter/daytona-utils', () => ({
  previewInSandbox: vi.fn(async () => ({
    success: true,
    previewUrl: 'https://sandbox.example/preview',
    sandboxId: 'sandbox-123',
    teardown: teardownSpy,
  })),
}));

// The heavy classes are stubbed; the deterministic Cal injectors are the real
// ones, because the route's preview path runs them over the generated files.
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

// The specific fault under test: bookkeeping right after a successful
// publish throws, and must not orphan the sandbox it just brought up.
vi.mock('@/lib/flowstarter/claim', () => ({
  rememberClaimablePreview: vi.fn(async () => {
    throw new Error('claim store unavailable');
  }),
}));

vi.mock('@/lib/hosting/preview-publisher', () => ({
  publishFunnelPreview: vi.fn(async () => ({ status: 'failed' as const })),
}));

import { POST } from '../route';

function liveRequest(): NextRequest {
  return new NextRequest('http://localhost/api/discovery/preview/live', {
    method: 'POST',
    body: JSON.stringify({
      businessName: 'Acme Yoga',
      description: 'A small yoga studio in the neighbourhood.',
    }),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function jobSettled(demoId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const status = getJob(demoId)?.status;
    if (status === 'ready' || status === 'failed') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job never settled');
}

describe('POST /api/discovery/preview/live — orphan teardown on late failure', () => {
  beforeEach(async () => {
    // The publish step is a rule now (`preview-publisher-rule.ts`), and its
    // default is Flowstarter's own platform. These suites stub the Daytona
    // sandbox, so they name that publisher explicitly - which is also the only
    // way it is ever chosen.
    vi.stubEnv('FLOWSTARTER_PREVIEW_PUBLISHER', 'daytona');
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-test');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('FLOWSTARTER_MCP_URL', 'http://127.0.0.1:3001/mcp');
    vi.stubEnv('FLOWSTARTER_MCP_INTERNAL_TOKEN', 'test-token');
    vi.stubEnv('DAYTONA_API_KEY', 'test-daytona-key');
    teardownSpy.mockClear();
    workspaceRoot = await mkdtemp(join(tmpdir(), 'fs-preview-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('tears down the sandbox when a step after publish throws', async () => {
    const res = await POST(liveRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { demoId: string };

    await jobSettled(body.demoId);

    const job = getJob(body.demoId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('claim store unavailable');
    expect(teardownSpy).toHaveBeenCalledTimes(1);
    // Cleared once acted on, so a later reaper sweep cannot double-teardown.
    expect(job?.teardown).toBeUndefined();
  });
});
