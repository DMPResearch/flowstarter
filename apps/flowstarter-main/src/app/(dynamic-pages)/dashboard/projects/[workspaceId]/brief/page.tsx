/**
 * "Your brief": the page a client fills the real material in on.
 *
 * Everything below the authorization check is read with the service role,
 * which bypasses RLS, so `requireWorkspaceAccess` is the only thing standing
 * between a client and another tenant's brief. It runs first, before a single
 * row is fetched, and a caller who is not a member gets `notFound()`: the same
 * 404 the API returns, so the page does not confirm the id is real.
 *
 * The row is read here rather than through the API because a server component
 * calling its own HTTP route would be a second round trip and a second copy of
 * the session. `PUT /api/client/brief/[workspaceId]` is still the only writer,
 * and `evaluateBriefReadiness` is the same pure rule in both places, so what
 * this page renders and what the route decides cannot drift.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import { listWorkspaceAssets } from '@/app/api/client/assets/asset-storage';
import { evaluateBriefReadiness } from '@/lib/flowstarter/brief-readiness';
import { derivedBriefPageCount } from '@/lib/flowstarter/brief-data';
import { portraitSizeFloors } from '@/lib/flowstarter/portrait-config';
import { withTenant } from '@/lib/tenancy';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  BriefForm,
  type BriefProjectView,
} from '@/components/flowstarter/BriefForm';

export const dynamic = 'force-dynamic';

interface BriefRow {
  offer: string | null;
  business_name: string | null;
  projects: unknown;
  no_projects: boolean | null;
  design_reference_asset_ids: string[] | null;
  photo_asset_ids: string[] | null;
  ready_at: string | null;
  override_at: string | null;
  page_count: string | null;
}

export default async function ClientBriefPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) {
    // A signed-out caller should be asked to sign in; everything else, wrong
    // tenant or malformed id, is a 404, which tells a prober nothing.
    if (access.response.status === 401) {
      redirect(`/login?next=/dashboard/projects/${workspaceId}/brief`);
    }
    notFound();
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('id', workspaceId)
    .maybeSingle<{ id: string; name: string }>();
  if (!workspace) notFound();

  const { data: row } = await withTenant(supabase, access.workspaceId)
    .from('workspace_briefs')
    .select(
      'offer, business_name, projects, no_projects, design_reference_asset_ids, photo_asset_ids, ready_at, override_at, page_count'
    )
    .maybeSingle<BriefRow>();

  const assets = await listWorkspaceAssets(access.workspaceId);
  const photoAssetIds = row?.photo_asset_ids ?? [];
  const brief = {
    offer: row?.offer ?? '',
    businessName: row?.business_name ?? '',
    projects: storedProjects(row?.projects),
    noProjects: Boolean(row?.no_projects),
    designReferenceAssetIds: row?.design_reference_asset_ids ?? [],
    photoAssetIds,
    // The portrait lives on the asset row's `kind`, so there is one record of
    // it rather than two that can disagree.
    portraitAssetId:
      assets.find(
        (asset) => asset.kind === 'portrait' && photoAssetIds.includes(asset.id)
      )?.id ?? null,
    readyAt: row?.ready_at ?? null,
    overrideAt: row?.override_at ?? null,
    pageCount: row?.page_count ?? null,
    // Never asked. A fixture and a preview both predate the person
    // section, and `null` is the state that keeps the gate silent.
    person: null,
  };

  const readiness = evaluateBriefReadiness({
    offer: brief.offer,
    projects: brief.projects,
    noProjects: brief.noProjects,
    designReferenceAssetIds: brief.designReferenceAssetIds,
    photos: photoAssetIds.flatMap((id) => {
      const asset = assets.find((one) => one.id === id);
      return asset
        ? [
            {
              assetId: asset.id,
              kind: asset.kind,
              width: asset.width,
              height: asset.height,
              rightsConfirmed: Boolean(asset.rightsConfirmedAt),
            },
          ]
        : [];
    }),
  });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-12">
      <header className="flex flex-col gap-2">
        <Link
          href={`/dashboard/projects/${workspaceId}`}
          data-testid="brief-back-link"
          className="w-fit text-sm font-semibold text-[var(--purple-primary)] underline underline-offset-4"
        >
          ← Back to project
        </Link>
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--purple-primary)]">
          Your brief
        </p>
        <h1 className="text-3xl font-bold leading-tight text-[var(--fs-ink)]">
          Tell us about your business
        </h1>
        <p className="text-sm leading-relaxed text-[var(--fs-ink)]/70">
          This is what your site is made from. Every word and every picture on
          it comes from what you put here, which is why we ask rather than
          guess. Your build starts as soon as this is complete, and you can come
          back and change any of it afterwards.
        </p>
      </header>

      <BriefForm
        workspaceId={workspaceId}
        initialBrief={brief}
        initialReadiness={readiness}
        derivedPageCount={derivedBriefPageCount(brief)}
        derivedBusinessName={workspace.name ?? ''}
        initialAssets={assets.map((asset) => ({
          id: asset.id,
          kind: asset.kind,
          mime: asset.mime,
          width: asset.width,
          height: asset.height,
          usable: asset.usable,
          url: asset.url,
          // Provenance. A picture we read off a page of theirs is offered back
          // with a "Use this"; a file they sent us is already theirs to
          // publish. The form cannot tell the two apart without these.
          source: asset.source,
          sourceUrl: asset.sourceUrl,
          rightsConfirmedAt: asset.rightsConfirmedAt,
          // What the picture shows, and whose sentence that is. Dropping these
          // here would leave the form showing four identical thumbnails with
          // nothing to tell them apart, which is the failure this exists to
          // end.
          caption: asset.caption,
          captionSource: asset.captionSource,
          autoCaptionKind: asset.autoCaptionKind,
        }))}
        // Read here, on the server, because `portraitSizeFloors` reads
        // `process.env` and a client component would only ever see the
        // browser-visible half of it, where an operator override is not.
        portraitFloors={portraitSizeFloors()}
      />
    </main>
  );
}

/**
 * `projects` is a jsonb column, so what comes back is whatever was put in. A
 * row written by an earlier shape, or by an operator with psql, has to render
 * as a form rather than crash the page.
 */
function storedProjects(value: unknown): BriefProjectView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    return [
      {
        name: typeof record.name === 'string' ? record.name : '',
        line: typeof record.line === 'string' ? record.line : '',
        link: typeof record.link === 'string' ? record.link : '',
        screenshotAssetIds: Array.isArray(record.screenshotAssetIds)
          ? record.screenshotAssetIds.filter(
              (id): id is string => typeof id === 'string'
            )
          : [],
      },
    ];
  });
}
