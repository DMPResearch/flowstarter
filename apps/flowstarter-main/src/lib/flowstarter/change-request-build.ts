import 'server-only';
/**
 * Turning a paid change request into a job the build worker can run.
 *
 * The escalation path was complete except for the work. A client filed a
 * request their editor correctly refused, an operator quoted it, the client
 * accepted and paid it in Stripe, and then the Changes tab offered one button:
 * "Mark done", which moved a status and shipped nothing. Nothing in the
 * product could run an agent over a delivered site -- FULL_SITE_BUILD refuses
 * unless the project is DEPOSIT_PAID, and by now it is HUMAN_QA or
 * LIVE_SUBSCRIPTION; SITE_REBUILD runs no agents at all.
 *
 * This module owns the payload that closes the gap, and only the payload. Four
 * things go on it, and each is read from the server's own tables rather than
 * from anything a browser sent:
 *
 *   - the request id and the request text as the client wrote it, from
 *     `flowstarter_change_requests`. Verbatim: it is what was quoted and paid
 *     for, and paraphrasing it into a prompt is how a build ends up doing
 *     something adjacent to what was asked.
 *   - the operator's note, if they typed one when they pressed Build.
 *   - the version the build seeds from. The worker seeds from the same
 *     artifact manifest a rebuild reads, which is the manifest the client's
 *     own editor last wrote; the number is recorded so the board can say which
 *     site this change was made against.
 *   - the client's rights-confirmed pictures, through `loadUsableAssets` and
 *     through nothing else, each with the public path it will have on the
 *     site and the client's own caption.
 *
 * `loadUsableAssets` is deliberately the only reader used here. Every other
 * reader in the app answers "what does this workspace have", and counts
 * unconfirmed uploads on purpose, because those are exactly what we still need
 * to ask about. This one answers "what may we publish", which is the only
 * question a build is allowed to ask, and until now it was imported by its own
 * test and by nothing else.
 */
import type { ChangeRequestAsset } from '@flowstarter/agentic-codegen';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import type { Json } from '@/lib/database.types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { loadUsableAssets, type UsableAsset } from './generation-assets';
import { ChangeRequestError, type ChangeRequestRow } from './change-requests';

type SupabaseServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Lifecycle states a delivered site exists in, and so a change may be built from. */
export const CHANGE_BUILD_STATES: readonly string[] = [
  ProjectState.HUMAN_QA,
  ProjectState.LIVE_SUBSCRIPTION,
];

/** Most pictures one change request carries; the worker caps at the same number. */
export const MAX_CHANGE_REQUEST_ASSETS = 12;

/** Statuses whose job is still going to run, so a second Build is a no-op. */
const LIVE_JOB_STATUSES = ['queued', 'running'] as const;

