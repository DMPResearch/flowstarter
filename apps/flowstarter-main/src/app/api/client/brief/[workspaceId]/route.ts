import 'server-only';
/**
 * The in-depth brief: the material a build is actually made from.
 *
 * The intake asks a handful of questions before the preview. Everything a
 * generator needs to write true sentences about a real business arrives after
 * the deposit, on the client's own dashboard, and lands here.
 *
 * GET: the brief as it stands, what is still missing, and the workspace's
 *        files so the form can show thumbnails for the ids it holds.
 * PUT: the whole brief at once, validated, then written, then re-judged.
 *
 * Both handlers call `requireWorkspaceAccess` first, before the body is read
 * and before a query runs. Everything underneath uses the service-role client,
 * which bypasses RLS, so that check is the entire tenant boundary. The table
 * itself is select-for-members and write-for-service-role, which is exactly
 * why this route exists rather than a client-side Supabase call.
 *
 * No model is involved at any point. `evaluateBriefReadiness` is a pure rule
 * and this route is the only thing that turns its verdict into `ready_at`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import {
  BRIEF_ROW_COLUMNS,
  briefViewFromRow,
  judgeBrief,
  photosFor,
  portraitFrom,
  type BriefProjectView,
  type BriefRow,
  type BriefView,
} from '@/lib/flowstarter/brief-data';
import {
  evaluateBriefReadiness,
  type BriefReadiness,
} from '@/lib/flowstarter/brief-readiness';
import {
  enqueueBuildOnBriefReady,
  type BriefReadyOutcome,
} from '@/lib/flowstarter/deposit-workflow';
import { withTenant } from '@/lib/tenancy';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  AssetUploadError,
  listWorkspaceAssets,
  recordAssetEvent,
  type ClientAsset,
} from '../../assets/asset-storage';

/** Reads and writes one tenant's rows; never statically rendered. */
export const dynamic = 'force-dynamic';

// ───────────────────────────────────────────────────────────────────────────
// The JSON contract
// ───────────────────────────────────────────────────────────────────────────

export interface BriefResponse {
  brief: BriefView;
  readiness: BriefReadiness;
  assets: ClientAsset[];
  /**
   * What saving this brief did to the build, when it did anything.
   *
   * Present on PUT only, and only once the brief is complete. It is the one
   * place a client can be told the truth in the same response as the save:
   * their build is no longer waiting on them.
   */
  build?: { outcome: BriefReadyOutcome; jobId: string | null };
}

