/**
 * POST /api/discovery/preview/live/edit  — apply one plain-English prompt to
 *   the live sandbox site (the T3-Code-style 15-prompt loop). Detached; the
 *   wizard polls GET. Server-enforced cap.
 * GET  ?demoId=…  — poll the current edit's status/phase.
 *
 * Reuses the demo's already-running Daytona sandbox (agent + astro dev are
 * live); HMR reflects the change in the embedded preview. Node host only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { join } from 'node:path';
import { z } from 'zod';
import { recordGenerationCost } from '@/lib/ai/funnel-cost';
import { getJob, updateJob, LIVE_EDIT_CAP } from '@/lib/discovery/live-jobs';
import { readPreviewWorkspaceFiles } from '@/lib/discovery/preview-workspace';
import { recordClaimablePreviewEdit } from '@/lib/flowstarter/claim';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const EditSchema = z.object({
  demoId: z.string().min(1),
  instruction: z.string().min(1).max(2000),
});

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

/**
 * Re-capture the edited preview workspace as the manifest of record.
 *
 * Only the local-preview path can do this today: the Daytona path's files live
 * inside the sandbox and there is no read-back seam here to pull them through.
 * That is not a silent gap — a sandbox preview's edits still reach the build,
 * because the edit is recorded on the build payload as `previewIntent` and the
 * worker both instructs its agent to preserve it and fails the job when the
 * built output has dropped it. Seeding is the stronger of the two and is used
 * wherever the code allows it; the instruction-plus-check is the floor.
 */
