/**
 * Supabase-backed implementation of `FullSiteBuildJobStore`.
 *
 * The ledger (`flowstarter_agent_jobs`) and the artifact row
 * (`flowstarter_project_artifacts`) are service-role only — browsers have no
 * grant on either table. Claiming is an optimistic conditional update so two
 * dispatches of the same Stripe redelivery cannot both start a build.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ProjectState,
  briefInputAssets,
  isPreviewToolingPath,
  mergeBriefIntoIntake,
  normalizeCalLink,
  parseBriefInput,
  parseChangeRequestIntent,
  withoutMissingAssets,
  type BrandConfig,
  type BriefInput,
  type BusinessIntakePayload,
  type ChangeRequestIntent,
  type FullSiteBuildEvent,
  type FullSiteBuildJob,
  type FullSiteBuildJobStore,
  type GitWorktree,
  type ApprovedPreviewEdit,
  type OperatorNote,
  type PreviewIntent,
  type TemplateScaffoldFile,
} from '@flowstarter/agentic-codegen';
import { resolvePlatformDomain } from '@flowstarter/platform-config';
import {
  loadChangeRequestAssetFiles,
  loadTenantAssetFiles,
  withChangeRequestAssets,
} from './change-request-assets';
import {
  CLAIMABLE_KINDS,
  claimVerdict,
  leaseOwner,
  nextRunAfter,
  publishedResult,
  staleLeaseAction,
  type BackoffRules,
  type LeasedJobRow,
  type PublishedResult,
} from './leases';
import { withTenant } from './tenancy';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The persisted state of a FULL_SITE_BUILD that is parked on its client.
 *
 * Before it existed, such a job sat at `queued` and `claim()` returned null on
 * every poll: correct in the ledger, invisible everywhere else. An operator
 * reading the board saw a queued build that nobody was running, which is
 * indistinguishable from the failure mode the board exists to catch (a dropped
 * dispatch), and after fifteen minutes it was reported as exactly that.
 *
 * Making it a status rather than a comment means the board, the client's
 * dashboard, the reconciler and the claim rule all read the same fact from the
 * same column, and a job in it can be found by a query instead of by inferring
 * it from the absence of activity.
 */
export const WAITING_BRIEF = 'waiting_brief';

/** The two columns of `workspace_briefs` a claim decision is made from. */
interface WorkspaceBriefRow {
  ready_at: string | null;
  override_at: string | null;
}

/**
 * The in-depth brief the site is written from lives on the client's dashboard
 * and is filled in after the deposit. Until it is ready, a FULL_SITE_BUILD has
 * nothing true to build from, so it waits.
 *
 * This is a deliberate three-line copy of `briefAllowsBuild` in
 * `apps/flowstarter-main/src/lib/flowstarter/brief-readiness.ts`. The
 * duplication is the cheaper of two bad options: this worker is a separate
 * deployable with its own package.json, its own tsconfig and no dependency on
 * the Next app, and importing from `apps/flowstarter-main` would drag a whole
 * Next application into a container whose only job is to run an agent over a
 * checkout. `packages/agentic-codegen` was the other candidate and was
 * rejected because that package is the shared domain vocabulary, while this
 * rule is about one column in one table that exactly two call sites read. If a
 * third reader ever appears, move it there rather than copy it again.
 *
 * Two ways through, matching that module exactly: the brief is ready, or an
 * operator has said build it anyway. A missing row is neither, and is not an
 * error: it means the client has not opened the brief page yet.
 */
function briefAllowsBuild(brief: WorkspaceBriefRow | null): boolean {
  return Boolean(brief?.ready_at) || Boolean(brief?.override_at);
}

/**
 * The marker on the ledger event that says a job is parked on its client, not
 * broken. Read back before another one is written, so a poll every few seconds
 * does not produce a wall of identical lines on the operator board.
 */
const WAITING_ON_BRIEF = 'brief';

const WAITING_ON_BRIEF_BODY =
  'Waiting on the client brief. The build is queued and will start by itself ' +
  'once the brief is complete, or when an operator overrides it.';

export class JobArtifactError extends Error {}

export interface JobLedgerRow extends LeasedJobRow {
  id: string;
  workspace_id: string;
  kind: string;
  status: string;
  attempt_count: number;
  payload: unknown;
}

/** Every column a claim or a recovery decision is made from. */
const LEDGER_COLUMNS =
  'id, workspace_id, kind, status, attempt_count, max_attempts, run_after, ' +
  'started_at, leased_by, lease_expires_at, payload';

export interface ProjectArtifactRow {
  intake_payload: unknown;
  brand_config: unknown;
  preview_manifest: unknown;
}

