/**
 * POST /api/discovery/preview/live   — start a real, sandbox-hosted demo
 * GET  /api/discovery/preview/live?demoId=…  — poll its status
 *
 * Runs the headless Pi SDK pipeline (brand intelligence → MCP template
 * selection → bounded template personalization) and publishes the result to
 * Daytona. Work runs detached;
 * POST returns a demoId immediately and the wizard polls GET (the build-step
 * checklist covers the wait). Fails open: budget-blocked / engine or sandbox
 * error → { skip:true }, so step-7 falls back to the deterministic JSON demo
 * and the funnel never dead-ends.
 *
 * Node runtime + long maxDuration: Pi needs a filesystem and multiple model
 * turns, so this must run on a durable Node host rather than a short function.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { funnelBudgetState, recordGenerationCost } from '@/lib/ai/funnel-cost';
import { llmActionConfig, recordLlmUsage } from '@/lib/ai/llm';
import { missingGenerationPrerequisites } from '@/lib/discovery/generation-availability';
import { createJob, getJob, updateJob } from '@/lib/discovery/live-jobs';
import { isTransientPipelineFailure } from '@/lib/discovery/preview-failure';
import { previewUrlForClient } from '@/lib/discovery/local-preview-frame';
import { sendPreviewReadyEmail } from '@/lib/discovery/preview-ready-email';
import { readPreviewWorkspaceFiles } from '@/lib/discovery/preview-workspace';
import { createRenderedPreviewAudit } from '@/lib/discovery/rendered-preview-audit';
import { rememberClaimablePreview } from '@/lib/flowstarter/claim';
import {
  injectCalComPreviewDemoIntoScaffoldFiles,
  resolveTenantCalComUrl,
} from '@/lib/flowstarter/cal-com';
import { publishFunnelPreview } from '@/lib/hosting/preview-publisher';
import { buildSandboxStaticFiles } from '@/lib/hosting/sandbox-static-build';
import type {
  BusinessIntakePayload,
  PreviewPublisher,
  ScrapeCorpus,
  SiteValidator,
  TemplateScaffoldFile,
} from '@flowstarter/agentic-codegen';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const SpecSchema = z.object({
  businessName: z.string().max(200).optional().default(''),
  fullName: z.string().max(200).optional().default(''),
  /**
   * Where to send "your preview is ready". The intake has asked for this in
   * as many words since the wizard existed; it was simply never forwarded to
   * the route that knows when the preview is ready.
   *
   * Not `.email()`: a typo in one field must cost the email, not the whole
   * preview. `sendPreviewReadyEmail` declines to send to anything that does
   * not look like an address.
   */
  email: z.string().max(320).optional().default(''),
  description: z.string().min(1).max(5000),
  industry: z.string().max(200).optional().default(''),
  targetAudience: z.string().max(500).optional().default(''),
  goal: z.string().max(400).optional().default(''),
  brandTone: z.string().max(400).optional().default(''),
  // The wizard already collects these; without them the generated site ends
  // up with placeholder '#' social links and no sense of the person behind
  // the business.
  // Not .url(): an empty default would fail that check and reject the whole
  // request. socialTargets() validates scheme and host and drops anything
  // malformed, so a bad paste costs the profile link, not the preview.
  instagramUrl: z.string().max(300).optional().default(''),
  linkedinUrl: z.string().max(300).optional().default(''),
  /**
   * The wizard's page-count answer. It reaches the generator as part of the
   * intake and is the input to the page-set rule, which decides how many
   * pages the site may have. Without it every brief got the template's own
   * seven pages whatever it asked for.
   */
  pageCount: z
    .enum(['lt-5', '5-7', '8-15', '15+', 'unsure'])
    .optional()
    .default('unsure'),
  /** Dedicated Cal.com booking link from intake (per tenant). */
  calComUrl: z.string().max(400).optional().default(''),
  /** Free-text integrations; may still contain a cal.com URL as fallback. */
  customIntegrations: z.string().max(2000).optional().default(''),
});

/**
 * Only well-formed public profile URLs on the expected host are passed on;
 * `assertSafeBusinessIntake` re-checks scheme and host before any agent sees
 * them, so a malformed paste degrades to "no profile" rather than failing the
 * whole preview.
 */
