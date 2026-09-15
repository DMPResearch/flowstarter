/**
 * How far a build got, and what the next attempt is therefore allowed to skip.
 *
 * Before this module a build job had exactly one durable fact about its own
 * progress: `attempt_count`. Everything else a run learned about itself —
 * which gates it passed, what it packaged, how close it came — lived in the
 * process that learned it and died with the attempt. That is fine while the
 * expensive half and the fragile half are the same half. They are not.
 *
 * Run 9 of workspace `ba3e9323` (2026-09-12) is the proof. Attempt 2 built the
 * site, passed every gate, and packaged a correct 6,711,757-byte artifact.
 * Then the deploy failed twice for reasons that had nothing to do with the
 * site: the workspace had no host allocated (409 `workspace_unallocated`), and
 * then the deploy-agent could not fetch the tarball (502, artifact 404).
 * Attempt 3 re-ran the whole generation from scratch — a gate-passed artifact
 * sitting on disk the entire time — and died with
 * `Pi run budget exceeded during "preview_generate": used 1008794 of 1000000
 * tokens`. The job is terminal, three attempts spent, and the thing the client
 * paid for exists and is simply not on a server.
 *
 * Two rules come out of that, and both are stated here rather than inferred at
 * any call site:
 *
 * 1. **A build that has a gate-passed artifact and failed on the deploy side
 *    resumes at the deploy side.** It re-uses the same bytes, by the same
 *    sha256, and spends no generation budget. Generation re-runs only when
 *    there is no artifact, or when what failed was generation or a gate.
 * 2. **A deploy-side failure is not a generation attempt.** The two are
 *    counted separately, against their own named limits, because they fail for
 *    unrelated reasons and cost unrelated amounts.
 *
 * Everything in this file is a pure function of a job payload. The Supabase
 * writes that act on these verdicts live in `apps/build-worker/src/job-store.ts`,
 * the claim rule that reads them lives in `apps/build-worker/src/leases.ts`,
 * and the operator action that re-queues a terminal job for deploy only lives
 * in `apps/flowstarter-main/src/lib/flowstarter/pipeline/api.ts`. Four readers,
 * one rule.
 */

import type { FlowstarterBuildKind } from './worktree';

/**
 * The phases of a build, in the order they happen.
 *
 * This is deliberately a short list of *sides*, not a transcript. The prose
 * phases the pipeline already narrates ("Checking for placeholder copy",
 * "Publishing for review") are a far richer sequence, and they are the right
 * vocabulary for a person reading a timeline. They are the wrong vocabulary
 * for a retry decision, because a rule that had to enumerate them would be
 * wrong the first time somebody added a gate. Each prose phase belongs to
 * exactly one of these, and the mapping is made by the worker as it announces
 * them, not by matching strings here.
 */
export const BUILD_PHASES = [
  /** Worktree, seed, integrations — before an agent has cost anything. */
  'preparing',
  /** Agent passes and their repair passes. Where the token budget goes. */
  'generating',
  /** The output gates, and the build check that feeds them. */
  'gating',
  /** The local commit. Cheap, reversible, nobody has seen it. */
  'committing',
  /** Packaging the gate-passed output into the artifact that gets deployed. */
  'packaging',
  /** Handing that artifact to the deploy side and waiting for a verdict. */
  'deploying',
  /** The site is on the host. Nothing after this is repeatable. */
  'live',
] as const;

export type BuildPhase = (typeof BUILD_PHASES)[number];

/**
 * Which half of the build a phase belongs to.
 *
 * `generation` is everything that costs model time or produces the bytes.
 * `deploy` is everything that happens to bytes that already exist and already
 * passed. `done` is the one phase after which there is nothing to retry.
 *
 * The split is the whole point: a failure's side decides which counter it
 * spends and whether the artifact may be re-used.
 */
export type BuildPhaseSide = 'generation' | 'deploy' | 'done';

const PHASE_SIDE: Readonly<Record<BuildPhase, BuildPhaseSide>> = {
  preparing: 'generation',
  generating: 'generation',
  gating: 'generation',
  committing: 'generation',
  packaging: 'deploy',
  deploying: 'deploy',
  live: 'done',
};