/**
 * True when the ledger row is in a state a worker may take over.
 *
 * `succeeded` and `canceled` are still excluded outright, so a Stripe
 * redelivery collapses into a no-op rather than a second build. `running` is
 * no longer excluded outright — it is excluded *while its lease holds*, which
 * is the whole point of the lease: a worker that died mid-build leaves a
 * `running` row whose lease stops being renewed, and the next worker (or an
 * operator re-dispatch) may take it back rather than leaving a paid job
 * stranded forever. The rule itself lives in `leases.ts`.
 */
export function isClaimable(
  row: JobLedgerRow,
  maxAttempts: number,
  rules: { now?: number; leaseTtlMs?: number } = {},
): boolean {
  return claimVerdict(row, {
    now: rules.now ?? Date.now(),
    maxAttempts,
    leaseTtlMs: rules.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
  }).claimable;
}

/**
 * The TTL used when a caller does not supply one. Matches the config default
 * so a two-argument `isClaimable` answers the same question the worker does.
 */
export const DEFAULT_LEASE_TTL_MS = 120_000;

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
  const seeded: TemplateScaffoldFile[] = [];
  files.forEach((entry, index) => {
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
    // Tooling and build state is skipped rather than rejected. Manifests
    // captured before the app stopped writing them still carry `.astro/`,
    // `node_modules/` and lockfiles, and materializing a dev server's scratch
    // directory into a build worktree is how a paid build ends up being
    // checked against a process id. A skipped file is never a reason to fail
    // a build somebody paid for.
    if (isPreviewToolingPath(path)) return;
    seeded.push({
      path,
      content,
      ...(encoding === 'base64' ? { encoding } : {}),
      type: 'file',
    } satisfies TemplateScaffoldFile);
  });
  if (seeded.length === 0) {
    throw new JobArtifactError(
      'preview_manifest.files held no site files once tooling state was skipped',
    );
  }
  return seeded;
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

/**
 * Where this workspace's contact form posts, or null.
 *
 * Two things decide it and neither is in the job payload: the workspace's own
 * `lead_capture_token`, and the platform host this process belongs to, which
 * `resolvePlatformDomain()` reads from its own environment. That is why the
 * URL is assembled here rather than sent by whoever queued the job - a build
 * worker running against the dev zone must not write a production endpoint
 * into a site because a queued row said so.
 *
 * The token shape is checked rather than trusted for the same reason the Cal
 * link's host is: this string ends up in public HTML, and a token carrying a
 * slash or a dot would either change the path or collide with the preview
 * token shape the endpoint refuses.
 */
const LEAD_CAPTURE_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

function leadCaptureEndpointFor(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  if (!LEAD_CAPTURE_TOKEN.test(token)) return null;
  return `https://${resolvePlatformDomain()}/api/leads/capture/${token}`;
}

/** The three kinds this worker runs, off the ledger row's free-text column. */
function jobKindFor(kind: string): FullSiteBuildJob['kind'] {
  if (kind === 'SITE_REBUILD') return 'SITE_REBUILD';
  if (kind === 'CHANGE_REQUEST_BUILD') return 'CHANGE_REQUEST_BUILD';
  return 'FULL_SITE_BUILD';
}