function socialTargets(
  spec: z.infer<typeof SpecSchema>
): BusinessIntakePayload['socialMedia'] {
  const candidates: Array<{ platform: 'instagram' | 'linkedin'; raw: string }> =
    [
      { platform: 'instagram', raw: spec.instagramUrl },
      { platform: 'linkedin', raw: spec.linkedinUrl },
    ];
  const targets: BusinessIntakePayload['socialMedia'] = [];
  for (const { platform, raw } of candidates) {
    if (!raw.trim()) continue;
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.protocol !== 'https:') continue;
    if (host !== `${platform}.com` && !host.endsWith(`.${platform}.com`))
      continue;
    targets.push({
      platform,
      handle: url.pathname.split('/').filter(Boolean).pop()?.slice(0, 100),
      profileUrl: url.toString(),
      // No scrape is run here: the URL is a real link and evidence that the
      // profile exists, not a source we claim to have read.
      scraper: { provider: 'not-requested', status: 'pending' },
    });
  }
  return targets;
}

/**
 * The sigma classifier needs an ONNX runtime and a model directory that a
 * serverless target may not have. It is an optimisation, not a requirement:
 * when it cannot load, selection falls back to the model exactly as before.
 */
let classifierPromise: Promise<unknown> | undefined;
function loadTemplateClassifier(): Promise<unknown> {
  classifierPromise ??= (async () => {
    const dir = process.env.SIGMA_MODEL_DIR?.trim();
    if (!dir) return undefined;
    try {
      const { TemplateClassifier, MiniLmOnnxEmbedder } = await import(
        '@flowstarter/agentic-codegen/src/flowstarter/template-classifier'
      );
      return new TemplateClassifier(new MiniLmOnnxEmbedder(dir));
    } catch (error) {
      console.warn(
        `[Flowstarter] template classifier unavailable, using the model: ${
          error instanceof Error ? error.message : 'unknown'
        }`
      );
      return undefined;
    }
  })();
  return classifierPromise;
}

/**
 * The unlock link is injected into a site we hand to a client, so the teaser
 * refuses anything that is not HTTPS (or loopback in development). A LAN
 * address in NEXT_PUBLIC_SITE_URL is neither, and a misconfigured origin must
 * not cost a generation that has already run for minutes: return undefined and
 * the sections stay gated, just without a clickable CTA.
 */
function previewUnlockUrl(demoId: string): string | undefined {
  const raw =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:3000';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    console.warn(
      `[Flowstarter] NEXT_PUBLIC_SITE_URL (${url.origin}) cannot be used for the ` +
        'preview unlock link; gating the sections without a CTA'
    );
    return undefined;
  }
  return `${url.origin}/unlock/${demoId}`;
}

/**
 * The Pi model catalogue does not carry this one yet, so selecting it means
 * supplying the descriptor alongside the id.
 */
const GLM_53_FLASH = {
  id: 'z-ai/glm-5.3-flash',
  name: 'Z.ai: GLM 5.3 Flash',
  api: 'openai-completions',
  baseUrl: 'https://openrouter.ai/api/v1',
  provider: 'openrouter',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0.07, output: 0.25, cacheRead: 0.014, cacheWrite: 0 },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
  compat: { supportsDeveloperRole: false, thinkingFormat: 'openrouter' },
  thinkingLevelMap: { xhigh: 'xhigh' },
} as const;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

function buildPiEvidence(
  demoId: string,
  spec: z.infer<typeof SpecSchema>
): { intake: BusinessIntakePayload; corpus: ScrapeCorpus } {
  const submittedAt = new Date().toISOString();
  const targets = socialTargets(spec);
  const intake: BusinessIntakePayload = {
    projectId: demoId,
    business: {
      name: spec.businessName.trim(),
      niche: spec.industry.trim() || 'Service business',
      location: 'Not provided',
      description: spec.description.trim(),
      targetAudience: spec.targetAudience.trim() || undefined,
      primaryGoal: spec.goal.trim() || undefined,
      pageCount: spec.pageCount,
    },
    socialMedia: targets,
    locale: 'en',
    submittedAt,
    // Consent is recorded only when the client volunteered a profile URL in
    // their own intake form, and only then are any targets attached. Nothing
    // is scraped from them here — the URL becomes a link on the client's own
    // site — but the guard treats profiles as personal data either way, and
    // claiming consent nobody gave would be the wrong way to satisfy it.
    consent: {
      publicProfileAnalysis: targets.length > 0,
      acceptedAt: targets.length > 0 ? submittedAt : '',
    },
  };
  const corpus: ScrapeCorpus = {
    projectId: demoId,
    completedAt: submittedAt,
    documents: [
      {
        sourceId: 'intake-description',
        platform: 'intake',
        kind: 'intake_answer',
        text: [
          `Business: ${spec.businessName.trim()}`,
          `Industry: ${spec.industry.trim() || 'Not provided'}`,
          `Description: ${spec.description.trim()}`,
          `Audience: ${spec.targetAudience.trim() || 'Not provided'}`,
          `Goal: ${spec.goal.trim() || 'Not provided'}`,
          `Desired tone: ${spec.brandTone.trim() || 'Not provided'}`,
        ].join('\n'),
      },
    ],
    images: [],
  };
  return { intake, corpus };
}