export function buildPhaseSide(phase: BuildPhase): BuildPhaseSide {
  return PHASE_SIDE[phase];
}

/** True for a string that names a phase; narrows, so callers need no cast. */
export function isBuildPhase(value: unknown): value is BuildPhase {
  return (
    typeof value === 'string' &&
    (BUILD_PHASES as readonly string[]).includes(value)
  );
}

/**
 * The gate-passed bytes, recorded on the job before anything is deployed.
 *
 * Written once, by the run that packaged it, in the window between "the
 * validator's exported output has passed every gate and been packed" and "the
 * deploy has been asked for". That window is exactly where run 9 lost its
 * work, and recording here is what makes the work survive the attempt that
 * produced it.
 *
 * `sha256` is not decoration. The deploy-agent refuses an artifact it cannot
 * verify against its digest, so a resumed deploy that re-sends the same URL
 * and the same digest is provably re-deploying the same site rather than
 * whatever happens to be at that path now.
 */
export interface BuiltArtifactRecord {
  /** Where the deploy side fetches it. The path token is a bearer credential. */
  url: string;
  /** The worker's own copy on disk, for an operator with a shell. */
  path?: string | null;
  sha256: string;
  sizeBytes: number;
  /** The commit whose tree these bytes were built from. */
  commitSha: string;
  /** The client branch that commit is on. */
  branch: string;
  /** What this artifact is allowed to claim: the gates it actually passed. */
  gateReport: BuildGateReport;
  /** When the packaging run recorded it. */
  recordedAt: string;
  /** The staging URL the publisher would fall back to, resolved once. */
  stagingUrl?: string | null;
}

/**
 * The gates a packaged artifact passed, named.
 *
 * "A gate-passed artifact" is the precondition for every rule in this file, so
 * it has to be a recorded fact rather than an assumption drawn from the phase.
 * The worker lists the gates it ran; a reader that finds an empty list knows
 * it is looking at bytes nobody vouched for and treats them as no artifact at
 * all.
 */
export interface BuildGateReport {
  /** Gate names, in the order the build ran them. */
  passed: string[];
  at: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(from: Record<string, unknown>, key: string): string {
  const value = from[key];
  return typeof value === 'string' ? value.trim() : '';
}

const SHA256 = /^[0-9a-f]{64}$/i;

/**
 * The artifact on a job payload, or null.
 *
 * Strict on purpose, and every refusal below is a case where re-deploying
 * would be worse than rebuilding: no URL is nothing to fetch, no digest is
 * bytes the deploy-agent will refuse anyway, and an empty gate report is an
 * artifact that was never vouched for. Null means "generate", which is always
 * a safe answer; a lenient parse here would mean shipping something nobody
 * checked, which is not.
 */
export function parseBuiltArtifact(
  payload: unknown,
): BuiltArtifactRecord | null {
  const root = record(payload);
  const raw = root ? record(root['builtArtifact']) : null;
  if (!raw) return null;
  const url = text(raw, 'url');
  const sha256 = text(raw, 'sha256');
  const commitSha = text(raw, 'commitSha');
  if (!url || !SHA256.test(sha256) || !commitSha) return null;
  const gates = record(raw['gateReport']);
  const passed = Array.isArray(gates?.['passed'])
    ? (gates['passed'] as unknown[]).filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.length > 0,
      )
    : [];
  if (passed.length === 0) return null;
  const sizeBytes = raw['sizeBytes'];
  const path = text(raw, 'path');
  const stagingUrl = text(raw, 'stagingUrl');
  return {
    url,
    sha256: sha256.toLowerCase(),
    sizeBytes:
      typeof sizeBytes === 'number' &&
      Number.isFinite(sizeBytes) &&
      sizeBytes > 0
        ? Math.trunc(sizeBytes)
        : 0,
    commitSha,
    branch: text(raw, 'branch'),
    gateReport: { passed, at: text(gates as Record<string, unknown>, 'at') },
    recordedAt: text(raw, 'recordedAt'),
    ...(path ? { path } : {}),
    ...(stagingUrl ? { stagingUrl } : {}),
  };
}

