/**
 * Supabase-backed implementation of `FullSiteBuildJobStore`.
 *
 * The ledger (`flowstarter_agent_jobs`) and the artifact row
 * (`flowstarter_project_artifacts`) are service-role only — browsers have no
 * grant on either table. Claiming is an optimistic conditional update so two
 * dispatches of the same Stripe redelivery cannot both start a build.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ProjectState,
  normalizeCalLink,
  type BrandConfig,
  type BusinessIntakePayload,
  type FullSiteBuildEvent,
  type FullSiteBuildJob,
  type FullSiteBuildJobStore,
  type GitWorktree,
  type ApprovedPreviewEdit,
  type OperatorNote,
  type PreviewIntent,
  type TemplateScaffoldFile,
} from '@flowstarter/agentic-codegen';
import { withTenant } from './tenancy';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** States a job may be claimed from. Anything else is a no-op. */
const CLAIMABLE = new Set(['queued', 'failed']);

/**
 * Kinds this worker knows how to run. Both are dispatched to the same
 * endpoint, because they are the same pipeline with different halves of it
 * enabled; the worker branches on the kind, not on the route.
 */
const CLAIMABLE_KINDS = new Set(['FULL_SITE_BUILD', 'SITE_REBUILD']);

export class JobArtifactError extends Error {}

export interface JobLedgerRow {
  id: string;
  workspace_id: string;
  kind: string;
  status: string;
  attempt_count: number;
  payload: unknown;
}

export interface ProjectArtifactRow {
  intake_payload: unknown;
  brand_config: unknown;
  preview_manifest: unknown;
}

/**
 * True when the ledger row is in a state a worker may take over. `running`,
 * `succeeded` and `canceled` are deliberately excluded so Stripe redeliveries
 * and duplicate dispatches collapse into a no-op rather than a second build.
 */