/** Extension for the public copy, from the stored path or the mime type. */
function extensionFor(asset: UsableAsset): string {
  const fromPath = /\.([a-z0-9]{2,5})$/i.exec(asset.storagePath)?.[1];
  if (fromPath) return fromPath.toLowerCase();
  const fromMime = /^image\/([a-z0-9]{2,5})$/i.exec(asset.mime ?? '')?.[1];
  return (fromMime ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
}

/**
 * Where one of the client's files lands on their site.
 *
 * Named from the asset id rather than the original file name, because the file
 * name is whatever the client's phone called it and may be anything at all,
 * while the id is a UUID the database minted. The `cr-` prefix makes it
 * obvious in a handover that this file arrived through a change request rather
 * than through the Pictures tab.
 */
export function changeRequestAssetPath(asset: UsableAsset): string {
  return `/flowstarter-media/cr-${asset.id.slice(0, 8)}.${extensionFor(asset)}`;
}

/**
 * What kind of work a request is, for the one question this file has to
 * answer: would a picture help?
 *
 * Rules, not a model, and deliberately generous about saying "yes it might":
 * anything that so much as mentions a photograph is `other`, because the cost
 * of offering a picture to a request that did not need one is nothing, while
 * the cost of withholding one from a request that did is a build that cannot
 * do what was paid for. The two cases that get nothing are the two where a
 * picture can only be noise:
 *
 *   - `removal`: the request takes something off the site.
 *   - `copy-only`: the request is about wording.
 */
export type ChangeRequestPosture = 'removal' | 'copy-only' | 'other';

const PICTURE_WORDS =
  /\b(photos?|images?|pictures?|gallery|galleries|logos?|headshots?|screenshots?|banners?|thumbnails?|portraits?|shots?|uploads?|uploaded|attached?|attachments?)\b/i;
const REMOVAL_WORDS =
  /\b(remove|removing|delete|deleting|get\s+rid\s+of|drop|hide|unpublish|clear\s+out)\b/i;
/** "Take the pricing section down": the words are rarely adjacent. */
const TAKE_DOWN = /\btake\b[^.?!]{0,40}\bdown\b/i;
const COPY_WORDS =
  /\b(typos?|spelling|grammar|punctuation|wording|reword|rephrase|rewrite|copy|text|headlines?|headings?|paragraphs?|sentences?|titles?|renames?|rename|capitali[sz]ation)\b/i;

export function changeRequestPosture(request: string): ChangeRequestPosture {
  if (PICTURE_WORDS.test(request)) return 'other';
  if (REMOVAL_WORDS.test(request) || TAKE_DOWN.test(request)) return 'removal';
  if (COPY_WORDS.test(request)) return 'copy-only';
  return 'other';
}

/** Why the pictures on a request are on it; the worker phrases the prompt from this. */
export type ChangeRequestAssetHandover =
  | 'operator'
  | 'named'
  | 'library'
  | 'none';

export interface ChangeRequestAssetChoice {
  assets: ChangeRequestAsset[];
  handover: ChangeRequestAssetHandover;
}

/**
 * The client's pictures that this request should carry, and on what terms.
 *
 * `selectedAssetIds` is the operator's choice when they made one. With no
 * choice, every rights-confirmed picture the request's own text names by
 * caption is carried: a request that says "the three screenshots I uploaded"
 * should not need an operator to re-select them.
 *
 * With no caption match either, the old rule handed over the entire library
 * under a prompt that said "use every one of these pictures". That is how a
 * copy fix ends up with three unrelated photographs on it. Now the library is
 * still handed over -- an agent that cannot see a file cannot use it, and
 * re-queuing a build because the operator forgot to tick a box is worse -- but
 * it is handed over as `library`, which the prompt renders as "available if
 * the request calls for them", and a request that can only be a deletion or a
 * wording change is handed nothing at all.
 *
 * Deliberately no model anywhere in this: the caption match is a plain
 * case-folded substring test on text the client wrote in both places, and the
 * posture is the regexes above.
 */
export function selectChangeRequestAssets(input: {
  assets: readonly UsableAsset[];
  request: string;
  selectedAssetIds?: readonly string[];
}): ChangeRequestAssetChoice {
  const { assets, request } = input;
  const selected = input.selectedAssetIds ?? [];

  let chosen: UsableAsset[];
  let handover: ChangeRequestAssetHandover;
  if (selected.length > 0) {
    const wanted = new Set(selected);
    chosen = assets.filter((asset) => wanted.has(asset.id));
    handover = 'operator';
  } else {
    const haystack = request.toLowerCase();
    const named = assets.filter((asset) => {
      const caption = asset.caption?.trim().toLowerCase();
      return Boolean(
        caption && caption.length >= 4 && haystack.includes(caption)
      );
    });
    if (named.length > 0) {
      chosen = named;
      handover = 'named';
    } else if (changeRequestPosture(request) === 'other') {
      chosen = [...assets];
      handover = 'library';
    } else {
      chosen = [];
      handover = 'none';
    }
  }

  return {
    handover,
    assets: chosen.slice(0, MAX_CHANGE_REQUEST_ASSETS).map((asset) => {
      const publicPath = changeRequestAssetPath(asset);
      return {
        assetId: asset.id,
        publicPath,
        manifestPath: `public${publicPath}`,
        caption: asset.caption?.trim() ?? '',
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
      };
    }),
  };
}

export interface ChangeRequestBuildPayload {
  trigger: 'operator_build';
  changeRequest: {
    changeRequestId: string;
    request: string;
    operatorNote: string | null;
    seedVersion: number;
    assets: ChangeRequestAsset[];
    /** On what terms the pictures are attached; the prompt reads this. */
    assetSelection: ChangeRequestAssetHandover;
  };
}

/** The payload, assembled from the server's own rows. */
export function changeRequestBuildPayload(input: {
  row: ChangeRequestRow;
  operatorNote: string | null;
  seedVersion: number;
  assets: ChangeRequestAsset[];
  assetSelection?: ChangeRequestAssetHandover;
}): ChangeRequestBuildPayload {
  return {
    trigger: 'operator_build',
    changeRequest: {
      changeRequestId: input.row.id,
      request: input.row.request,
      operatorNote: input.operatorNote,
      seedVersion: input.seedVersion,
      assets: input.assets,
      assetSelection: input.assetSelection ?? 'named',
    },
  };
}

/** The version the site is at right now, or 0 before any edit was ever saved. */
export async function currentSiteVersion(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<number> {
  const { data, error } = await supabase
    .from('site_versions')
    .select('version')
    .eq('workspace_id', workspaceId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.version ?? 0;
}

export interface ChangeRequestBuildResult {
  jobId: string;
  /** False when a build for this workspace was already in flight. */
  created: boolean;
  assets: ChangeRequestAsset[];
  seedVersion: number;
}

/**
 * Derives the payload and queues exactly one CHANGE_REQUEST_BUILD.
 *
 * Both gates are checked against the database, never against the request body:
 * the project has to be in a state where a delivered site exists, and the
 * change request has to be `paid`. A request that is merely quoted has not
 * been bought, and building it would be doing free work and then charging for
 * it afterwards; a request already `done` has shipped.
 */
export async function enqueueChangeRequestBuild(input: {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  row: ChangeRequestRow;
  projectState: string;
  operatorNote: string | null;
  selectedAssetIds?: readonly string[];
}): Promise<ChangeRequestBuildResult> {
  const { supabase, workspaceId, row } = input;

  if (!CHANGE_BUILD_STATES.includes(input.projectState)) {
    throw new ChangeRequestError(
      'This project has no delivered site to change yet. A change request ' +
        'can only be built once the site is in human QA or live.',
      'INVALID_PROJECT_STATE',
      409
    );
  }
  if (row.status !== 'paid') {
    throw new ChangeRequestError(
      `Only a paid change request can be built; this one is ${row.status}.`,
      'CHANGE_REQUEST_NOT_PAID',
      409
    );
  }

  const [seedVersion, usable] = await Promise.all([
    currentSiteVersion(supabase, workspaceId),
    loadUsableAssets(workspaceId),
  ]);
  const { assets, handover } = selectChangeRequestAssets({
    assets: usable,
    request: row.request,
    ...(input.selectedAssetIds
      ? { selectedAssetIds: input.selectedAssetIds }
      : {}),
  });

  const existing = await findLiveChangeBuild(supabase, workspaceId);
  if (existing) return { jobId: existing, created: false, assets, seedVersion };

  const now = new Date().toISOString();
  const insert = await supabase
    .from('flowstarter_agent_jobs')
    .insert({
      workspace_id: workspaceId,
      kind: 'CHANGE_REQUEST_BUILD',
      status: 'queued',
      payload: changeRequestBuildPayload({
        row,
        operatorNote: input.operatorNote,
        seedVersion,
        assets,
        assetSelection: handover,
      }) as unknown as Json,
      updated_at: now,
    })
    .select('id')
    .single();

  if (insert.error?.code === '23505') {
    // The partial unique index refused: another operator pressed Build a
    // moment ago. Joining that job is the right answer rather than an error
    // about a race nobody can see.
    const live = await findLiveChangeBuild(supabase, workspaceId);
    if (!live) {
      throw new ChangeRequestError(
        'A change build is already running for this project but could not be ' +
          'read back. Reload and try again.',
        'CHANGE_BUILD_RACE',
        409
      );
    }
    return { jobId: live, created: false, assets, seedVersion };
  }
  if (insert.error || !insert.data) {
    throw insert.error ?? new Error('Could not enqueue the change build');
  }

  // The job row is the commitment; the link back from the request is what the
  // operator's card and the deploy callback both follow.
  const { error: linkError } = await supabase
    .from('flowstarter_change_requests')
    .update({ build_job_id: insert.data.id, updated_at: now })
    .eq('id', row.id)
    .eq('workspace_id', workspaceId);
  if (linkError) throw linkError;

  return { jobId: insert.data.id, created: true, assets, seedVersion };
}

async function findLiveChangeBuild(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('flowstarter_agent_jobs')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'CHANGE_REQUEST_BUILD')
    .in('status', LIVE_JOB_STATUSES as unknown as string[])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}