/** The phase a job's last attempt reached, off its payload. */
export function readBuildPhase(payload: unknown): BuildPhase | null {
  const root = record(payload);
  const value = root?.['buildPhase'];
  return isBuildPhase(value) ? value : null;
}

/**
 * Generation attempts and deploy attempts, counted apart.
 *
 * Two numbers because they answer two different questions. "How many times
 * have we paid an agent to build this site" is a budget a client's money sets.
 * "How many times have we tried to put the finished bytes on a server" is an
 * infrastructure question, costs nothing but a request, and has no business
 * eating the first budget — which is precisely what it did on run 9.
 */
export interface BuildAttemptCounters {
  generation: number;
  deploy: number;
}

/**
 * The counters on a payload.
 *
 * `fallbackGeneration` is the row's own `attempt_count`, and it is how a job
 * written before this module existed reads correctly: it has no counters, and
 * every attempt it ever made was a generation attempt, which is exactly what
 * `attempt_count` says. No migration, no backfill, no row that reads zero
 * attempts because the shape changed underneath it.
 */
export function readAttemptCounters(
  payload: unknown,
  fallbackGeneration = 0,
): BuildAttemptCounters {
  const root = record(payload);
  const raw = root ? record(root['attempts']) : null;
  const count = (key: string, fallback: number): number => {
    const value = raw?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : fallback;
  };
  return {
    generation: count(
      'generation',
      Math.max(0, Math.trunc(fallbackGeneration)),
    ),
    deploy: count('deploy', 0),
  };
}

/**
 * How many deploy tries this job may have, with the operator's own grant on
 * top of the configured floor.
 *
 * The same shape `attemptBudget` has for generation, and for the same reason:
 * an operator who re-queues a terminal job for deploy is deciding to spend one
 * more try, and that decision has to beat the worker's configured limit or the
 * button does nothing. The grant is written onto the payload rather than a
 * column because deploy attempts live there already; `max_attempts` stays what
 * it has always been, the generation budget.
 */
export function deployAttemptBudget(
  payload: unknown,
  configured: number,
): number {
  const root = record(payload);
  const raw = root ? record(root['attempts']) : null;
  const granted = raw?.['deployMax'];
  return typeof granted === 'number' && Number.isFinite(granted) && granted > 0
    ? Math.max(configured, Math.trunc(granted))
    : configured;
}

/**
 * The kinds a deploy-only resume is offered for.
 *
 * FULL_SITE_BUILD and nothing else, and the reason is a property of the legs
 * rather than an appetite for caution. A full build's publish is a pure
 * function of the artifact: hand the same bytes to the same endpoint and the
 * same thing happens, so replaying it from a recorded artifact is replaying
 * it exactly.
 *
 * The other three publishes are not pure. A CHANGE_REQUEST_BUILD writes a
 * `site_versions` row before it publishes and rolls that row back when the run
 * fails, so a later attempt has no version to publish into; an
 * OPERATOR_EDIT_BUILD does the same against an editor session. Both would need
 * their bookkeeping resumed too, and a half-resumed publish is a worse failure
 * than a re-run. SITE_REBUILD and OPERATOR_EDIT_BUILD also run no agent at all
 * — re-running them costs a build, not a budget — so there is nothing for a
 * resume to save. If one of those legs ever grows an expensive pass, it earns
 * its own row here alongside the bookkeeping to match.
 */
export const DEPLOY_RESUMABLE_KINDS: ReadonlySet<string> = new Set([
  'FULL_SITE_BUILD',
]);

/** Why a job is being generated again rather than just re-deployed. */
export type GenerationReason =
  /** Nothing was ever packaged, so there is nothing to deploy. */
  | 'no-artifact'
  /** The last attempt died before or during the gates. */
  | 'generation-failure'
  /** This kind's publish moves more than bytes; see DEPLOY_RESUMABLE_KINDS. */
  | 'kind-not-resumable';

export type BuildResumePlan =
  | { resume: 'generation'; reason: GenerationReason }
  | { resume: 'deploy'; artifact: BuiltArtifactRecord };

