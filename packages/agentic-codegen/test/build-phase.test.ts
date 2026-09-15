/**
 * The phase model, asserted as rules: a payload in, a plan out.
 *
 * Every case here is a variant of the question run 9 could not answer — "does
 * this job have to be built again, or only shipped?" — and the answers are
 * deliberately conservative in one direction: anything the rule cannot vouch
 * for reads as "build it". A wrong "generate" costs money. A wrong "deploy"
 * ships a site nobody checked.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPhaseSide,
  DEPLOY_CODES_NEEDING_OPERATOR,
  deployAttemptBudget,
  deployFailureNeedsOperator,
  failureCodeForDeployCode,
  isBuildPhase,
  parseBuiltArtifact,
  planBuildResume,
  readAttemptCounters,
  readBuildPhase,
  SITE_DEPLOY_FAILED,
  SITE_DEPLOY_NEEDS_OPERATOR,
  type BuiltArtifactRecord,
} from '../src/flowstarter/build-phase';

const ARTIFACT: BuiltArtifactRecord = {
  url: 'http://127.0.0.1:8787/artifacts/job-token.tar.gz',
  path: '/tmp/artifacts/job-token.tar.gz',
  sha256: 'a'.repeat(64),
  sizeBytes: 6_711_757,
  commitSha: 'abc123def456',
  branch: 'client/flowstarter-ba3e9323',
  gateReport: {
    passed: ['build', 'markup-policy'],
    at: '2026-09-12T20:00:00Z',
  },
  recordedAt: '2026-09-12T20:00:00Z',
};

const DEPLOYABLE = { builtArtifact: ARTIFACT, buildPhase: 'deploying' };

describe('which half of a build a phase belongs to', () => {
  it('puts everything that costs model time on the generation side', () => {
    expect(buildPhaseSide('preparing')).toBe('generation');
    expect(buildPhaseSide('generating')).toBe('generation');
    expect(buildPhaseSide('gating')).toBe('generation');
    expect(buildPhaseSide('committing')).toBe('generation');
  });

  it('puts everything that only moves finished bytes on the deploy side', () => {
    expect(buildPhaseSide('packaging')).toBe('deploy');
    expect(buildPhaseSide('deploying')).toBe('deploy');
  });

  it('reads a phase off a payload, and refuses anything that is not one', () => {
    expect(readBuildPhase({ buildPhase: 'gating' })).toBe('gating');
    expect(readBuildPhase({ buildPhase: 'nearly-done' })).toBeNull();
    expect(readBuildPhase(null)).toBeNull();
    expect(isBuildPhase('live')).toBe(true);
    expect(isBuildPhase('deployed')).toBe(false);
  });
});

describe('the artifact a previous attempt recorded', () => {
  it('reads back whole', () => {
    expect(parseBuiltArtifact({ builtArtifact: ARTIFACT })).toEqual(ARTIFACT);
  });

  it('refuses one the deploy-agent could never verify', () => {
    // No digest, a malformed digest, or no URL: three ways of holding bytes
    // nothing downstream will accept, and all three mean "build it again".
    for (const broken of [
      { ...ARTIFACT, sha256: '' },
      { ...ARTIFACT, sha256: 'not-a-digest' },
      { ...ARTIFACT, url: '' },
      { ...ARTIFACT, commitSha: '' },
    ]) {
      expect(parseBuiltArtifact({ builtArtifact: broken })).toBeNull();
    }
  });

  it('refuses one that no gate vouched for', () => {
    // The precondition of the whole feature. Bytes with an empty gate report
    // are bytes nobody checked, and re-deploying them would be shipping an
    // unaudited site to skip a build.
    expect(
      parseBuiltArtifact({
        builtArtifact: { ...ARTIFACT, gateReport: { passed: [], at: '' } },
      }),
    ).toBeNull();
    expect(
      parseBuiltArtifact({ builtArtifact: { ...ARTIFACT, gateReport: null } }),
    ).toBeNull();
  });
});

describe('what the next attempt is for', () => {
  it('resumes at the deploy when there is a gated artifact and a deploy-side phase', () => {
    expect(
      planBuildResume({ kind: 'FULL_SITE_BUILD', payload: DEPLOYABLE }),
    ).toEqual({ resume: 'deploy', artifact: ARTIFACT });
  });

  it('generates when nothing was ever packaged', () => {
    expect(
      planBuildResume({ kind: 'FULL_SITE_BUILD', payload: { failures: [] } }),
    ).toEqual({ resume: 'generation', reason: 'no-artifact' });
  });

  it('generates when the last attempt died before the bytes were final', () => {
    // An artifact from an *earlier* attempt plus a generation-side phase is a
    // run that got further last time and failed early this time. Deploying the
    // old bytes would ship a site the newest attempt never agreed with.
    expect(
      planBuildResume({
        kind: 'FULL_SITE_BUILD',
        payload: { ...DEPLOYABLE, buildPhase: 'gating' },
      }),
    ).toEqual({ resume: 'generation', reason: 'generation-failure' });
  });

  it('generates for a kind whose publish moves more than bytes', () => {
    // A change request also writes a site version and moves the request; an
    // operator-edit build moves a session. Replaying those from an artifact
    // alone would put a site live with its bookkeeping half done.
    for (const kind of [
      'CHANGE_REQUEST_BUILD',
      'OPERATOR_EDIT_BUILD',
      'SITE_REBUILD',
    ]) {
      expect(planBuildResume({ kind, payload: DEPLOYABLE })).toEqual({
        resume: 'generation',
        reason: 'kind-not-resumable',
      });
    }
  });
});

describe('generation attempts and deploy attempts, counted apart', () => {
  it('reads a row written before the counters existed as all generation', () => {
    // No migration and no backfill: `attempt_count` already says how many
    // times this job was built, because every attempt it ever had was one.
    expect(readAttemptCounters({}, 3)).toEqual({ generation: 3, deploy: 0 });
  });

  it('prefers the counters on the payload once they are there', () => {
    expect(
      readAttemptCounters({ attempts: { generation: 2, deploy: 4 } }, 9),
    ).toEqual({ generation: 2, deploy: 4 });
  });

  it("lets an operator's grant beat the configured deploy budget", () => {
    // The same shape `attemptBudget` has for generation: a person re-queueing
    // a terminal job is deciding to spend one more try, and that decision has
    // to beat the worker's own limit or the button does nothing.
    expect(deployAttemptBudget({}, 5)).toBe(5);
    expect(deployAttemptBudget({ attempts: { deployMax: 9 } }, 5)).toBe(9);
    // Never downward: a stale grant cannot lower the floor.
    expect(deployAttemptBudget({ attempts: { deployMax: 2 } }, 5)).toBe(5);
  });
});

describe('a deploy that failed', () => {
  it('needs a person when there is nowhere to deploy to', () => {
    expect(deployFailureNeedsOperator('workspace_unallocated')).toBe(true);
    expect(failureCodeForDeployCode('workspace_unallocated')).toBe(
      SITE_DEPLOY_NEEDS_OPERATOR,
    );
    for (const code of DEPLOY_CODES_NEEDING_OPERATOR) {
      expect(failureCodeForDeployCode(code)).toBe(SITE_DEPLOY_NEEDS_OPERATOR);
    }
  });

  it('is worth another try when the host was simply not having it', () => {
    expect(deployFailureNeedsOperator('agent_error')).toBe(false);
    expect(failureCodeForDeployCode('agent_error')).toBe(SITE_DEPLOY_FAILED);
    expect(failureCodeForDeployCode('db_error')).toBe(SITE_DEPLOY_FAILED);
    // A refusal that named no code says nothing about whether retrying helps,
    // and the retryable reading is the one that cannot strand a paid site.
    expect(failureCodeForDeployCode(null)).toBe(SITE_DEPLOY_FAILED);
    expect(failureCodeForDeployCode('')).toBe(SITE_DEPLOY_FAILED);
  });
});