/**
 * Where the vetted template sources (and their pre-installed node_modules)
 * live on disk. Shared between the local `astro dev` fallback below and the
 * dist build: both need the same dependency tree, and only one should decide
 * where to find it.
 */
function templateRootDir(): string {
  return (
    process.env.FLOWSTARTER_TEMPLATE_ROOT?.trim() ||
    resolve(process.cwd(), '../flowstarter-templates')
  );
}

/** Export only a successful sandbox build. Local app credentials never enter tenant code. */
async function buildPreviewDist(
  sandboxId: string,
  files: readonly TemplateScaffoldFile[]
): Promise<TemplateScaffoldFile[] | undefined> {
  try {
    return (await buildSandboxStaticFiles(sandboxId, files)).map((file) => ({
      ...file,
      type: 'file' as const,
    }));
  } catch {
    console.warn(
      '[Flowstarter] sandbox static compilation failed; preview was not published'
    );
    return undefined;
  }
}

async function reserveLocalPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) =>
        error || port === 0
          ? reject(error ?? new Error('No local preview port'))
          : resolvePort(port)
      );
    });
  });
}

async function publishLocalPreview(input: {
  projectId: string;
  templateSlug: string;
  workspaceRoot: string;
}): Promise<{
  previewUrl: string;
  artifactUrl: string;
  localRoot: string;
  teardown: () => Promise<void>;
}> {
  if (process.env.FLOWSTARTER_LOCAL_PREVIEW !== 'true') {
    throw new Error('Local preview publishing is disabled');
  }
  const dependencies = resolve(
    templateRootDir(),
    input.templateSlug,
    'node_modules'
  );
  const localParent = join(tmpdir(), 'flowstarter-local-previews');
  const localRoot = join(localParent, input.projectId);
  await mkdir(localParent, { recursive: true });
  await rm(localRoot, { recursive: true, force: true });
  await cp(input.workspaceRoot, localRoot, { recursive: true });
  await symlink(dependencies, join(localRoot, 'node_modules'), 'dir');

  const port = await reserveLocalPort();
  const astroCli = resolve(dependencies, '.bin', 'astro');
  const child = spawn(
    astroCli,
    ['dev', '--host', '0.0.0.0', '--port', String(port)],
    {
      cwd: localRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    }
  );
  let launchOutput = '';
  const captureLaunchOutput = (chunk: Buffer) => {
    launchOutput = `${launchOutput}${chunk.toString('utf8')}`.slice(-4_000);
  };
  child.stdout?.on('data', captureLaunchOutput);
  child.stderr?.on('data', captureLaunchOutput);
  const teardown = async () => {
    if (!child.killed) child.kill('SIGTERM');
    await rm(localRoot, { recursive: true, force: true });
  };

  let ready = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Astro is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  if (!ready) {
    await teardown();
    const diagnostic = launchOutput.trim().replace(/\s+/g, ' ').slice(-1_000);
    throw new Error(
      `Local preview server did not become ready${
        diagnostic ? `: ${diagnostic}` : ''
      }`
    );
  }

  const host =
    process.env.FLOWSTARTER_LOCAL_PREVIEW_HOST?.trim() || '127.0.0.1';
  return {
    previewUrl: `http://${host}:${port}`,
    artifactUrl: `local://${localRoot}`,
    localRoot,
    teardown,
  };
}

/**
 * One line per finished job, machine-readable, so reliability is a grep over
 * the server log rather than a memory: status, where it failed, how long it
 * took, what it cost in tokens. The job store forgets after 45 minutes; this
 * does not.
 */