/**
 * What the next attempt should do, from the job's own durable state.
 *
 * Two conditions, both required, and neither is a heuristic. There has to be a
 * recorded artifact that passed named gates, and the phase the last attempt
 * reached has to be on the deploy side. Either one alone would be a guess:
 * an artifact with a generation-side phase is a build that got further on a
 * *previous* attempt and then failed early on this one, and a deploy-side
 * phase with no artifact is a run that died while packaging.
 */
export function planBuildResume(input: {
  kind: FlowstarterBuildKind | string;
  payload: unknown;
}): BuildResumePlan {
  const artifact = parseBuiltArtifact(input.payload);
  if (!artifact) return { resume: 'generation', reason: 'no-artifact' };
  if (!DEPLOY_RESUMABLE_KINDS.has(input.kind)) {
    return { resume: 'generation', reason: 'kind-not-resumable' };
  }
  const phase = readBuildPhase(input.payload);
  if (!phase || buildPhaseSide(phase) !== 'deploy') {
    return { resume: 'generation', reason: 'generation-failure' };
  }
  return { resume: 'deploy', artifact };
}

/**
 * The phase the worker announces when it is re-deploying bytes it already
 * has, so an operator reading the timeline sees "redeploying the built site"
 * rather than "generating" for a run that is doing nothing of the kind.
 *
 * A constant rather than a literal at the call site because
 * `activity/phase-rules.ts` matches it to a timeline step, and two copies of a
 * user-visible string is how the timeline ends up saying something the
 * pipeline stopped saying.
 */
export const REDEPLOY_PHASE = 'Redeploying the built site';

/* ── Deploy failures ─────────────────────────────────────────────────────── */

/**
 * The failure codes a deploy-side step writes onto the ledger.
 *
 * Before these there were none: a 409 and a 502 both arrived as
 * `FULL_SITE_BUILD_FAILED` with the response body in `error_detail`, and the
 * retry rule had to read that body with a regular expression to guess whether
 * trying again was worth it. It guessed "502 is transient" correctly and
 * "409 workspace_unallocated" incorrectly, which is a rule deciding a paid
 * build's fate from a substring. A code that says what happened is the fix,
 * and both of these are set by the publisher from the deploy side's own
 * structured `code` field rather than from its prose.
 */

/** The deploy failed, and another deploy is the right next thing to try. */
export const SITE_DEPLOY_FAILED = 'SITE_DEPLOY_FAILED';

/**
 * The deploy failed for a reason no retry can clear: the workspace has no host
 * allocated, the server is not active, the agent is not configured. A person
 * has to do something. The job stops and an operator is alerted.
 */
export const SITE_DEPLOY_NEEDS_OPERATOR = 'SITE_DEPLOY_NEEDS_OPERATOR';

/**
 * Deploy-side error codes that a human has to clear.
 *
 * `deploySite` in `apps/flowstarter-main/src/lib/hosting/deploy.ts` is the
 * producer of these strings and the source of truth for the set; this is the
 * closed list of the ones that mean "provisioning", as opposed to "the host
 * was busy". Retrying any of them produces the identical answer forever —
 * which is what a terminal failure *is* — and every one of them is fixed by an
 * operator allocating, activating or configuring something.
 */
export const DEPLOY_CODES_NEEDING_OPERATOR: ReadonlySet<string> = new Set([
  'workspace_unallocated',
  'workspace_not_found',
  'server_not_found',
  'server_not_active',
  'agent_not_configured',
  'secret_not_configured',
]);

/** True when this deploy-side code needs a person rather than another try. */
export function deployFailureNeedsOperator(
  code: string | null | undefined,
): boolean {
  return DEPLOY_CODES_NEEDING_OPERATOR.has((code ?? '').trim().toLowerCase());
}

/** The ledger code for a deploy that failed with this deploy-side code. */
export function failureCodeForDeployCode(
  code: string | null | undefined,
): typeof SITE_DEPLOY_FAILED | typeof SITE_DEPLOY_NEEDS_OPERATOR {
  return deployFailureNeedsOperator(code)
    ? SITE_DEPLOY_NEEDS_OPERATOR
    : SITE_DEPLOY_FAILED;
}