// ───────────────────────────────────────────────────────────────────────────
// GET
// ───────────────────────────────────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  try {
    const supabase = createSupabaseServiceRoleClient();
    const { data, error } = await withTenant(supabase, access.workspaceId)
      .from('workspace_briefs')
      .select(BRIEF_ROW_COLUMNS)
      .maybeSingle<BriefRow>();
    if (error) throw error;

    const assets = await listWorkspaceAssets(access.workspaceId);
    const brief = briefViewFromRow(data, assets);
    return NextResponse.json({
      brief,
      readiness: judgeBrief(brief, assets),
      assets,
    } satisfies BriefResponse);
  } catch (error) {
    return failure(error);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// PUT
// ───────────────────────────────────────────────────────────────────────────

/**
 * The whole brief, every time. A patch endpoint would mean deciding what an
 * absent `projects` key meant, and "the client cleared the list" and "the
 * client's browser did not send the field" must never be the same request.
 */
const BodySchema = z.object({
  offer: z.string().max(2000),
  projects: z
    .array(
      z.object({
        name: z.string().trim().max(80),
        line: z.string().max(200).optional().default(''),
        link: z.string().max(500).optional().default(''),
        screenshotAssetIds: z
          .array(z.string().uuid())
          .max(6)
          .optional()
          .default([]),
      })
    )
    .max(12),
  noProjects: z.boolean(),
  designReferenceAssetIds: z.array(z.string().uuid()).max(8),
  photoAssetIds: z.array(z.string().uuid()).max(12),
  /**
   * Which photo is the portrait, or null for none. Optional so a caller that
   * predates the field is not rejected; `undefined` leaves the current
   * portrait alone, `null` clears it.
   */
  portraitAssetId: z.string().uuid().nullable().optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid request' },
      { status: 400 }
    );
  }
  const body = parsed.data;

  // "I have no past work to show" and a list of past work are two answers to
  // one question. Saving either of them would be guessing which one the client
  // meant, and the guess decides whether their site gets a work page.
  if (body.noProjects && body.projects.length > 0) {
    return NextResponse.json(
      {
        error:
          'noProjects and projects disagree: you have said there is no past ' +
          'work to show and also listed some. Untick the box or clear the list.',
      },
      { status: 400 }
    );
  }

  // A link goes on the client's own site, in public, under their name. An
  // `http:` or `javascript:` link would be published as written, so the check
  // is here rather than in the browser where it can be skipped.
  const badLink = body.projects.findIndex((project) => {
    const link = project.link.trim();
    return link.length > 0 && !isHttpsUrl(link);
  });
  if (badLink >= 0) {
    // Named, because "one of your links is wrong" in a list of twelve is not
    // a message a client can act on.
    const project = body.projects[badLink];
    return NextResponse.json(
      {
        error: `The link on "${
          project.name.trim() || `project ${badLink + 1}`
        }" is not a full web address. It needs to start with https://`,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseServiceRoleClient();
    const tenant = withTenant(supabase, access.workspaceId);

    // Every id named anywhere in the body has to be this workspace's own file.
    // `withTenant` pins workspace_id on the query, so a stranger's id simply
    // does not come back, and the whole request is refused rather than quietly
    // saving the subset we recognised: a client who sees "saved" must not have
    // lost half of what they sent.
    const referenced = referencedAssetIds(body);
    if (referenced.length > 0) {
      const { data: ownedRows, error: ownedError } = await tenant
        .from('assets')
        .select('id')
        .in('id', referenced);
      if (ownedError) throw ownedError;
      const owned = new Set(
        ((ownedRows ?? []) as unknown as Array<{ id: string }>).map(
          (row) => row.id
        )
      );
      if (owned.size !== referenced.length) {
        // 404, not 403, for the same reason the rights route uses it: the
        // response must not confirm to a prober that an id it does not own is
        // nonetheless real.
        return NextResponse.json(
          { error: 'Those files are not on this project', code: 'NOT_FOUND' },
          { status: 404 }
        );
      }
    }

    // A portrait that is not one of the photographs would be invisible in the
    // form and would still satisfy the portrait rule.
    if (
      typeof body.portraitAssetId === 'string' &&
      !body.photoAssetIds.includes(body.portraitAssetId)
    ) {
      return NextResponse.json(
        {
          error:
            'The portrait has to be one of the photos you sent for the site.',
        },
        { status: 400 }
      );
    }

    // The current row is read before the write because `ready_at` is a
    // transition, not a value: it must keep the instant the brief first became
    // complete rather than moving every time a comma is saved.
    const { data: current, error: currentError } = await tenant
      .from('workspace_briefs')
      .select('ready_at, override_at')
      .maybeSingle<{ ready_at: string | null; override_at: string | null }>();
    if (currentError) throw currentError;

    if (body.portraitAssetId !== undefined) {
      await applyPortrait(tenant, body.portraitAssetId, body.photoAssetIds);
    }

    // Read after the portrait write, so readiness is judged on the kinds that
    // are now stored rather than the ones that were.
    const assets = await listWorkspaceAssets(access.workspaceId);
    const projects = body.projects.map(normaliseProject);
    const readiness = evaluateBriefReadiness({
      offer: body.offer,
      projects,
      noProjects: body.noProjects,
      designReferenceAssetIds: body.designReferenceAssetIds,
      photos: photosFor(body.photoAssetIds, assets),
    });

    const now = new Date().toISOString();
    // `ready_at` is the flag the build worker waits on, which is the whole
    // reason a client cannot write this column directly: a form post must not
    // be able to start a build. It is set the first time the rule says the
    // brief is complete, kept as-is while it stays complete, and cleared the
    // moment it stops being complete so a half-emptied brief cannot build.
    // `override_at` is never touched here. Only an operator writes that, and a
    // client overruling their own gate would make the gate decorative.
    const readyAt = readiness.ready ? current?.ready_at ?? now : null;

    const { error: writeError } = await tenant.from('workspace_briefs').upsert(
      {
        offer: body.offer,
        projects,
        no_projects: body.noProjects,
        design_reference_asset_ids: body.designReferenceAssetIds,
        photo_asset_ids: body.photoAssetIds,
        ready_at: readyAt,
        updated_at: now,
      },
      // The primary key, so a second save is an update and never a duplicate.
      { onConflict: 'workspace_id' }
    );
    if (writeError) throw writeError;

    // Counts only. The offer and the project descriptions are the client's own
    // words about their business; an audit trail does not need them and every
    // copy of them is another place they can leak from.
    await recordAssetEvent(access.workspaceId, 'brief_updated', access.userId, {
      offerChars: body.offer.trim().length,
      projectCount: projects.length,
      noProjects: body.noProjects,
      designReferenceCount: body.designReferenceAssetIds.length,
      photoCount: body.photoAssetIds.length,
      ready: readiness.ready,
      completeness: readiness.completeness,
      missing: readiness.missing.map((entry) => entry.code),
    });

    // The whole point of `ready_at`. Before this call the column was written
    // and nothing read it until the next time a worker happened to be nudged
    // about a job it had already refused -- which, for a client who paid on
    // Monday and finished their brief on Thursday, was never. The build is
    // started here, on the transition, by the same helper the deposit uses.
    //
    // Idempotent and safe to call on every complete save: a build already
    // queued, running or finished is recognised, and the function never
    // throws, so a nudge that fails cannot fail a save the client watched
    // succeed. The worker's own reconciliation sweep is the backstop.
    const build = readyAt
      ? await enqueueBuildOnBriefReady({ workspaceId: access.workspaceId })
      : null;

    const refreshed = await listWorkspaceAssets(access.workspaceId);
    return NextResponse.json({
      brief: {
        offer: body.offer,
        projects,
        noProjects: body.noProjects,
        designReferenceAssetIds: body.designReferenceAssetIds,
        photoAssetIds: body.photoAssetIds,
        portraitAssetId: portraitFrom(body.photoAssetIds, refreshed),
        readyAt,
        overrideAt: current?.override_at ?? null,
      },
      readiness,
      assets: refreshed,
      ...(build
        ? { build: { outcome: build.outcome, jobId: build.jobId } }
        : {}),
    } satisfies BriefResponse);
  } catch (error) {
    return failure(error);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * An absolute `https:` address and nothing else. Local on purpose: the intake
 * has its own URL rules for its own reasons, and a shared helper would make a
 * change there silently change what this route publishes.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function normaliseProject(project: {
  name: string;
  line: string;
  link: string;
  screenshotAssetIds: string[];
}): BriefProjectView {
  return {
    name: project.name.trim(),
    line: project.line.trim(),
    link: project.link.trim(),
    screenshotAssetIds: project.screenshotAssetIds,
  };
}

/** Every asset id the body names, once each. */
function referencedAssetIds(body: z.infer<typeof BodySchema>): string[] {
  const ids = new Set<string>([
    ...body.designReferenceAssetIds,
    ...body.photoAssetIds,
  ]);
  for (const project of body.projects) {
    for (const id of project.screenshotAssetIds) ids.add(id);
  }
  if (typeof body.portraitAssetId === 'string') ids.add(body.portraitAssetId);
  return Array.from(ids);
}

/**
 * Marks one photograph as the portrait and unmarks the others.
 *
 * `kind` is the only column this route writes on `assets`, and only over ids
 * the caller has already been proved to own.
 */
async function applyPortrait(
  tenant: ReturnType<typeof withTenant>,
  portraitAssetId: string | null,
  photoAssetIds: string[]
): Promise<void> {
  const demoted = photoAssetIds.filter((id) => id !== portraitAssetId);
  if (demoted.length > 0) {
    const { error } = await tenant
      .from('assets')
      .update({ kind: null })
      .in('id', demoted)
      .eq('kind', 'portrait');
    if (error) throw error;
  }
  if (portraitAssetId) {
    const { error } = await tenant
      .from('assets')
      .update({ kind: 'portrait' })
      .eq('id', portraitAssetId);
    if (error) throw error;
  }
}

/**
 * An `AssetUploadError` was raised deliberately and its text is meant for the
 * client. Anything else may carry a storage key or a connection string, so
 * only its shape crosses the wire.
 */
function failure(error: unknown): NextResponse {
  if (error instanceof AssetUploadError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status }
    );
  }
  console.error('[api/client/brief] failed', error);
  return NextResponse.json({ error: 'Request failed' }, { status: 500 });
}