function logPreviewOutcome(
  demoId: string,
  status: 'ready' | 'failed',
  detail: {
    error?: string;
    failedPhase?: string;
    tokensUsed?: number;
    template?: string;
  }
): void {
  const job = getJob(demoId);
  console.info(
    '[preview-outcome] ' +
      JSON.stringify({
        demoId,
        status,
        seconds: job ? Math.round((Date.now() - job.createdAt) / 1000) : null,
        phases: job?.phases ?? [],
        ...detail,
      })
  );
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ skip: true }, { status: 200 });
  }
  const parsed = SpecSchema.safeParse(body);
  if (!parsed.success || !parsed.data.businessName.trim()) {
    return NextResponse.json({ skip: true }, { status: 200 });
  }

  // Generation cannot run at all without Pi, the MCP template library and
  // Daytona configured, which is the case in production today (see
  // docs/production-generation.md). Checked before a job exists, not after,
  // so the visitor is told the honest thing (their preview will be built by
  // hand and emailed) instead of watching a job that was never going to
  // finish. `reason: 'not-configured'` is what the wizard reads to tell this
  // apart from a budget-blocked or malformed-intake skip.
  const missingPrerequisites = missingGenerationPrerequisites();
  if (missingPrerequisites.length > 0) {
    console.warn(
      `[Flowstarter] preview generation is not configured in this environment; missing: ${missingPrerequisites.join(
        ', '
      )}`
    );
    return NextResponse.json(
      { skip: true, reason: 'not-configured' },
      { status: 200 }
    );
  }

  // Budget kill-switch: over the monthly cap → deterministic demo instead.
  // Over the soft threshold → 'degrade' so the orchestrator runs in lite mode
  // (single Kimi pass, no Sonnet brain) to keep spending bounded.
  let budgetState: 'ok' | 'degrade' | 'blocked' = 'ok';
  try {
    const budget = await funnelBudgetState();
    if (budget.state === 'blocked') {
      return NextResponse.json({ skip: true }, { status: 200 });
    }
    budgetState = budget.state;
  } catch {
    /* fail-safe: continue */
  }

  const demoId = randomUUID();
  createJob(demoId);
  const ip = clientIp(req);
  const spec = parsed.data;

  // Parked on the job, not passed down through the generator: the pipeline has
  // no business knowing the visitor's address, and the only thing that needs
  // it is the notification fired when this job turns ready.
  updateJob(demoId, {
    ...(spec.email.trim() ? { leadEmail: spec.email.trim() } : {}),
    ...(spec.fullName.trim() ? { leadName: spec.fullName.trim() } : {}),
    ...(spec.businessName.trim()
      ? { businessName: spec.businessName.trim() }
      : {}),
  });

  // A generation that never settles is as bad as one that fails outright —
  // the wizard just polls a 'building' status forever. Imagery-enabled runs
  // have taken ~13-14 min; this gives real headroom before declaring one
  // hung. Cleared in `finally` below on every real outcome.
  const GENERATION_WATCHDOG_MS = 20 * 60_000;
  // A restart is only worth it while a second full run still fits under the
  // watchdog. Past this the visitor gets the plainer demo now instead of the
  // same failure at minute twenty.
  const RESTART_DEADLINE_MS = 4 * 60_000;
  // A failure before personalization started has thrown little away, so it
  // is worth a restart for longer: the rerun still fits under the deadline.
  const EARLY_RESTART_DEADLINE_MS = 8 * 60_000;
  const EARLY_PHASE = /^(Learning|Choosing|Preparing)/;
  // Every model session of this job must finish before this; the session
  // runner caps each attempt at what is left, so retries cannot stack past
  // the watchdog. The gap after it is for publishing and bookkeeping.
  const RUN_DEADLINE_MS = 16 * 60_000;
  const watchdog = setTimeout(() => {
    const job = getJob(demoId);
    if (job && job.status === 'building') {
      void job.teardown?.().catch(() => {});
      updateJob(demoId, {
        status: 'failed',
        error: 'Preview generation timed out',
        ...(job.phase ? { failedPhase: job.phase } : {}),
        teardown: undefined,
      });
      logPreviewOutcome(demoId, 'failed', {
        error: 'Preview generation timed out',
        ...(job.phase ? { failedPhase: job.phase } : {}),
      });
    }
  }, GENERATION_WATCHDOG_MS);
  watchdog.unref?.();

  // Detached: do NOT await. The wizard polls GET while the Pi agent analyzes
  // the brand, selects an approved MCP template, edits only its isolated
  // workspace, validates it, and publishes the result to Daytona.
  void (async () => {
    let closeLibrary: (() => Promise<void>) | undefined;
    try {
      const {
        FlowstarterMcpTemplateLibrary,
        PiSdkFlowstarterAgents,
        PreviewGenerationPipeline,
      } = await import('@flowstarter/agentic-codegen');
      const { previewInSandbox } = await import('@flowstarter/daytona-utils');

      const piApiKey =
        process.env.PI_API_KEY?.trim() ||
        process.env.OPENROUTER_API_KEY?.trim();
      const mcpUrl = process.env.FLOWSTARTER_MCP_URL?.trim();
      const mcpToken = process.env.FLOWSTARTER_MCP_INTERNAL_TOKEN?.trim();
      if (!piApiKey || !mcpUrl || !mcpToken || !process.env.DAYTONA_API_KEY) {
        updateJob(demoId, {
          status: 'failed',
          error: 'Pi preview infrastructure is not configured',
        });
        return;
      }

      // The preview pass carries the bulk of the tokens and all of the wall
      // clock, so it gets its own tier: a fast, large-context model that can
      // hold the whole template. The previous single-tier config ran at
      // thinkingLevel 'low', where this family reliably returns without
      // writing a file, and capped every call at 240s — shorter than the
      // personalization actually takes, so the funnel timed out mid-pass.
      const previewModel =
        process.env.PI_PREVIEW_MODEL?.trim() || GLM_53_FLASH.id;
      const previewThinkingLevel = z
        .enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        .parse(process.env.PI_PREVIEW_THINKING_LEVEL?.trim() || 'medium');
      const baseModel = process.env.PI_MODEL?.trim() || 'z-ai/glm-5.2';
      // The last attempt of a failing session runs on another model family.
      // Brand analysis and template selection fall over to the flash tier
      // (it already holds the whole template for the preview pass, so a JSON
      // brief is well within it); the preview pass falls over to the base
      // model unless the operator names something else.
      const previewFallback =
        process.env.PI_PREVIEW_FALLBACK_MODEL?.trim() || baseModel;
      const runDeadlineAt =
        (getJob(demoId)?.createdAt ?? Date.now()) + RUN_DEADLINE_MS;
      const agents = new PiSdkFlowstarterAgents({
        provider: process.env.PI_PROVIDER?.trim() || 'openrouter',
        modelId: baseModel,
        apiKey: piApiKey,
        thinkingLevel: 'medium',
        timeoutMs: 420_000,
        deadlineAt: runDeadlineAt,
        ...(baseModel === GLM_53_FLASH.id
          ? {}
          : {
              fallbackModelId: GLM_53_FLASH.id,
              fallbackModelOverride: GLM_53_FLASH,
            }),
        // Whole-preview token ceiling, from the same budget config the AI-SDK
        // wrapper uses. Breaching it aborts the pipeline; the catch below
        // fails the job open to the deterministic demo.
        maxRunTokens: llmActionConfig('preview_generate').maxTokens,
        // Anonymous funnel traffic: no workspace or project yet, so the ledger
        // row carries nulls. Never awaited — accounting must not slow a build.
        usageSink: (usage) => {
          void recordLlmUsage({
            workspaceId: null,
            projectId: null,
            action: usage.action,
            model: usage.model,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            cachedTokens: usage.cachedTokens,
          });
        },
        roles: {
          // A JSON brief and a template pick are short turns. Capping them at
          // four minutes keeps a stalled stream inside the window the session
          // runner will retry, and its last attempt then runs on the flash
          // fallback instead of waiting seven minutes to fail.
          brand: { timeoutMs: 240_000 },
          templateSelection: { timeoutMs: 240_000 },
          preview: {
            modelId: previewModel,
            thinkingLevel: previewThinkingLevel,
            ...(previewModel === GLM_53_FLASH.id
              ? { modelOverride: GLM_53_FLASH }
              : {}),
            ...(previewFallback !== previewModel
              ? {
                  fallbackModelId: previewFallback,
                  ...(previewFallback === GLM_53_FLASH.id
                    ? { fallbackModelOverride: GLM_53_FLASH }
                    : {}),
                }
              : {}),
            maxOutputTokens: 30_000,
            timeoutMs: 600_000,
          },
        },
      });
      const library = new FlowstarterMcpTemplateLibrary({
        endpoint: mcpUrl,
        internalToken: mcpToken,
      });
      closeLibrary = () => library.close();

      const validator: SiteValidator = {
        validate: async (workspaceRoot, phase) => {
          if (phase !== 'preview')
            throw new Error('Unexpected validation phase');
          const files = await readPreviewWorkspaceFiles(workspaceRoot);
          const paths = new Set(files.map((file) => file.path));
          if (!paths.has('package.json'))
            throw new Error('Selected template has no package manifest');
          if (!Array.from(paths).some((path) => path.startsWith('src/')))
            throw new Error('Selected template has no source files');
          const manifest = JSON.parse(
            files.find((file) => file.path === 'package.json')?.content ?? '{}'
          ) as { scripts?: Record<string, unknown> };
          if (!manifest.scripts?.dev && !manifest.scripts?.start)
            throw new Error('Selected template has no preview command');
        },
      };

      // Set inside publisher.publish, once the workspace that produced
      // `result.files` has a Daytona sandbox or local `astro dev` server up.
      // publisher.publish's workspaceRoot is removed the instant pipeline.run()
      // returns (PreviewGenerationPipeline's finally), so this is the only
      // window in which the compiled dist/ output can be produced at all —
      // it cannot be deferred to after `runPipeline()` resolves below.
      let compiledPreviewFiles: TemplateScaffoldFile[] | undefined;

      const publisher: PreviewPublisher = {
        publish: async (input) => {
          const files = await readPreviewWorkspaceFiles(input.workspaceRoot);
          const preview = await previewInSandbox(input.workspaceRoot, {
            projectId: input.projectId,
            env: { DAYTONA_API_KEY: process.env.DAYTONA_API_KEY },
            onProgress: () =>
              updateJob(demoId, { phase: 'Publishing your live preview' }),
          });
          if (!preview.success || !preview.previewUrl || !preview.sandboxId) {
            await preview.teardown().catch(() => {});
            if (process.env.FLOWSTARTER_LOCAL_PREVIEW === 'true') {
              try {
                const local = await publishLocalPreview({
                  projectId: input.projectId,
                  templateSlug: input.template.slug,
                  workspaceRoot: input.workspaceRoot,
                });
                // Recorded here (not off the orchestrator result, which only
                // keeps the sandbox fields) so the edit loop can target the
                // local workspace when there is no sandbox behind the preview.
                updateJob(demoId, { localRoot: local.localRoot });
                // A local dev preview is never permission to compile tenant code on the app host.
                compiledPreviewFiles = undefined;
                return { ...local, files };
              } catch (localError) {
                throw new Error(
                  `${
                    preview.error ?? 'Preview sandbox unavailable'
                  }; local fallback: ${
                    localError instanceof Error
                      ? localError.message
                      : 'unknown error'
                  }`
                );
              }
            }
            throw new Error(preview.error ?? 'Preview sandbox unavailable');
          }
          compiledPreviewFiles = await buildPreviewDist(
            preview.sandboxId,
            files
          );
          return {
            previewUrl: preview.previewUrl,
            artifactUrl: `daytona://${preview.sandboxId}`,
            files,
            sandboxId: preview.sandboxId,
            teardown: preview.teardown,
          };
        },
      };

      // The funnel gets the same pipeline the scenarios do. Without these the
      // visitor's preview is a plainer site than the one this project has
      // been reviewed on: no deterministic template pick, no honesty sweep,
      // and no gated sections to convert against.
      const pipeline = new PreviewGenerationPipeline(
        agents,
        library,
        validator,
        publisher,
        (await loadTemplateClassifier()) as never,
        {
          // Editable content and style tokens are already inlined. Keep the
          // remaining template behind bounded reads instead of sending every
          // component again on each model turn.
          fullTemplateContext: false,
          qualitySweep: true,
          // Generous on purpose: the visitor sees most of the home page and
          // every section's heading, and pays for the substance behind them.
          renderedAudit: createRenderedPreviewAudit(),
          teaser: {
            keepHomeSections: 6,
            keepSubpageSections: 3,
            minLockedSections: 2,
            revealTop: 0.35,
            label: 'Part of your full site',
            ...(previewUnlockUrl(demoId)
              ? {
                  unlockUrl: previewUnlockUrl(demoId),
                  unlockLabel: 'Unlock the full site',
                }
              : {}),
          },
        }
      );
      const evidence = buildPiEvidence(demoId, spec);
      const runPipeline = () =>
        pipeline.run({
          ...evidence,
          cachedAssets: [],
          // Soft budget threshold: the pipeline skips brief-generated imagery
          // (and any other optional spend) when the funnel is over it.
          budgetDegraded: budgetState === 'degrade',
          // Rule 5 of the page set: a booking page exists only for a booking
          // link that already passed `resolveTenantCalComUrl`. The same
          // resolver the demo injection uses, so the page set and the embed
          // can never disagree about whether this workspace books calls.
          hasBookingLink: Boolean(
            resolveTenantCalComUrl({
              calComUrl: spec.calComUrl,
              customIntegrations: spec.customIntegrations,
            })
          ),
          deadlineAt: runDeadlineAt,
          onPhase: (phase) => updateJob(demoId, { phase }),
        });
      let result: Awaited<ReturnType<typeof runPipeline>>;
      try {
        result = await runPipeline();
      } catch (firstError) {
        // The session runner has already retried inside each stage. What
        // reaches here is a stage that stayed down, or a publish step that
        // could not get a server up. One clean restart from the top, on the
        // same run budget, is the last thing tried before the visitor is
        // shown the plainer demo. Never for a budget breach or a bad intake.
        if (!isTransientPipelineFailure(firstError)) throw firstError;
        const job = getJob(demoId);
        const elapsed = Date.now() - (job?.createdAt ?? Date.now());
        const early = EARLY_PHASE.test(job?.phase ?? '');
        if (elapsed > (early ? EARLY_RESTART_DEADLINE_MS : RESTART_DEADLINE_MS))
          throw firstError;
        console.warn(
          `[Flowstarter] preview ${demoId} restarting after a transient failure: ${
            firstError instanceof Error ? firstError.message : 'unknown'
          }`
        );
        updateJob(demoId, { phase: 'Starting over after a provider hiccup' });
        result = await runPipeline();
      }

      // Preview never loads the live Cal.com embed — only a blurred demo.
      // The tenant URL is stashed for claim → workspaces.cal_com_url and wired
      // on the paid full-site build.
      const calComUrl = resolveTenantCalComUrl({
        calComUrl: spec.calComUrl,
        customIntegrations: spec.customIntegrations,
      });
      const filesWithCal = injectCalComPreviewDemoIntoScaffoldFiles(
        result.files
      );

      // The watchdog may already have failed this job while the pipeline was
      // still running; a late success must not resurrect it under a visitor
      // who has long since been shown the plainer demo.
      if (getJob(demoId)?.status === 'failed') {
        await result.teardown?.().catch(() => {});
        return;
      }

      // Wire the teardown in the instant the sandbox/local `astro dev` child
      // is confirmed live, not after the awaited bookkeeping below. Before
      // this fix, a throw from `rememberClaimablePreview` (or anything else
      // between here and the final `updateJob`) orphaned an already-running
      // process with no handle anywhere in the job store to close it —
      // the catch block only ever set `status: 'failed'`.
      updateJob(demoId, {
        previewUrl: result.previewUrl,
        sandboxId: result.sandboxId,
        teardown: result.teardown,
      });

      // The manifest, brand config and template exist only in this process:
      // the browser is handed a URL, never the files. Stash them against the
      // demo id so that if the visitor signs in and claims this preview
      // (/api/flowstarter/projects/claim) the workspace is built from the
      // exact site they were looking at, rather than a regenerated guess.
      await rememberClaimablePreview({
        previewId: demoId,
        intake: evidence.intake,
        brandConfig: result.brandConfig,
        template: result.template,
        files: filesWithCal,
        ...(calComUrl ? { calComUrl } : {}),
        ...(result.artifactUrl
          ? { previewArtifactUrl: result.artifactUrl }
          : {}),
        ...(result.previewUrl ? { previewUrl: result.previewUrl } : {}),
      });

      // The same moment, the durable half: package the site (noindex injected
      // into every HTML file) and push it to the PREVIEWS deploy-agent, which
      // is a different agent on a different port with a different secret and
      // its own Caddy — a malformed generated preview can break previews and
      // nothing a customer paid for. Never blocks the wizard: the sandbox URL
      // above is what the iframe shows, and the hosted one is reported
      // alongside it once (if) it comes up.
      //
      // `files` (source) is what makes the preview claimable; the previews
      // Caddy is static and can only serve `builtFiles`, the compiled dist/
      // output from buildPreviewDist. When the build failed or never ran,
      // `builtFiles` is undefined and publishFunnelPreview falls back to
      // `files` — which has no root index.html, so it refuses to deploy a
      // source-only archive rather than pushing raw Astro source to Caddy.
      void publishFunnelPreview({
        previewId: demoId,
        files: filesWithCal as Array<{ path: string; content: string }>,
        builtFiles: compiledPreviewFiles as
          | Array<{ path: string; content: string; encoding?: 'base64' }>
          | undefined,
        templateSlug: result.template?.slug ?? null,
        brandConfig: result.brandConfig,
      })
        .then((published) => {
          updateJob(demoId, {
            hostedPreviewStatus: published.status,
            ...(published.status === 'live'
              ? {
                  hostedPreviewUrl: published.url,
                  hostedPreviewExpiresAt: published.expiresAt,
                }
              : {}),
          });
          if (published.status !== 'live') {
            console.warn(
              `[Flowstarter] preview ${demoId} was not hosted: ${
                published.detail ?? 'unknown reason'
              }`
            );
          }
        })
        .catch((error) => {
          updateJob(demoId, { hostedPreviewStatus: 'failed' });
          console.warn(
            `[Flowstarter] preview ${demoId} could not be published to the ` +
              'previews host: ' +
              (error instanceof Error ? error.message : 'unknown error')
          );
        });

      updateJob(demoId, {
        status: 'ready',
        personalized: true,
        phase: 'Done, your site is ready',
      });
      // The visitor was asked where to send this. Awaited rather than detached
      // so the outcome is in the same log line ordering as the rest of the
      // job; it cannot throw and it cannot fail the preview.
      const previewEmail = await sendPreviewReadyEmail(demoId);
      if (previewEmail !== 'sent' && previewEmail !== 'no_email') {
        console.warn(
          `[Flowstarter] preview ${demoId} is ready but the visitor was not ` +
            `emailed: ${previewEmail}`
        );
      }
      logPreviewOutcome(demoId, 'ready', {
        tokensUsed: agents.tokensUsed,
        template: result.template?.slug,
      });
      await recordGenerationCost({
        kind: 'codegen',
        model: process.env.PI_MODEL?.trim() || 'z-ai/glm-5.2',
        demoId,
        ip,
        // Brief-generated imagery is the one spend the Pi usage sink does not
        // see; without this the funnel cap never learns about it.
        ...(result.generatedAssetsCostUsd > 0
          ? { costUsd: result.generatedAssetsCostUsd }
          : {}),
      }).catch(() => {});
    } catch (e) {
      // A failed job has no further use for a sandbox or local `astro dev`
      // child it already provisioned — tear it down now rather than leaving
      // it for the 45-minute reaper (or, worse, forever, if nothing calls
      // that reaper). Best-effort: a teardown that itself fails must not
      // stop the job from being reported as failed.
      await getJob(demoId)
        ?.teardown?.()
        .catch(() => {});
      const failedPhase = getJob(demoId)?.phase;
      updateJob(demoId, {
        status: 'failed',
        error: e instanceof Error ? e.message : 'live demo error',
        ...(failedPhase ? { failedPhase } : {}),
        teardown: undefined,
      });
      logPreviewOutcome(demoId, 'failed', {
        error: e instanceof Error ? e.message : 'live demo error',
        ...(failedPhase ? { failedPhase } : {}),
      });
    } finally {
      clearTimeout(watchdog);
      await closeLibrary?.().catch(() => {});
    }
  })();

  return NextResponse.json({ demoId, status: 'building' }, { status: 200 });
}