export function buildJobFromRows(input: {
  job: JobLedgerRow;
  projectState: string;
  artifacts: ProjectArtifactRow;
  calComUrl?: string | null;
  /** Raw `workspaces.lead_capture_token`; the endpoint is built from it here. */
  leadCaptureToken?: string | null;
  /**
   * The client's own pictures, already downloaded and verified, appended to
   * the seed manifest. A CHANGE_REQUEST_BUILD's are the files the request
   * names; a FULL_SITE_BUILD's are the brief's, and the prompt gives the agent
   * their paths in both cases.
   */
  changeRequestAssetFiles?: readonly TemplateScaffoldFile[];
  /**
   * The in-depth brief, with every asset that could not be delivered already
   * removed, or null for a workspace that has none.
   */
  briefInput?: BriefInput | null;
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
  const leadCaptureEndpoint = leadCaptureEndpointFor(input.leadCaptureToken);
  const previewIntent = parsePreviewIntent(input.job.payload);
  const kind = jobKindFor(input.job.kind);
  const changeRequest =
    kind === 'CHANGE_REQUEST_BUILD'
      ? parseChangeRequestIntent(input.job.payload)
      : null;
  if (calComUrl && !requiredIntegrations.some((slug) => slug === CAL_COM)) {
    requiredIntegrations.push(CAL_COM);
  }

  // The brief laid over the intake the preview was approved from. This is the
  // whole point of the exercise: `intake_payload` was frozen before the client
  // was ever asked what they sell or what they have built, and every rule
  // downstream -- the page-set budget, the invented-project gate, the prompt
  // itself -- reads those fields off the intake.
  const briefInput = input.briefInput ?? null;
  const mergedIntake = mergeBriefIntoIntake(intake, briefInput);

  return {
    id: input.job.id,
    projectId: input.job.workspace_id,
    kind,
    projectState: input.projectState as ProjectState,
    intake: mergedIntake,
    brandConfig: asRecord(
      input.artifacts.brand_config,
      'brand_config',
    ) as unknown as BrandConfig,
    approvedPreviewFiles: withChangeRequestAssets(
      parseApprovedPreviewFiles(input.artifacts.preview_manifest),
      input.changeRequestAssetFiles ?? [],
    ),
    requiredIntegrations,
    ...(calComUrl ? { calComUrl } : {}),
    ...(leadCaptureEndpoint ? { leadCaptureEndpoint } : {}),
    ...(previewIntent ? { previewIntent } : {}),
    ...(changeRequest ? { changeRequest } : {}),
    ...(briefInput ? { briefInput } : {}),
  };
}

/**
 * The change request on a claimed job, or null for the other two kinds.
 *
 * Exported so the claim path and its tests read the payload the same way.
 */
export function changeRequestFor(
  row: JobLedgerRow,
): ChangeRequestIntent | null {
  if (row.kind !== 'CHANGE_REQUEST_BUILD') return null;
  return parseChangeRequestIntent(row.payload);
}

export interface SupabaseJobStoreOptions {
  maxAttempts: number;
  /** How long a claim is good for without a heartbeat. */
  leaseTtlMs?: number;
  /** Who this process says it is on the rows it holds. */
  owner?: string;
  /** Retry scheduling, written onto `run_after` when an attempt fails. */
  backoff?: BackoffRules;
  /** Injected in tests. */
  now?: () => number;
}

/** Recovery/backoff defaults, matched to `config.ts`. */
const DEFAULT_BACKOFF: BackoffRules = { baseMs: 30_000, maxMs: 900_000 };

/** Rows one reconciliation pass will look at. Bounded on purpose. */
const RECONCILE_LIMIT = 100;

/** What one startup reconciliation did, for the operator log. */
export interface ReconciliationReport {
  /** Rows that were `running` with a dead lease and are queued again. */
  requeued: string[];
  /** Rows whose site had already shipped; finished without rebuilding. */
  completed: string[];
  /** Rows out of attempts; failed so an operator sees them. */
  abandoned: string[];
}

/** Notes read per pass; anything beyond waits for the next boundary. */
const NOTES_PER_READ = 8;

export class SupabaseFullSiteBuildJobStore implements FullSiteBuildJobStore {
  /** Workspace per claimed job, so events do not re-read the ledger row. */
  private readonly workspaceByJob = new Map<string, string>();

  /** Identity written into `leased_by`. Stable for the life of the process. */
  private readonly owner: string;
  private readonly leaseTtlMs: number;
  private readonly backoff: BackoffRules;
  private readonly now: () => number;

  constructor(
    private readonly client: SupabaseClient,
    private readonly options: SupabaseJobStoreOptions,
  ) {
    this.owner =
      options.owner ??
      leaseOwner({
        hostname: hostname(),
        pid: process.pid,
        nonce: randomBytes(4).toString('hex'),
      });
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.now = options.now ?? (() => Date.now());
  }

  /** Who this worker says it is. Exposed so the boot log can name it. */
  get leaseHolder(): string {
    return this.owner;
  }

  /**
   * Attempts on a job this worker claimed, remembered from the claim rather
   * than re-read. Backoff grows with the attempt number, and re-reading it in
   * the failure path would cost a query at exactly the moment things are
   * already going wrong. Unknown (a failure recorded for a job this process
   * never claimed) reads as the first attempt, which is the gentler answer.
   */
  private readonly attemptsByJob = new Map<string, number>();

  private attemptsSoFar(jobId: string): number {
    return this.attemptsByJob.get(jobId) ?? 1;
  }

  private leaseRules(): {
    now: number;
    maxAttempts: number;
    leaseTtlMs: number;
  } {
    return {
      now: this.now(),
      maxAttempts: this.options.maxAttempts,
      leaseTtlMs: this.leaseTtlMs,
    };
  }

  /** The lease columns a claim or a renewal writes. */
  private leaseFields(now: number): Record<string, unknown> {
    return {
      leased_by: this.owner,
      lease_expires_at: new Date(now + this.leaseTtlMs).toISOString(),
    };
  }

  /**
   * Pushes this worker's lease forward while a build is genuinely running.
   *
   * Guarded on `leased_by`, so a worker whose lease already expired and was
   * taken by somebody else cannot claw it back and end up writing the same
   * worktree as the process that now owns it. Returns false in that case,
   * which is the caller's signal to stop.
   */
  async heartbeat(jobId: string): Promise<boolean> {
    const now = this.now();
    const { data, error } = await this.client
      .from('flowstarter_agent_jobs')
      .update({
        ...this.leaseFields(now),
        updated_at: new Date(now).toISOString(),
      })
      .eq('id', jobId)
      .eq('status', 'running')
      .eq('leased_by', this.owner)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  /**
   * Startup reconciliation: the thing that was missing.
   *
   * Every `running` row whose lease has died is a build whose worker is gone.
   * One of three things is true of it, and the rule in `leases.ts` says which:
   * the site already shipped and only the ledger is behind (finish it, publish
   * nothing twice); attempts remain (queue it again, due now); or the budget is
   * spent (fail it, so it appears on the operator board instead of looping).
   *
   * Returns what it did rather than logging it, so the caller can say it once
   * in the worker's own voice and tests can assert on it.
   */
  async reconcileStaleLeases(): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      requeued: [],
      completed: [],
      abandoned: [],
    };
    const { data, error } = await this.client
      .from('flowstarter_agent_jobs')
      .select(LEDGER_COLUMNS)
      .eq('status', 'running')
      .in('kind', Array.from(CLAIMABLE_KINDS))
      .order('updated_at', { ascending: true })
      .limit(RECONCILE_LIMIT);
    if (error) throw error;

    for (const raw of (data ?? []) as unknown as JobLedgerRow[]) {
      const decision = staleLeaseAction(raw, this.leaseRules());
      if (decision.action === 'leave') continue;
      if (decision.action === 'complete') {
        // Idempotent publication. The build already pushed its commit and
        // opened its PR; all that is missing is the row that says so.
        await this.completePublished(raw, decision.published);
        report.completed.push(raw.id);
        continue;
      }
      if (decision.action === 'abandon') {
        await this.markFailed(raw.id, {
          code: 'BUILD_LEASE_EXPIRED',
          detail:
            'The worker holding this build stopped without finishing it, and ' +
            'its retry budget is spent. Re-dispatch it to grant one more attempt.',
        });
        report.abandoned.push(raw.id);
        continue;
      }
      const requeued = await this.requeueExpired(raw);
      if (requeued) report.requeued.push(raw.id);
    }
    return report;
  }

  /**
   * Puts one abandoned build back in the queue.
   *
   * Guarded on the exact lease it was reconciled from, so two workers starting
   * at once cannot both re-queue it — and a worker that came back to life
   * between the read and the write keeps its job.
   */
  private async requeueExpired(row: JobLedgerRow): Promise<boolean> {
    const now = this.now();
    const update = this.client
      .from('flowstarter_agent_jobs')
      .update({
        status: 'queued',
        started_at: null,
        leased_by: null,
        lease_expires_at: null,
        // Due immediately: the wait already happened, in the form of a build
        // that ran and died. Backoff is for attempts that failed, not for
        // attempts that were interrupted.
        run_after: new Date(now).toISOString(),
        error_code: 'BUILD_LEASE_EXPIRED',
        error_detail:
          'The worker holding this build stopped without finishing it. It was ' +
          'returned to the queue by startup reconciliation.',
        updated_at: new Date(now).toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'running');
    const guarded = row.leased_by
      ? update.eq('leased_by', row.leased_by)
      : update.is('leased_by', null);
    const { data, error } = await guarded.select('id').maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  /**
   * Finishes a row whose build already published, without rebuilding it.
   *
   * The three completion paths differ in what else they touch — a full build
   * moves the workspace to HUMAN_QA, a rebuild moves nothing — so this
   * delegates to the same methods the happy path uses rather than writing a
   * fourth variant of "succeeded". A change-request build is deliberately not
   * completed here: its last step also flips the request paid -> done and
   * stamps a site version, and guessing at those from a payload is how a
   * client gets told a change shipped that did not. Those are re-queued and
   * rebuilt instead, which their own compare-and-set makes safe.
   */
  private async completePublished(
    row: JobLedgerRow,
    published: PublishedResult,
  ): Promise<void> {
    this.workspaceByJob.set(row.id, row.workspace_id);
    if (row.kind === 'FULL_SITE_BUILD') {
      await this.markHumanQa(row.id, published);
      return;
    }
    if (row.kind === 'SITE_REBUILD') {
      await this.markRebuilt(row.id, published);
      return;
    }
    await this.requeueExpired(row);
  }

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

  /**
   * The workspace's brief row, or null when there is not one yet.
   *
   * A missing row is the ordinary case for a client who paid ten minutes ago
   * and has not opened the brief page, so it reads as "not ready" rather than
   * as a failure. A Supabase error is a different thing entirely and is
   * thrown: a database that cannot be read must never be mistaken for a client
   * who has not answered, because the two have opposite consequences.
   */
  private async readBrief(
    workspaceId: string,
  ): Promise<WorkspaceBriefRow | null> {
    const { data, error } = await withTenant(this.client, workspaceId)
      .from('workspace_briefs')
      .select('ready_at, override_at')
      .maybeSingle<WorkspaceBriefRow>();
    if (error) throw error;
    return data ?? null;
  }

  /**
   * Says once, on the ledger, that this job is waiting on its client.
   *
   * The dispatcher polls, so the naive version of this writes one identical
   * event every few seconds for as long as a client takes to fill in a form,
   * which is days. Two cheaper designs were considered and rejected: a unique
   * index (a migration, for a log table), and a per-process memo (wrong the
   * moment there are two workers, and reset by every deploy). What is left is
   * a read of the job's own most recent event: if it is already the waiting
   * one, nothing is written. That is one bounded single-row read per poll,
   * correct across processes and restarts, and self-clearing -- once a build
   * runs and writes a phase of its own, a later wait is said again, which is
   * right, because by then it is news.
   *
   * Never throws. A ledger line is commentary, and failing to write one is not
   * a reason to turn a job that is merely waiting into a job that errored.
   */
  private async noteWaitingOnBrief(row: JobLedgerRow): Promise<void> {
    try {
      // Primes the cache `appendEvent` reads, so saying this costs no second
      // lookup of a workspace this method was handed.
      this.workspaceByJob.set(row.id, row.workspace_id);

      const { data, error } = await withTenant(this.client, row.workspace_id)
        .from('flowstarter_agent_job_events')
        .select('payload')
        .eq('job_id', row.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<{ payload: unknown }>();
      if (error) throw error;

      const payload = data?.payload;
      const last =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)['waitingOn']
          : undefined;
      if (last === WAITING_ON_BRIEF) return;

      await this.appendEvent(row.id, {
        kind: 'phase',
        body: WAITING_ON_BRIEF_BODY,
        payload: { waitingOn: WAITING_ON_BRIEF },
      });
    } catch (error) {
      console.warn(
        `[job-store] could not record the brief wait for job ${row.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Parks a job on its client: the status moves to `waiting_brief` and the
   * ledger says so once.
   *
   * The status write is guarded on the exact status that was read, so two
   * workers polling the same job cannot both move it, and a job that another
   * process claimed between the read and here is left alone. `attempt_count`
   * is deliberately untouched -- waiting is not an attempt, and burning the
   * budget of a build with nothing wrong with it is how a client who filled
   * their brief in on Friday got a permanently unclaimable job on Monday.
   *
   * Never throws. A job that stays `queued` because this write failed is
   * exactly the behaviour that shipped before the status existed, and that is
   * not a reason to fail a claim.
   */
  private async parkOnBrief(row: JobLedgerRow): Promise<void> {
    if (row.status !== WAITING_BRIEF) {
      try {
        const now = new Date().toISOString();
        const { error } = await this.client
          .from('flowstarter_agent_jobs')
          .update({
            status: WAITING_BRIEF,
            updated_at: now,
            // Ordinarily already null. Not so for the one row that can reach
            // here holding a lease: a build recovered from a dead worker whose
            // client has since re-opened their brief. Parking it while a dead
            // holder is still named on it would make the next sweep read it
            // as somebody else's.
            leased_by: null,
            lease_expires_at: null,
          })
          .eq('id', row.id)
          .eq('status', row.status);
        if (error) throw error;
      } catch (error) {
        console.warn(
          `[job-store] could not park job ${row.id} on its brief:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    await this.noteWaitingOnBrief(row);
  }

  /**
   * The brief material for a FULL_SITE_BUILD, and the files it needs on disk.
   *
   * Two things happen here and both are re-checks rather than reads of the
   * payload's word. The storage path comes off the `assets` row through
   * `withTenant`, and `rights_confirmed_at` is read again at build time --
   * rights are a statement a client can withdraw, and this is the last moment
   * before those bytes are on a public website. Anything undeliverable is
   * dropped from the files *and* from the brief, so the paragraph the agent
   * is given never names a path with nothing behind it.
   */
  private async loadBriefMaterial(row: JobLedgerRow): Promise<{
    briefInput: BriefInput | null;
    files: TemplateScaffoldFile[];
  }> {
    if (row.kind !== 'FULL_SITE_BUILD') return { briefInput: null, files: [] };
    const parsed = parseBriefInput(row.payload);
    if (!parsed) return { briefInput: null, files: [] };

    const wanted = briefInputAssets(parsed);
    const { files, skipped } = await loadTenantAssetFiles({
      client: this.client,
      workspaceId: row.workspace_id,
      assets: wanted,
      onMissing: 'skip',
    });
    if (skipped.length > 0) {
      // Said out loud rather than swallowed: a client whose photograph is
      // missing from their finished site is owed an answer, and the answer is
      // on the job's own timeline before the build starts.
      await this.appendEvent(row.id, {
        kind: 'log',
        body:
          `${skipped.length} file(s) named by the brief could not be used and ` +
          'are not on this build: ' +
          skipped.map((entry) => entry.reason).join(' '),
        payload: { skippedAssetIds: skipped.map((entry) => entry.assetId) },
      }).catch(() => {
        // Commentary. Losing it is not a reason to fail a paid build.
      });
    }
    const delivered = new Set(files.map((file) => file.path));
    return { briefInput: withoutMissingAssets(parsed, delivered), files };
  }

  async claim(jobId: string): Promise<FullSiteBuildJob | null> {
    const { data: row, error } = await this.client
      .from('flowstarter_agent_jobs')
      .select(LEDGER_COLUMNS)
      .eq('id', jobId)
      .maybeSingle<JobLedgerRow>();
    if (error) throw error;
    if (!row) return null;

    const rules = this.leaseRules();
    const verdict = claimVerdict(row, rules);
    if (!verdict.claimable) return null;

    // Taking over a dead lease is not the same as starting fresh. If the
    // worker that held it got as far as publishing, the commit is pushed, the
    // PR is open and the client's site exists; the only thing missing is the
    // row that says so. Finishing it here is what makes publication
    // idempotent — building it again would open a second PR for work that
    // already shipped.
    if (verdict.recovered) {
      const published = publishedResult(row.payload);
      if (published) {
        await this.completePublished(row, published);
        return null;
      }
    }

    // The brief gate, before the compare-and-set and not after it: a job that
    // is waiting on its client must be left exactly as it is, `queued`, with
    // its attempt budget untouched. Flipping it to `running` and back would
    // burn an attempt per poll and would eventually exhaust the budget of a
    // build that never had anything wrong with it.
    //
    // FULL_SITE_BUILD only. A SITE_REBUILD is a rebuild of a site that already
    // exists and was already built from a brief -- a client publishing an edit
    // months later -- so gating it would strand their own change behind a form
    // they finished long ago.
    if (row.kind === 'FULL_SITE_BUILD') {
      const brief = await this.readBrief(row.workspace_id);
      if (!briefAllowsBuild(brief)) {
        await this.parkOnBrief(row);
        return null;
      }
    }

    const now = new Date(rules.now).toISOString();
    // Guarding on the exact (status, attempt_count) we read makes this an
    // atomic compare-and-set: a concurrent dispatch updates zero rows. The
    // lease is written in the same statement, so there is no window where a
    // row reads `running` with nobody named on it.
    const claimQuery = this.client
      .from('flowstarter_agent_jobs')
      .update({
        status: 'running',
        attempt_count: row.attempt_count + 1,
        started_at: now,
        finished_at: null,
        error_code: null,
        error_detail: null,
        updated_at: now,
        ...this.leaseFields(rules.now),
      })
      .eq('id', jobId)
      .eq('status', row.status)
      .eq('attempt_count', row.attempt_count);
    // Recovering a dead lease guards on the dead holder too, so two workers
    // reconciling the same abandoned build cannot both take it.
    const guarded = row.leased_by
      ? claimQuery.eq('leased_by', row.leased_by)
      : claimQuery.is('leased_by', null);
    const { data: claimed, error: claimError } = await guarded
      .select('id')
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return null;
    this.workspaceByJob.set(jobId, row.workspace_id);
    this.attemptsByJob.set(jobId, row.attempt_count + 1);

    // Past this point the row reads `running`. FullSiteBuildWorker only starts
    // its own error handling once claim() returns, so anything that throws
    // here has to release the row itself or the job is stuck at `running`
    // forever and can never be re-dispatched.
    try {
      const { data: workspace, error: workspaceError } = await this.client
        .from('workspaces')
        .select('id, project_state, cal_com_url, lead_capture_token')
        .eq('id', row.workspace_id)
        .maybeSingle<{
          id: string;
          project_state: string;
          cal_com_url: string | null;
          lead_capture_token: string | null;
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

      // The client's own pictures are fetched at claim time, alongside the
      // manifest, so a change request whose files have been deleted or whose
      // rights have been withdrawn fails here -- before an agent spends
      // minutes building a site that the applied-change gate would then fail
      // anyway with a much worse explanation.
      const changeRequest = changeRequestFor(row);
      const changeRequestAssetFiles = changeRequest
        ? await loadChangeRequestAssetFiles({
            client: this.client,
            workspaceId: row.workspace_id,
            assets: changeRequest.assets,
          })
        : [];

      // The brief's own files, fetched the same way and at the same moment,
      // for the same reason: a build that discovers a missing picture three
      // agent-minutes in explains itself far worse than one that resolves
      // every path before it starts.
      const brief = await this.loadBriefMaterial(row);

      return buildJobFromRows({
        job: row,
        projectState: workspace.project_state,
        artifacts,
        calComUrl: workspace.cal_com_url,
        changeRequestAssetFiles: [...changeRequestAssetFiles, ...brief.files],
        briefInput: brief.briefInput,
        leadCaptureToken: workspace.lead_capture_token,
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

  /**
   * Jobs this worker should be running but was never told about.
   *
   * Dispatch is a nudge over HTTP from a Next.js process to this one. Every
   * way that nudge can be lost leaves a row that is a promise to a paying
   * client and a process that will never look at it again: the worker was
   * restarting, the host was unreachable, the deploy replaced the container
   * mid-flight, or -- the case this was written for -- the job was parked on
   * a brief that the client finished at two in the morning while nothing was
   * listening.
   *
   * So the queue is read from the database rather than remembered in this
   * process. Four kinds of row come back:
   *
   *   - `queued` and due (`run_after` has passed), which is a dispatch that
   *     did not arrive.
   *   - `failed` and due, which is a retry whose backoff has elapsed. The
   *     backoff is on the row (`markFailed` writes it), so a worker that
   *     restarted between attempts still honours it.
   *   - `waiting_brief` whose workspace now allows a build. Those are promoted
   *     to `queued` here, guarded on the status that was read, so of two
   *     workers sweeping at once exactly one takes each job and the board
   *     never shows a build as parked while it is running.
   *   - `running` whose lease has expired, which is a build whose worker died.
   *     They are handed over as they are: `claim()` re-reads the row, refuses
   *     it if the holder started checking in again, and finishes it without
   *     rebuilding if it turns out to have published already. Promoting them
   *     here would throw away the lease that makes that decision possible.
   *
   * Every one of these is a rule in `leases.ts` rather than a condition
   * written twice: this asks the database for the candidates and `claimVerdict`
   * says which of them this worker may take.
   */
  async readyForClaim(limit: number): Promise<string[]> {
    const rules = this.leaseRules();
    const { data, error } = await this.client
      .from('flowstarter_agent_jobs')
      .select(LEDGER_COLUMNS)
      .in('status', ['queued', 'failed', 'running', WAITING_BRIEF])
      .in('kind', Array.from(CLAIMABLE_KINDS))
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;

    const rows = (data ?? []) as unknown as JobLedgerRow[];
    const ready: string[] = [];

    for (const row of rows) {
      // One rule, asked once: attempts, backoff, and whether anybody still
      // holds this job. A `waiting_brief` row passes it the same way a queued
      // one does, because the thing that decides a parked job is the brief,
      // not the lease.
      if (!claimVerdict(row, rules).claimable) continue;

      if (row.status !== WAITING_BRIEF) {
        ready.push(row.id);
        continue;
      }
      const brief = await this.readBrief(row.workspace_id);
      if (!briefAllowsBuild(brief)) continue;
      const { data: promoted, error: promoteError } = await this.client
        .from('flowstarter_agent_jobs')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('status', WAITING_BRIEF)
        .select('id')
        .maybeSingle();
      if (promoteError) throw promoteError;
      if (promoted) ready.push(row.id);
    }
    return ready;
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
        leased_by: null,
        lease_expires_at: null,
      })
      .eq('id', jobId)
      .select('workspace_id')
      .single<{ workspace_id: string }>();
    if (error) throw error;
    this.attemptsByJob.delete(jobId);

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
        leased_by: null,
        lease_expires_at: null,
      })
      .eq('id', jobId);
    if (error) throw error;
    this.attemptsByJob.delete(jobId);
  }

  async markChangeRequestBuildStarted(
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
    // No project_state update, for the same reason a rebuild makes none: a
    // client who has paid for one more section has not gone back into the
    // build pipeline, and moving a LIVE_SUBSCRIPTION project into
    // AGENTS_WORKING would tell the operator board a story that never
    // happened.
  }

  /**
   * The finished change, saved as the site's next version.
   *
   * This is the same two writes `saveSiteVersion` does in the main app -- a
   * new `site_versions` row and a mirror into the artifact manifest the worker
   * and the deploy path both read -- restated here because this process has no
   * access to that module. Nothing is marked published yet: that happens only
   * after the deploy has actually succeeded.
   *
   * The version number is taken under an insert that will fail on the table's
   * own (workspace_id, version) uniqueness if a client publish lands in the
   * same moment, and the retry re-reads rather than assuming.
   */
  async saveChangeRequestVersion(
    jobId: string,
    input: { changeRequestId: string; files: TemplateScaffoldFile[] },
  ): Promise<{ version: number }> {
    const workspaceId = await this.workspaceFor(jobId);
    const manifest = { files: input.files };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { data: latest, error: readError } = await withTenant(
        this.client,
        workspaceId,
      )
        .from('site_versions')
        .select('version')
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle<{ version: number }>();
      if (readError) throw readError;

      const next = (latest?.version ?? 0) + 1;
      const { error } = await withTenant(this.client, workspaceId)
        .from('site_versions')
        .insert({
          version: next,
          manifest,
          summary: `Paid change request ${input.changeRequestId}`,
          created_by: `system:change_request_build:${jobId}`,
        });
      if (error) {
        if (error.code === '23505') continue;
        throw error;
      }

      const { error: mirrorError } = await withTenant(this.client, workspaceId)
        .from('flowstarter_project_artifacts')
        .update({
          preview_manifest: manifest,
          updated_at: new Date().toISOString(),
        });
      if (mirrorError) throw mirrorError;

      return { version: next };
    }
    throw new JobArtifactError(
      'Could not take a site version number for the finished change request',
    );
  }

  /**
   * The last thing a change-request build does, and the only thing that tells
   * anybody the work shipped.
   *
   * The move to `done` is a compare-and-set on `paid`, so a redelivered job, a
   * second attempt, or an operator who marked it done by hand in the meantime
   * cannot produce a second completion -- and, more importantly, a build that
   * crashed before reaching this line leaves the request exactly where it was.
   * A request that reads `done` always means a site that went live.
   */
  async markChangeRequestBuilt(
    jobId: string,
    result: {
      commitSha: string;
      pullRequestUrl: string;
      stagingUrl: string;
      changeRequestId: string;
      version: number;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const workspaceId = await this.workspaceFor(jobId);
    const existing = await this.currentPayload(jobId);

    // The version is the one the client is about to be told about, so it is
    // stamped published before the request claims to be done.
    const { error: unpublishError } = await withTenant(this.client, workspaceId)
      .from('site_versions')
      .update({ published_at: null })
      .not('published_at', 'is', null);
    if (unpublishError) throw unpublishError;
    const { error: publishError } = await withTenant(this.client, workspaceId)
      .from('site_versions')
      .update({ published_at: now })
      .eq('version', result.version);
    if (publishError) throw publishError;

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
          builtVersion: result.version,
        },
        finished_at: now,
        updated_at: now,
        leased_by: null,
        lease_expires_at: null,
      })
      .eq('id', jobId);
    if (error) throw error;
    this.attemptsByJob.delete(jobId);

    const { data: done, error: doneError } = await withTenant(
      this.client,
      workspaceId,
    )
      .from('flowstarter_change_requests')
      .update({
        status: 'done',
        completed_at: now,
        completed_via: 'build',
        built_version: result.version,
        build_job_id: jobId,
        updated_at: now,
      })
      .eq('id', result.changeRequestId)
      .eq('status', 'paid')
      .select('id');
    if (doneError) throw doneError;
    if (!done || done.length === 0) {
      // Loud rather than silent: the site is live and the ledger disagrees,
      // which is exactly the state an operator has to be able to see.
      throw new JobArtifactError(
        `Change request ${result.changeRequestId} was not at paid when its ` +
          'build finished, so it was not marked done. The site is live in ' +
          `version ${result.version}.`,
      );
    }
  }

  /**
   * A failed attempt, with its next one scheduled.
   *
   * `run_after` is the backoff, recorded on the row rather than held in a
   * timer: a worker that restarts between attempts still honours it, and an
   * operator can see when the next try is due. The status stays `failed` — the
   * operator board reads that word and offers a re-dispatch — and the claim
   * rule already treats `failed` as claimable once the row is due and attempts
   * remain, so the retry needs no separate scheduler.
   *
   * The lease is dropped in the same write. A failed row nobody holds is what
   * lets the very next sweep pick the retry up.
   */
  async markFailed(
    jobId: string,
    failure: { code: string; detail: string },
  ): Promise<void> {
    const at = this.now();
    const now = new Date(at).toISOString();
    const { data, error } = await this.client
      .from('flowstarter_agent_jobs')
      .update({
        status: 'failed',
        error_code: failure.code,
        error_detail: failure.detail.slice(0, 2_000),
        finished_at: now,
        updated_at: now,
        leased_by: null,
        lease_expires_at: null,
        run_after: nextRunAfter(at, this.attemptsSoFar(jobId), this.backoff),
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
