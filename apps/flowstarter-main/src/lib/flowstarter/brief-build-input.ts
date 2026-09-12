import 'server-only';
/**
 * The brief, turned into something a build can be made from.
 *
 * `workspace_briefs` holds what the client wrote and a list of asset ids. The
 * build worker is a separate deployable with its own Supabase client, no
 * access to this app's modules, and no business deciding which of a
 * workspace's files may be published. So the composition happens here, once,
 * at the moment the brief becomes buildable, and the result rides on the
 * FULL_SITE_BUILD payload as a versioned `briefInput`.
 *
 * Two rules govern what may go on it, and neither is negotiable:
 *
 *   `loadUsableAssets` is the only reader. Every other asset reader in this
 *   app answers "what does this workspace have" and deliberately counts
 *   unconfirmed uploads, because those are what the brief still needs to ask
 *   about. This one answers "what may we publish", which is the only question
 *   a build is allowed to ask. An id the client named whose rights are not
 *   confirmed is simply not in the payload, and the worker re-checks the same
 *   column again at build time.
 *
 *   Paths are minted here, not taken. A file's public path is derived from its
 *   asset id and its stored extension, never from the name the client's phone
 *   gave it, and always under `/flowstarter-media/`, which is the directory
 *   the Pictures tab already publishes into. The change-request build mints
 *   `cr-` paths the same way and the worker materialises both through the same
 *   loader.
 *
 * Rules decide, models phrase: nothing here is generated, and the readiness
 * that triggers it is `brief-readiness.ts`, a pure function.
 */
import {
  BRIEF_INPUT_VERSION,
  type BriefInput,
  type BriefInputAsset,
  type BriefInputProject,
} from '@flowstarter/agentic-codegen/src/flowstarter/brief-input';
import type { BriefTone } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { withTenant } from '@/lib/tenancy';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  BRIEF_ROW_COLUMNS,
  briefViewFromRow,
  type BriefRow,
  type BriefView,
} from './brief-data';
import { loadUsableAssets, type UsableAsset } from './generation-assets';

/** Most files of one role a single build will carry. */
const MAX_ASSETS_PER_ROLE = 24;