async function captureFreeEditIntoManifest(
  demoId: string,
  localRoot: string | undefined,
  instruction: string
): Promise<void> {
  if (!localRoot) return;
  try {
    const files = await readPreviewWorkspaceFiles(localRoot);
    await recordClaimablePreviewEdit({ previewId: demoId, instruction, files });
  } catch (error) {
    console.warn(
      `[Flowstarter] preview ${demoId} could not be re-captured after an edit:`,
      error instanceof Error ? error.message : error
    );
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }
  const { demoId, instruction } = parsed.data;
  const job = getJob(demoId);

  // A preview is editable behind either a Daytona sandbox or (in
  // FLOWSTARTER_LOCAL_PREVIEW mode) the local on-disk workspace.
  if (!job || job.status !== 'ready' || (!job.sandboxId && !job.localRoot)) {
    return NextResponse.json({ error: 'demo not ready' }, { status: 409 });
  }
  if (job.editStatus === 'editing') {
    return NextResponse.json({ error: 'edit in progress' }, { status: 409 });
  }
  if (job.editsUsed >= LIVE_EDIT_CAP) {
    return NextResponse.json(
      { limitReached: true, editsUsed: job.editsUsed, editsLeft: 0 },
      { status: 200 }
    );
  }

  // Fast content edits run Kimi+Haiku over OpenRouter; structural edits use the
  // autonomous Claude agent (ANTHROPIC_API_KEY). Require at least OpenRouter.
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!openRouterKey) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  updateJob(demoId, {
    editStatus: 'editing',
    editPhase: 'Reading your request',
    editError: undefined,
  });
  const ip = clientIp(req);

  // Detached — wizard polls GET while the agent edits in the sandbox.
  void (async () => {
    try {
      // Classify: structural prompts (new pages/components/layout/interactive
      // code) need the autonomous agent; everything else (copy/palette/section
      // text — the common case) takes the fast single-shot path (~seconds).
      const structural =
        /\b(add|new|create|build|insert)\b[\s\S]*\b(page|route|component|form that|integration|api|backend|animation|carousel|slider|interactive|javascript|script|booking|calendar|map|gallery|video)\b/i.test(
          instruction
        ) ||
        /\b(re-?structure|re-?layout|re-?build|rework the (layout|structure)|new layout|change the layout|add a page|new page)\b/i.test(
          instruction
        );
      const repoRoot = join(process.cwd(), '..', '..');
      const { fastEditInSandbox, editSiteInSandbox } = await import(
        '@flowstarter/daytona-utils'
      );

      let r: {
        ok: boolean;
        error?: string;
        costUsd?: number;
        tokensIn?: number;
        tokensOut?: number;
      };
      let editModel: string;
      if (structural) {
        // Autonomous multi-file change — needs the Claude Agent SDK and a
        // sandbox to run it in. Fails open (the visitor just retries) when
        // either is missing.
        if (!anthropicApiKey || !job.sandboxId) {
          updateJob(demoId, {
            editStatus: 'failed',
            editError: 'structural edits unavailable',
          });
          return;
        }
        editModel = 'claude-sonnet-4-6';
        updateJob(demoId, { editPhase: 'Planning a structural change' });
        r = await editSiteInSandbox(job.sandboxId!, instruction, {
          anthropicApiKey,
          model: editModel,
          env: { DAYTONA_API_KEY: process.env.DAYTONA_API_KEY },
          onProgress: (e) =>
            updateJob(demoId, {
              editPhase: e.detail ? `${e.phase}: ${e.detail}` : e.phase,
            }),
        });
      } else {
        // Fast content edit: Kimi implements, Haiku critic checks, 1 retry.
        editModel = 'moonshotai/kimi-k2.6';
        updateJob(demoId, { editPhase: 'Applying your change' });
        const runnerPath = join(
          repoRoot,
          'packages/agentic-codegen/sandbox/fast-edit-runner.mjs'
        );
        if (job.sandboxId) {
          r = await fastEditInSandbox(job.sandboxId, instruction, {
            openRouterKey,
            runnerPath,
            model: editModel,
            criticModel: 'anthropic/claude-haiku-4.5',
            env: { DAYTONA_API_KEY: process.env.DAYTONA_API_KEY },
          });
        } else {
          // Local preview: same runner, run against the on-disk workspace the
          // local `astro dev` serves — HMR shows the change the same way.
          const { fastEditLocal } = await import(
            '@/lib/discovery/local-fast-edit'
          );
          r = await fastEditLocal(job.localRoot!, instruction, {
            openRouterKey,
            runnerPath,
            contentRel: job.contentRel,
            model: editModel,
            criticModel: 'anthropic/claude-haiku-4.5',
          });
        }
      }

      await recordGenerationCost({
        kind: 'edit',
        model: editModel,
        usage: { inputTokens: r.tokensIn ?? 0, outputTokens: r.tokensOut ?? 0 },
        costUsd: r.costUsd,
        demoId,
        ip,
      }).catch(() => {});

      if (r.ok) {
        // The change is on disk and the visitor can see it. It is not yet on
        // the *record*: the claimable manifest still holds the files the
        // generator first wrote, and that manifest is what a claim copies into
        // the artifacts row the paid build seeds its worktree from. Re-read the
        // workspace and re-stash it, so "the site I approved" and "the site the
        // build starts from" are the same bytes. Best effort by construction —
        // a failure here must not tell the visitor their applied edit failed.
        await captureFreeEditIntoManifest(demoId, job.localRoot, instruction);
        const cur = getJob(demoId);
        updateJob(demoId, {
          editStatus: 'done',
          editPhase: 'Applied',
          editsUsed: (cur?.editsUsed ?? job.editsUsed) + 1,
        });
      } else {
        updateJob(demoId, {
          editStatus: 'failed',
          editError: r.error ?? 'edit failed',
        });
      }
    } catch (e) {
      updateJob(demoId, {
        editStatus: 'failed',
        editError: e instanceof Error ? e.message : 'edit failed',
      });
    }
  })();

  return NextResponse.json(
    {
      accepted: true,
      editsUsed: job.editsUsed,
      editsLeft: LIVE_EDIT_CAP - job.editsUsed,
    },
    { status: 200 }
  );
}

export async function GET(req: NextRequest) {
  const demoId = req.nextUrl.searchParams.get('demoId');
  if (!demoId) {
    return NextResponse.json({ error: 'demoId required' }, { status: 400 });
  }
  const job = getJob(demoId);
  if (!job) {
    return NextResponse.json({ error: 'unknown demo' }, { status: 404 });
  }
  return NextResponse.json(
    {
      editStatus: job.editStatus ?? 'idle',
      editPhase: job.editPhase,
      editError: job.editStatus === 'failed' ? job.editError : undefined,
      editsUsed: job.editsUsed,
      editsLeft: Math.max(0, LIVE_EDIT_CAP - job.editsUsed),
    },
    { status: 200 }
  );
}
