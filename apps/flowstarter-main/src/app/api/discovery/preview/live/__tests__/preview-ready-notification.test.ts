/**
 * The wiring that makes "Where should I send your preview once it's ready?"
 * a true question.
 *
 * The address was collected by the wizard from the first version and then
 * dropped before the request that knows when the preview is ready, so the one
 * email the intake explicitly promises was the one email that could never be
 * sent. `preview-ready-email.test.ts` covers the sender itself; this covers
 * the part that cannot be unit tested away, which is whether the route carries
 * the address to it at all and fires at the moment the job turns ready.
 *
 * Driven through the real POST handler with the heavy pipeline stubbed at the
 * package boundary, the same way `live-preview-teardown.test.ts` does it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { getJob } from '@/lib/discovery/live-jobs';

vi.mock('server-only', () => ({}));

const sendEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

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

// Unlike the teardown regression next door, this one has to reach `ready`.
vi.mock('@/lib/flowstarter/claim', () => ({
  rememberClaimablePreview: vi.fn(async () => undefined),
}));

// No previews host in this environment, which is the case the email has to
// survive: it falls back to the link the wizard itself shows.
vi.mock('@/lib/hosting/preview-publisher', () => ({
  publishFunnelPreview: vi.fn(async () => ({ status: 'pending' as const })),
}));

import { POST } from '../route';

function liveRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/discovery/preview/live', {
    method: 'POST',
    body: JSON.stringify({
      businessName: 'Acme Yoga',
      fullName: 'Ada Lovelace',
      description: 'A small yoga studio in the neighbourhood.',
      ...body,
    }),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function jobSettled(demoId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const status = getJob(demoId)?.status;
    if (status === 'ready' || status === 'failed') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job never settled');
}

/** The email is sent after the ready flip, so settling is not enough. */
async function emailSettled(demoId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (getJob(demoId)?.readyEmailAt) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('POST /api/discovery/preview/live tells the visitor it is ready', () => {
  beforeEach(async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('FLOWSTARTER_MCP_URL', 'http://127.0.0.1:3001/mcp');
    vi.stubEnv('FLOWSTARTER_MCP_INTERNAL_TOKEN', 'test-token');
    vi.stubEnv('DAYTONA_API_KEY', 'test-daytona-key');
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ success: true, id: 'em_1' });
    workspaceRoot = await mkdtemp(join(tmpdir(), 'fs-preview-ready-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('emails the address the intake collected, once, with the preview link', async () => {
    const res = await POST(liveRequest({ email: 'ada@example.com' }));
    const { demoId } = (await res.json()) as { demoId: string };

    await jobSettled(demoId);
    expect(getJob(demoId)?.status).toBe('ready');
    await emailSettled(demoId);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(mail.to).toBe('ada@example.com');
    expect(mail.subject).toBe('Your preview is ready');
    // The sandbox URL is what the wizard shows, so it is what the email links.
    expect(mail.html).toContain('https://sandbox.example/preview');
    expect(mail.html).toContain('Acme Yoga');

    // The flag the second pass reads, so nothing can send it twice.
    expect(getJob(demoId)?.readyEmailAt).toBeGreaterThan(0);
  });

  it('still reaches ready when no address was given', async () => {
    const res = await POST(liveRequest());
    const { demoId } = (await res.json()) as { demoId: string };

    await jobSettled(demoId);
    expect(getJob(demoId)?.status).toBe('ready');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('still reaches ready when the mailer is down', async () => {
    sendEmail.mockRejectedValue(new Error('socket hang up'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await POST(liveRequest({ email: 'ada@example.com' }));
    const { demoId } = (await res.json()) as { demoId: string };

    await jobSettled(demoId);
    // A preview that generated perfectly is not allowed to be reported as
    // failed because Resend was unreachable.
    expect(getJob(demoId)?.status).toBe('ready');
    expect(getJob(demoId)?.error).toBeUndefined();
    vi.restoreAllMocks();
  });
});