/** Extension for the public copy, from the stored path or the mime type. */
function extensionFor(asset: UsableAsset): string {
  const fromPath = /\.([a-z0-9]{2,5})$/i.exec(asset.storagePath)?.[1];
  if (fromPath) return fromPath.toLowerCase();
  const fromMime = /^image\/([a-z0-9]{2,5})$/i.exec(asset.mime ?? '')?.[1];
  return (fromMime ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
}

/**
 * Where one of the client's brief files lands on their site.
 *
 * The `brief-` prefix is the counterpart of the change request's `cr-`: in a
 * handover, a path says which conversation the file arrived through. The id
 * stem is a UUID this database minted, so two files can never collide and no
 * client-supplied string ever reaches a filename.
 */
export function briefAssetPath(asset: UsableAsset): string {
  return `/flowstarter-media/brief-${asset.id.slice(0, 8)}.${extensionFor(
    asset
  )}`;
}

function toInputAsset(
  asset: UsableAsset,
  role: BriefInputAsset['role']
): BriefInputAsset {
  const publicPath = briefAssetPath(asset);
  return {
    assetId: asset.id,
    publicPath,
    manifestPath: `public${publicPath}`,
    role,
    caption: asset.caption?.trim() ?? '',
    mime: asset.mime,
    width: asset.width,
    height: asset.height,
  };
}

export interface ComposeBriefInputArgs {
  brief: BriefView;
  /** Rights-confirmed assets only. `loadUsableAssets` and nothing else. */
  assets: readonly UsableAsset[];
  reason: BriefInput['reason'];
  /** The intake's page-count answer, carried so the payload is self-describing. */
  pageCount?: string | null;
  /** The funnel's derived tone, when the workspace has one. */
  tone?: BriefTone | null;
  now?: Date;
}

/**
 * The versioned build input, from a stored brief and the files we may publish.
 *
 * Pure, so the rule can be read and tested without a database. An id the brief
 * names that is not in `assets` is dropped rather than carried: it is either a
 * file the client deleted or one whose rights they never confirmed, and both
 * mean the same thing to a build, which is that those bytes must not appear on
 * a public website.
 */
export function composeBriefInput(args: ComposeBriefInputArgs): BriefInput {
  const { brief } = args;
  const byId = new Map(args.assets.map((asset) => [asset.id, asset]));

  const pick = (
    ids: readonly string[],
    role: BriefInputAsset['role'],
    cap = MAX_ASSETS_PER_ROLE
  ): BriefInputAsset[] => {
    const out: BriefInputAsset[] = [];
    for (const id of ids) {
      const asset = byId.get(id);
      if (!asset) continue;
      out.push(toInputAsset(asset, role));
      if (out.length >= cap) break;
    }
    return out;
  };

  const projects: BriefInputProject[] = brief.projects
    .filter((project) => project.name.trim().length > 0)
    .map((project) => ({
      name: project.name.trim(),
      line: project.line.trim(),
      link: project.link.trim(),
      screenshotAssetIds: [...project.screenshotAssetIds],
      screenshots: pick(project.screenshotAssetIds, 'project-screenshot', 6),
    }));

  const photos = pick(brief.photoAssetIds, 'photo');
  const portraitAsset = brief.portraitAssetId
    ? byId.get(brief.portraitAssetId)
    : undefined;
  const portrait = portraitAsset
    ? toInputAsset(portraitAsset, 'portrait')
    : null;

  return {
    version: BRIEF_INPUT_VERSION,
    composedAt: (args.now ?? new Date()).toISOString(),
    reason: args.reason,
    offer: brief.offer.trim(),
    projects,
    // "No past work to show" is an answer, and `projects: []` alone is not it.
    // The worker's gate and the page-set rule both act on the two differently,
    // so an operator override on a brief that lists nothing and answered
    // nothing must not be dressed up as a client saying they have none.
    noProjects: brief.noProjects,
    designReferences: pick(brief.designReferenceAssetIds, 'design-reference'),
    // The portrait is listed once, as the portrait. Leaving it in `photos` as
    // well would tell the agent the same file is both a general photograph and
    // the client's own face, and the about section is the one place that
    // matters.
    photos: photos.filter((photo) => photo.assetId !== portrait?.assetId),
    portrait,
    ...(args.pageCount ? { pageCount: args.pageCount } : {}),
    ...(args.tone ? { tone: args.tone } : {}),
  };
}

/**
 * Whether this brief may start a build, and why.
 *
 * The same two conditions the build worker's claim checks, read from the same
 * columns: the client finished it, or an operator waived it. `ready_at` is
 * preferred when both are set, because a brief that became complete after an
 * override is a completed brief and the record should say so.
 */
export function briefBuildReason(
  brief: Pick<BriefView, 'readyAt' | 'overrideAt'>
): BriefInput['reason'] | null {
  if (brief.readyAt) return 'brief_ready';
  if (brief.overrideAt) return 'operator_override';
  return null;
}

export interface LoadedBriefInput {
  briefInput: BriefInput | null;
  /** Why it could not be composed, for the caller's log. Empty on success. */
  reason: string;
}

/**
 * The build input for one workspace, or null when there is nothing to build
 * from yet.
 *
 * Never throws. This is called from a webhook-adjacent path where the money
 * has already moved and from a client's form POST: a build input that cannot
 * be composed must degrade to "build from the intake exactly as before", which
 * is what every workspace did until this existed, and never to a 500 on a save
 * the client watched succeed.
 */
export async function loadBriefBuildInput(
  workspaceId: string
): Promise<LoadedBriefInput> {
  try {
    const supabase = createSupabaseServiceRoleClient();
    const { data, error } = await withTenant(supabase, workspaceId)
      .from('workspace_briefs')
      .select(BRIEF_ROW_COLUMNS)
      .maybeSingle<BriefRow>();
    if (error) throw error;
    if (!data) return { briefInput: null, reason: 'no brief row' };

    // Rights-confirmed files only, and the portrait is derived from
    // `assets.kind` rather than stored on the brief, so this is also the read
    // that resolves it.
    const usable = await loadUsableAssets(workspaceId);
    const brief = briefViewFromRow(data, usableAsClientAssets(usable));
    const reason = briefBuildReason(brief);
    if (!reason) return { briefInput: null, reason: 'brief is not ready' };

    const carried = await carriedIntakeFields(supabase, workspaceId);
    return {
      briefInput: composeBriefInput({
        brief,
        assets: usable,
        reason,
        ...(carried.pageCount ? { pageCount: carried.pageCount } : {}),
        ...(carried.tone ? { tone: carried.tone } : {}),
      }),
      reason: '',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    console.error(
      `[brief-build-input] could not compose the build input for ${workspaceId}: ${detail}`
    );
    return { briefInput: null, reason: detail };
  }
}

type SupabaseServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * The two intake fields the payload carries forward so it is self-describing.
 *
 * Neither is the brief's to own -- the page-count answer comes from the
 * intake and the tone from the funnel's brand signals -- and the worker
 * prefers its own intake for both. They are here so an operator reading one
 * job payload can see the whole shape of what was asked for without joining
 * two tables. Failure is not an error: the payload simply omits them.
 */
async function carriedIntakeFields(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<{ pageCount: string | null; tone: BriefTone | null }> {
  try {
    const { data, error } = await withTenant(supabase, workspaceId)
      .from('flowstarter_project_artifacts')
      .select('intake_payload')
      .maybeSingle<{ intake_payload: unknown }>();
    if (error) throw error;
    const intake =
      data?.intake_payload &&
      typeof data.intake_payload === 'object' &&
      !Array.isArray(data.intake_payload)
        ? (data.intake_payload as Record<string, unknown>)
        : null;
    if (!intake) return { pageCount: null, tone: null };
    const business =
      intake['business'] && typeof intake['business'] === 'object'
        ? (intake['business'] as Record<string, unknown>)
        : {};
    const rawTone =
      intake['tone'] && typeof intake['tone'] === 'object'
        ? (intake['tone'] as Record<string, unknown>)
        : null;
    return {
      pageCount:
        typeof business['pageCount'] === 'string'
          ? business['pageCount']
          : null,
      tone: rawTone
        ? {
            adjectives: Array.isArray(rawTone['adjectives'])
              ? rawTone['adjectives'].filter(
                  (word): word is string => typeof word === 'string'
                )
              : [],
            voice: typeof rawTone['voice'] === 'string' ? rawTone['voice'] : '',
          }
        : null,
    };
  } catch {
    return { pageCount: null, tone: null };
  }
}

/**
 * `briefViewFromRow` resolves the portrait from the asset list it is handed.
 *
 * It was written against `ClientAsset`, the shape the dashboard renders, and
 * this path deliberately reads through `loadUsableAssets` instead, so the two
 * are bridged here rather than by widening the loader everything else uses. An
 * unconfirmed portrait therefore simply does not resolve, which is the correct
 * answer for a build.
 */
function usableAsClientAssets(assets: readonly UsableAsset[]) {
  return assets.map((asset) => ({
    id: asset.id,
    source: 'upload',
    kind: asset.kind,
    mime: asset.mime,
    width: asset.width,
    height: asset.height,
    usableFor: asset.usableFor,
    selected: true,
    rightsConfirmedAt: new Date(0).toISOString(),
    createdAt: null,
    usable: true,
    url: null,
  }));
}