export async function GET(req: NextRequest) {
  // Prewarm path: load the heavy codegen + sandbox module graph into this
  // container so the first real visitor doesn't pay the multi-second import
  // cost. No generation runs, no AI/Daytona calls are made — we only resolve
  // the dynamic imports the POST handler depends on. It was written for the
  // Netlify scheduled prewarm function, which is gone: the prod slot is a
  // long-lived container, so it pays this import once at start rather than per
  // cold start. Kept because it is free, idempotent, and still useful to call
  // by hand after a redeploy.
  if (req.nextUrl.searchParams.get('warm') === '1') {
    try {
      await Promise.all([
        import('@flowstarter/agentic-codegen'),
        import('@flowstarter/daytona-utils'),
      ]);
      return NextResponse.json({ warmed: true }, { status: 200 });
    } catch {
      return NextResponse.json({ warmed: false }, { status: 200 });
    }
  }

  const demoId = req.nextUrl.searchParams.get('demoId');
  if (!demoId)
    return NextResponse.json({ error: 'demoId required' }, { status: 400 });
  const job = getJob(demoId);
  if (!job)
    return NextResponse.json(
      { status: 'failed', error: 'unknown demo' },
      { status: 200 }
    );
  return NextResponse.json(
    {
      status: job.status,
      phase: job.phase,
      personalized: job.personalized ?? false,
      previewUrl:
        job.status === 'ready'
          ? previewUrlForClient(demoId, job.previewUrl)
          : undefined,
      // Both, deliberately: the sandbox URL is what the iframe renders, the
      // hosted one is the durable, shareable copy on the previews host — and
      // it is only ever present once that host reported the site live.
      hostedPreviewUrl: job.hostedPreviewUrl,
      hostedPreviewStatus: job.hostedPreviewStatus,
      // The hosted copy is temporary and the visitor is told so at the same
      // moment they are given the link, never afterwards.
      hostedPreviewExpiresAt: job.hostedPreviewExpiresAt,
      editsUsed: job.editsUsed,
      error: job.status === 'failed' ? job.error : undefined,
      failedPhase: job.status === 'failed' ? job.failedPhase : undefined,
    },
    { status: 200 }
  );
}
