import 'server-only';

/**
 * Reading one workspace's brief, in one place.
 *
 * Two surfaces need this and must never disagree about it: the brief page
 * itself, which renders the form and the "what is still missing" list, and the
 * project overview, whose "Your brief" tile tells the client how far along
 * they are. A tile that says the brief is complete next to a page that says it
 * is not would be worse than no tile.
 *
 * So the row reading, the asset joining and the call into the pure rule all
 * live here, and `/api/client/brief/[workspaceId]` and the dashboard pages are
 * both callers. The rule itself stays in `brief-readiness.ts`, which has no
 * database in it at all.
 *
 * This module reads. It never writes `ready_at`: that is the column the build
 * worker waits on, and exactly one place is allowed to set it, which is the
 * PUT handler after it has validated a whole brief.
 */
import {
  listWorkspaceAssets,
  type ClientAsset,
} from '@/app/api/client/assets/asset-storage';
import {
  evaluateBriefReadiness,
  type BriefReadiness,
} from '@/lib/flowstarter/brief-readiness';
import { withTenant } from '@/lib/tenancy';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  parsePerson,
  type BriefPerson,
} from '@flowstarter/agentic-codegen/src/flowstarter/person';
import {
  deriveBriefPages,
  pageCountAnswerFor,
  resolvePageCountAnswer,
  siteKindFor,
  type PageCountAnswer,
  type SiteKind,
} from '@flowstarter/agentic-codegen/src/flowstarter/page-set';

export interface BriefProjectView {
  name: string;
  line: string;
  link: string;
  screenshotAssetIds: string[];
}

export interface BriefView {
  offer: string;
  /**
   * The client's own business name, given on the brief. '' means they have
   * not set one here — the form then prefills the input with the workspace's
   * current name (which is already the value `deriveBusinessName` produced
   * at claim time) rather than this column holding a second copy of it.
   */
  businessName: string;
  projects: BriefProjectView[];
  noProjects: boolean;
  designReferenceAssetIds: string[];
  photoAssetIds: string[];
  /**
   * Derived from `assets.kind`, not stored on the brief: exactly one photo may
   * be the portrait, and the asset row is the one place that can hold it
   * without two records disagreeing.
   */
  portraitAssetId: string | null;
  /** The column the build worker waits on. Written by PUT, never by a reader. */
  readyAt: string | null;
  /** An operator's "build it anyway". Read here, never written here. */
  overrideAt: string | null;
  /**
   * The client's own page-count answer, asked on the brief. Null means they
   * have not touched the control: the form then pre-selects and describes
   * whatever `derivedBriefPageCount` works out from the rest of the brief,
   * and `effectiveBriefPageCount` falls back the same way for the build.
   */
  pageCount: string | null;
  /**
   * Who the client is, in their own words, or null when nobody has asked.
   *
   * Null is not the same as a section full of empty strings and the
   * difference decides whether a build can be blocked: null is every brief
   * taken before the question existed, and the readiness rule leaves those
   * alone. See `packages/agentic-codegen/src/flowstarter/person.ts`.
   */
  person: BriefPerson | null;
}

/** A first visit has no row, and that is not an error. */
export const EMPTY_BRIEF: BriefView = {
  offer: '',
  businessName: '',
  projects: [],
  noProjects: false,
  designReferenceAssetIds: [],
  photoAssetIds: [],
  portraitAssetId: null,
  readyAt: null,
  overrideAt: null,
  pageCount: null,
  person: null,
};

export interface BriefRow {
  offer: string | null;
  business_name: string | null;
  projects: unknown;
  no_projects: boolean | null;
  design_reference_asset_ids: string[] | null;
  photo_asset_ids: string[] | null;
  ready_at: string | null;
  override_at: string | null;
  page_count: string | null;
  person: unknown;
}

export const BRIEF_ROW_COLUMNS =
  'offer, business_name, projects, no_projects, design_reference_asset_ids, photo_asset_ids, ready_at, override_at, page_count, person';

/**
 * `projects` is a jsonb column, so what comes back is whatever was put in.
 * Read defensively: a row written by an earlier shape, or by an operator with
 * psql, must render as a form rather than crash a page.
 */
export function storedProjects(value: unknown): BriefProjectView[] {
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

/** The photo rows the readiness rule measures, joined from the asset table. */
export function photosFor(photoAssetIds: string[], assets: ClientAsset[]) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return photoAssetIds.flatMap((id) => {
    const asset = byId.get(id);
    if (!asset) return [];
    return [
      {
        assetId: asset.id,
        kind: asset.kind,
        width: asset.width,
        height: asset.height,
        // An unconfirmed photograph is a file we hold, not one we may publish.
        rightsConfirmed: Boolean(asset.rightsConfirmedAt),
      },
    ];
  });
}