export function isClaimable(row: JobLedgerRow, maxAttempts: number): boolean {
  if (!CLAIMABLE_KINDS.has(row.kind)) return false;
  if (!CLAIMABLE.has(row.status)) return false;
  return row.attempt_count < maxAttempts;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobArtifactError(`${field} is missing or is not an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Preview files were written by a Pi session and stored verbatim, so they are
 * re-validated here before they are materialized into a git worktree.
 * `materializeScaffold` re-checks every path again; this check keeps a
 * malformed manifest from reaching it at all.
 */
export function parseApprovedPreviewFiles(
  manifest: unknown,
): TemplateScaffoldFile[] {
  const record = asRecord(manifest, 'preview_manifest');
  const files = record['files'];
  if (!Array.isArray(files) || files.length === 0) {
    throw new JobArtifactError(
      'preview_manifest.files must hold the approved preview file set',
    );
  }
  return files.map((entry, index) => {
    const file = asRecord(entry, `preview_manifest.files[${index}]`);
    const path = file['path'];
    const content = file['content'];
    if (typeof path !== 'string' || path.length === 0) {
      throw new JobArtifactError(
        `preview_manifest.files[${index}].path must be a non-empty string`,
      );
    }
    if (typeof content !== 'string') {
      throw new JobArtifactError(
        `preview_manifest.files[${index}].content must be a string`,
      );
    }
    // `encoding` used to be dropped here, which silently turned every image,
    // font and other binary asset in the approved preview into a file holding
    // its own base64 text. `materializeScaffold` already decodes the flag; the
    // only thing missing was carrying it this far.
    const encoding = file['encoding'];
    if (encoding !== undefined && encoding !== 'base64') {
      throw new JobArtifactError(
        `preview_manifest.files[${index}].encoding must be 'base64' when present`,
      );
    }
    return {
      path,
      content,
      ...(encoding === 'base64' ? { encoding } : {}),
      type: 'file',
    } satisfies TemplateScaffoldFile;
  });
}

/** Longest instruction/phrase the worker will carry out of an untrusted payload. */
const INTENT_TEXT_MAX = 2_000;
const INTENT_PHRASE_MAX = 200;
const INTENT_MAX_EDITS = 8;
const INTENT_MAX_PHRASES = 8;
const INTENT_MAX_PATHS = 20;

function intentStrings(value: unknown, cap: number, chars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.trim().length > 0,
    )
    .map((entry) => entry.slice(0, chars))
    .slice(0, cap);
}

function parseApprovedEdits(raw: unknown): ApprovedPreviewEdit[] {
  if (!Array.isArray(raw)) return [];
  const edits: ApprovedPreviewEdit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const instruction =
      typeof record['instruction'] === 'string'
        ? record['instruction'].trim().slice(0, INTENT_TEXT_MAX)
        : '';
    if (!instruction) continue;
    edits.push({
      index:
        typeof record['index'] === 'number' && Number.isInteger(record['index'])
          ? record['index']
          : edits.length + 1,
      instruction,
      changedPaths: intentStrings(
        record['changedPaths'],
        INTENT_MAX_PATHS,
        INTENT_PHRASE_MAX,
      ),
      addedPhrases: intentStrings(
        record['addedPhrases'],
        INTENT_MAX_PHRASES,
        INTENT_PHRASE_MAX,
      ),
      appliedAt:
        typeof record['appliedAt'] === 'string' ? record['appliedAt'] : '',
    });
    if (edits.length >= INTENT_MAX_EDITS) break;
  }
  return edits;
}

/**
 * What the client approved, off the job payload.
 *
 * The payload is written by flowstarter-main's deposit webhook and is the only
 * thing on the ledger row that describes the free changes a visitor made to
 * their preview before paying. It is still parsed defensively: `payload` is a
 * jsonb column, an operator can edit a row, and a malformed intent must
 * degrade to "nothing was approved" rather than reach the prompt or the
 * dropped-edit check as junk.
 *
 * Returns null for a workspace with no claimed preview — an operator-created
 * project — which is the case that must keep working untouched.
 */
export function parsePreviewIntent(payload: unknown): PreviewIntent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  const raw = (payload as Record<string, unknown>)['previewIntent'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const previewId = record['previewId'];
  if (typeof previewId !== 'string' || !UUID.test(previewId)) return null;

  const manifest =
    record['manifest'] && typeof record['manifest'] === 'object'
      ? (record['manifest'] as Record<string, unknown>)
      : {};
  const brief =
    record['brief'] && typeof record['brief'] === 'object'
      ? (record['brief'] as Record<string, unknown>)
      : {};
  const text = (value: unknown): string =>
    typeof value === 'string' ? value.slice(0, INTENT_TEXT_MAX) : '';
  const optional = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0
      ? value.slice(0, INTENT_TEXT_MAX)
      : null;

  return {
    previewId,
    manifest: {
      ref: text(manifest['ref']) || `funnel_previews:${previewId}`,
      artifactPath: optional(manifest['artifactPath']),
      templateSlug: optional(manifest['templateSlug']),
      fileCount:
        typeof manifest['fileCount'] === 'number' &&
        Number.isFinite(manifest['fileCount'])
          ? manifest['fileCount']
          : 0,
    },
    edits: parseApprovedEdits(record['edits']),
    brief: {
      businessName: text(brief['businessName']),
      niche: text(brief['niche']),
      location: text(brief['location']),
      ...(optional(brief['description'])
        ? { description: text(brief['description']) }
        : {}),
      ...(optional(brief['targetAudience'])
        ? { targetAudience: text(brief['targetAudience']) }
        : {}),
      ...(optional(brief['primaryGoal'])
        ? { primaryGoal: text(brief['primaryGoal']) }
        : {}),
      ...(optional(brief['locale']) ? { locale: text(brief['locale']) } : {}),
    },
    capturedAt: text(record['capturedAt']),
  };
}

/**
 * Integrations the full-build agent must wire up. Operators set these on the
 * job payload; the preview manifest is the fallback for projects quoted before
 * the payload carried them.
 */
export function parseRequiredIntegrations(
  payload: unknown,
  manifest: unknown,
): string[] {
  for (const source of [payload, manifest]) {
    if (!source || typeof source !== 'object' || Array.isArray(source))
      continue;
    const raw = (source as Record<string, unknown>)['requiredIntegrations'];
    if (!Array.isArray(raw)) continue;
    const integrations = raw.filter(
      (entry): entry is string =>
        typeof entry === 'string' && /^[a-z0-9][a-z0-9._-]{0,48}$/.test(entry),
    );
    if (integrations.length !== raw.length) {
      throw new JobArtifactError(
        'requiredIntegrations contains an entry that is not a plain slug',
      );
    }
    if (integrations.length > 0) return integrations;
  }
  return [];
}

/** The integration slug a booking link asks the build for. */
const CAL_COM = 'cal.com';

/**
 * The workspace's booking link, or null when it is not a Cal.com one.
 *
 * The row is operator- and client-supplied and ends up in the built site's
 * `booking.url`, so the host is checked rather than the string: a substring
 * test would wave through `https://cal.com.attacker.example/book`, and so
 * would a `startsWith`. `normalizeCalLink` is the same gate the injector
 * uses: it parses the host off the value and demands an exact `cal.com`,
 * `www.cal.com` or `app.cal.com`, so a link the worker keeps is a link the
 * embed will accept. The original string is kept, not the normalized handle,
 * because that is what the site data has always carried.
 */
function parseCalComUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return normalizeCalLink(trimmed) ? trimmed : null;
}

export function buildJobFromRows(input: {
  job: JobLedgerRow;
  projectState: string;
  artifacts: ProjectArtifactRow;
  calComUrl?: string | null;
}): FullSiteBuildJob {
  const intake = asRecord(
    input.artifacts.intake_payload,
    'intake_payload',
  ) as unknown as BusinessIntakePayload;
  if (typeof intake.projectId !== 'string' || !UUID.test(intake.projectId)) {
    throw new JobArtifactError(
      'intake_payload.projectId is not a canonical UUID',
    );
  }
  if (intake.projectId.toLowerCase() !== input.job.workspace_id.toLowerCase()) {
    throw new JobArtifactError(
      'intake_payload.projectId does not match the job workspace',
    );
  }

  const requiredIntegrations = parseRequiredIntegrations(
    input.job.payload,
    input.artifacts.preview_manifest,
  );
  const calComUrl = parseCalComUrl(input.calComUrl);
  const previewIntent = parsePreviewIntent(input.job.payload);
  if (calComUrl && !requiredIntegrations.some((slug) => slug === CAL_COM)) {
    requiredIntegrations.push(CAL_COM);
  }

  return {
    id: input.job.id,
    projectId: input.job.workspace_id,
    kind:
      input.job.kind === 'SITE_REBUILD' ? 'SITE_REBUILD' : 'FULL_SITE_BUILD',
    projectState: input.projectState as ProjectState,
    intake,
    brandConfig: asRecord(
      input.artifacts.brand_config,
      'brand_config',
    ) as unknown as BrandConfig,
    approvedPreviewFiles: parseApprovedPreviewFiles(
      input.artifacts.preview_manifest,
    ),
    requiredIntegrations,
    ...(calComUrl ? { calComUrl } : {}),
    ...(previewIntent ? { previewIntent } : {}),
  };
}

export interface SupabaseJobStoreOptions {
  maxAttempts: number;
}

/** Notes read per pass; anything beyond waits for the next boundary. */
const NOTES_PER_READ = 8;

export class SupabaseFullSiteBuildJobStore implements FullSiteBuildJobStore {
  /** Workspace per claimed job, so events do not re-read the ledger row. */
  private readonly workspaceByJob = new Map<string, string>();

  constructor(
    private readonly client: SupabaseClient,
    private readonly options: SupabaseJobStoreOptions,
  ) {}

  private async workspaceFor(jobId: string): Promise<string> {
    const known = this.workspaceByJob.get(jobId);
    if (known) return known;
    const { data, error } = await this.client
      .from('flowstarter_agent_jobs')
      .select('workspace_id')
      .eq('id', jobId)
      .maybeSingle<{ workspace_id: string }>();
    if (error) throw error;
    if (!data) throw new JobArtifactError('Job does not exist');
    this.workspaceByJob.set(jobId, data.workspace_id);
    return data.workspace_id;
  }

  async appendEvent(jobId: string, event: FullSiteBuildEvent): Promise<void> {
    const workspaceId = await this.workspaceFor(jobId);
    const { error } = await this.client
      .from('flowstarter_agent_job_events')
      .insert({
        job_id: jobId,
        workspace_id: workspaceId,
        kind: event.kind,
        actor: 'system',
        body: event.body.slice(0, 4_000),
        payload: event.payload ?? {},
      });
    if (error) throw error;
  }

  async readOperatorNotes(
    jobId: string,
    after: string | null,
  ): Promise<OperatorNote[]> {
    let query = this.client
      .from('flowstarter_agent_job_events')
      .select('id, body, actor, created_at')
      .eq('job_id', jobId)
      .eq('kind', 'note');
    if (after) query = query.gt('created_at', after);
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .limit(NOTES_PER_READ);
    if (error) throw error;
    return (data ?? []).map((row) => ({
      id: String(row.id),
      body: String(row.body),
      actor: String(row.actor),
      createdAt: String(row.created_at),
    }));
  }

  async claim(jobId: string): Promise<FullSiteBuildJob | null> {
    const { data: row, error } = await this.client
      .from('flowstarter_agent_jobs')
      .select('id, workspace_id, kind, status, attempt_count, payload')
      .eq('id', jobId)
      .maybeSingle<JobLedgerRow>();
    if (error) throw error;
    if (!row) return null;
    if (!isClaimable(row, this.options.maxAttempts)) return null;

    const now = new Date().toISOString();
    // Guarding on the exact (status, attempt_count) we read makes this an
    // atomic compare-and-set: a concurrent dispatch updates zero rows.
    const { data: claimed, error: claimError } = await this.client
      .from('flowstarter_agent_jobs')
      .update({
        status: 'running',
        attempt_count: row.attempt_count + 1,
        started_at: now,
        finished_at: null,
        error_code: null,
        error_detail: null,
        updated_at: now,
      })
      .eq('id', jobId)
      .eq('status', row.status)
      .eq('attempt_count', row.attempt_count)
      .select('id')
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return null;
    this.workspaceByJob.set(jobId, row.workspace_id);

    // Past this point the row reads `running`. FullSiteBuildWorker only starts
    // its own error handling once claim() returns, so anything that throws
    // here has to release the row itself or the job is stuck at `running`
    // forever and can never be re-dispatched.
    try {
      const { data: workspace, error: workspaceError } = await this.client
        .from('workspaces')
        .select('id, project_state, cal_com_url')
        .eq('id', row.workspace_id)
        .maybeSingle<{
          id: string;
          project_state: string;
          cal_com_url: string | null;
        }>();
      if (workspaceError) throw workspaceError;
      if (!workspace)
        throw new JobArtifactError('Build workspace does not exist');

      // Obviously-equivalent to the manual `.eq('workspace_id', ...)` this
      // replaced: `withTenant` applies the same filter structurally instead
      // of by hand, and is exercised by the static guard test.
      const { data: artifacts, error: artifactError } = await withTenant(
        this.client,
        row.workspace_id,
      )
        .from('flowstarter_project_artifacts')
        .select('intake_payload, brand_config, preview_manifest')
        .maybeSingle<ProjectArtifactRow>();
      if (artifactError) throw artifactError;
      if (!artifacts) {
        throw new JobArtifactError(
          'Workspace has no approved preview artifacts to build from',
        );
      }

      return buildJobFromRows({
        job: row,
        projectState: workspace.project_state,
        artifacts,
        calComUrl: workspace.cal_com_url,
      });
    } catch (error) {
      await this.markFailed(jobId, {
        code: 'BUILD_JOB_UNCLAIMABLE',
        detail:
          error instanceof Error ? error.message : 'Unknown claim failure',
      }).catch(() => {
        // Nothing left to do: surface the original cause, not the cleanup.
      });
      throw error;
    }
  }

  async markAgentWorking(jobId: string, worktree: GitWorktree): Promise<void> {
    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from('flowstarter_agent_jobs')
      .update({
        worktree_branch: worktree.branch,
        worktree_path: worktree.path,
        updated_at: now,
      })
      .eq('id', jobId)
      .select('workspace_id')
      .single<{ workspace_id: string }>();
    if (error) throw error;

    const { error: stateError } = await this.client
      .from('workspaces')
      .update({ project_state: ProjectState.AGENTS_WORKING })
      .eq('id', data.workspace_id)
      .eq('project_state', ProjectState.DEPOSIT_PAID);
    if (stateError) throw stateError;
  }

  /**
   * The job's payload as it stands. Results are merged into it rather than
   * replacing it: the enqueue payload records what triggered this job and on
   * what terms, and overwriting it would drop the only provenance linking a
   * shipped site back to its payment or to the publish that asked for it.
   */
  private async currentPayload(
    jobId: string,
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.client
      .from('flowstarter_agent_jobs')
      .select('payload')
      .eq('id', jobId)
      .maybeSingle<{ payload: unknown }>();
    if (error) throw error;
    const payload = data?.payload;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  }

  async markHumanQa(
    jobId: string,
    result: { commitSha: string; pullRequestUrl: string; stagingUrl: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.currentPayload(jobId);

    const { data, error } = await this.client
      .from('flowstarter_agent_jobs')
      .update({
        status: 'succeeded',
        pull_request_url: result.pullRequestUrl,
        payload: {
          ...existing,
          commitSha: result.commitSha,
          stagingUrl: result.stagingUrl,
          pullRequestUrl: result.pullRequestUrl,
        },
        finished_at: now,
        updated_at: now,
      })
      .eq('id', jobId)
      .select('workspace_id')
      .single<{ workspace_id: string }>();
    if (error) throw error;

    const { error: stateError } = await this.client
      .from('workspaces')
      .update({ project_state: ProjectState.HUMAN_QA })
      .eq('id', data.workspace_id)
      .eq('project_state', ProjectState.AGENTS_WORKING);
    if (stateError) throw stateError;
  }

  async markRebuildStarted(
    jobId: string,
    worktree: GitWorktree,
  ): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.client
      .from('flowstarter_agent_jobs')
      .update({
        worktree_branch: worktree.branch,
        worktree_path: worktree.path,
        updated_at: now,
      })
      .eq('id', jobId);
    if (error) throw error;
    // No project_state update, deliberately. A client publishing an edit is
    // not a change in where the engagement stands, and moving a LIVE_SUBSCRIPTION
    // project into AGENTS_WORKING would tell the operator board a story that
    // never happened.
  }

  async markRebuilt(
    jobId: string,
    result: { commitSha: string; pullRequestUrl: string; stagingUrl: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.currentPayload(jobId);

    const { error } = await this.client
      .from('flowstarter_agent_jobs')
      .update({
        status: 'succeeded',
        pull_request_url: result.pullRequestUrl,
        payload: {
          ...existing,
          commitSha: result.commitSha,
          stagingUrl: result.stagingUrl,
          pullRequestUrl: result.pullRequestUrl,
        },
        finished_at: now,
        updated_at: now,
      })
      .eq('id', jobId);
    if (error) throw error;
  }

  async markFailed(
    jobId: string,
    failure: { code: string; detail: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from('flowstarter_agent_jobs')
      .update({
        status: 'failed',
        error_code: failure.code,
        error_detail: failure.detail.slice(0, 2_000),
        finished_at: now,
        updated_at: now,
      })
      .eq('id', jobId)
      .select('workspace_id')
      .single<{ workspace_id: string }>();
    if (error) throw error;

    // Roll the workspace back to DEPOSIT_PAID so a retry can claim it again.
    // A project that never reached AGENTS_WORKING is left untouched.
    const { error: stateError } = await this.client
      .from('workspaces')
      .update({ project_state: ProjectState.DEPOSIT_PAID })
      .eq('id', data.workspace_id)
      .eq('project_state', ProjectState.AGENTS_WORKING);
    if (stateError) throw stateError;
  }
}