export function portraitFrom(
  photoAssetIds: string[],
  assets: ClientAsset[]
): string | null {
  const chosen = assets.find(
    (asset) => asset.kind === 'portrait' && photoAssetIds.includes(asset.id)
  );
  return chosen?.id ?? null;
}

export function briefViewFromRow(
  row: BriefRow | null,
  assets: ClientAsset[]
): BriefView {
  if (!row) return EMPTY_BRIEF;
  const photoAssetIds = row.photo_asset_ids ?? [];
  return {
    offer: row.offer ?? '',
    businessName: row.business_name ?? '',
    projects: storedProjects(row.projects),
    noProjects: Boolean(row.no_projects),
    designReferenceAssetIds: row.design_reference_asset_ids ?? [],
    photoAssetIds,
    portraitAssetId: portraitFrom(photoAssetIds, assets),
    readyAt: row.ready_at,
    overrideAt: row.override_at,
    pageCount: row.page_count,
    // `person` is a jsonb column an operator can edit, so it is re-validated
    // on the way out of the database by the same parser the build worker uses
    // on the way into a prompt. One shape, one reader, no drift.
    person: parsePerson(row.person),
  };
}

/**
 * Whether this brief describes a site about a person.
 *
 * The funnel only ever asks the person block of a visitor it classified as a
 * person-site, so the presence of the section IS that classification, carried
 * in the data rather than recomputed from a sentence. The text rule is the
 * fallback for a brief filled in by an operator or by a client whose intake
 * predates the block, and it is `siteKindFor` -- the same rule that decides
 * the page order -- so a site cannot be a portfolio for the page set and a
 * services business for the readiness gate.
 */
export function briefSiteKind(
  brief: BriefView,
  businessType?: string | null
): SiteKind {
  if (brief.person) return 'portfolio';
  return siteKindFor(businessType ?? '');
}

/**
 * Rule 7 (`deriveBriefPages`), read off a brief rather than an intake.
 *
 * `deriveBriefPages` takes `businessType` and `description` too, but a brief
 * needs neither: those two only ever fire the site-kind fallbacks for a
 * client who was never asked whether they have real projects, and a brief
 * always asks that question (`noProjects` is an explicit answer, not an
 * absent one). With `projectCount` always set, `deriveBriefPages` never
 * reaches the `!asked` branches, so the site kind cannot change the count --
 * only membership can, exactly what a client filling in the brief actually
 * controls.
 */
export function derivedBriefPageCount(brief: BriefView): PageCountAnswer {
  return pageCountAnswerFor(
    deriveBriefPages({
      offer: brief.offer,
      projectCount: brief.noProjects
        ? 0
        : brief.projects.filter((project) => project.name.trim()).length,
    }).length
  );
}

/**
 * Whose page-count answer a build actually uses, once the brief, an intake
 * carried forward and the derivation are all in the room. Rule 8: the
 * brief's own answer wins, then the intake's, then the derivation.
 */
export function effectiveBriefPageCount(
  brief: BriefView,
  intakePageCount?: string | null
): PageCountAnswer {
  return resolvePageCountAnswer({
    briefPageCount: brief.pageCount,
    derivedPageCount: derivedBriefPageCount(brief),
    intakePageCount,
  });
}

/** The pure rule, fed from a stored brief and the workspace's files. */
export function judgeBrief(
  brief: BriefView,
  assets: ClientAsset[],
  businessType?: string | null
): BriefReadiness {
  return evaluateBriefReadiness({
    offer: brief.offer,
    siteKind: briefSiteKind(brief, businessType),
    person: brief.person,
    projects: brief.projects,
    noProjects: brief.noProjects,
    designReferenceAssetIds: brief.designReferenceAssetIds,
    photos: photosFor(brief.photoAssetIds, assets),
  });
}

export interface BriefSnapshot {
  brief: BriefView;
  readiness: BriefReadiness;
  assets: ClientAsset[];
}

/**
 * Everything a surface needs to show the brief. Callers have already proved
 * the reader may see this workspace; this does the tenant-scoped read.
 */
export async function loadBriefSnapshot(
  workspaceId: string
): Promise<BriefSnapshot> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await withTenant(supabase, workspaceId)
    .from('workspace_briefs')
    .select(BRIEF_ROW_COLUMNS)
    .maybeSingle<BriefRow>();
  if (error) throw error;

  const assets = await listWorkspaceAssets(workspaceId);
  const brief = briefViewFromRow(data, assets);
  return { brief, readiness: judgeBrief(brief, assets), assets };
}
