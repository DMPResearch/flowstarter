/**
 * The worker's side of an operator editor session: it may claim the kind, it
 * reads the intent off the payload, and it retries the right failures.
 */
import { describe, expect, it } from 'vitest';
import { CLAIMABLE_KINDS } from '../src/leases';
import {
  classifyBuildFailure,
  isRetryableBuildFailure,
  TERMINAL_BUILD_FAILURE_CODES,
  UNCLASSIFIED_BUILD_FAILURE_CODES,
} from '../src/failure-policy';
import { buildJobFromRows, operatorEditFor } from '../src/job-store';

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const SESSION = 'bb0ce0b6-2f22-4c2c-9a5a-1111aaaa2222';

const payload = {
  trigger: 'operator_editor_ship',
  operatorEdit: {
    sessionId: SESSION,
    operatorId: 'user_operator',
    baseVersion: 4,
    commitSha: 'abc1234',
    note: 'added the pricing page',
  },
};

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    workspace_id: WORKSPACE,
    kind: 'OPERATOR_EDIT_BUILD',
    status: 'queued',
    payload,
    attempt_count: 0,
    max_attempts: 3,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const artifacts = {
  intake_payload: { projectId: WORKSPACE, business: { niche: 'Therapy' } },
  brand_config: { schemaVersion: '1.0' },
  preview_manifest: {
    files: [{ path: 'src/content/site.md', content: 'the published site' }],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('the worker may run an operator edit build', () => {
  it('is on the claimable list', () => {
    expect(CLAIMABLE_KINDS.has('OPERATOR_EDIT_BUILD')).toBe(true);
  });
});

describe('operatorEditFor', () => {
  it('reads the session off an operator job and nothing off any other kind', () => {
    expect(operatorEditFor(ledgerRow())?.sessionId).toBe(SESSION);
    expect(operatorEditFor(ledgerRow({ kind: 'SITE_REBUILD' }))).toBeNull();
    expect(
      operatorEditFor(ledgerRow({ kind: 'CHANGE_REQUEST_BUILD' })),
    ).toBeNull();
  });
});

describe('buildJobFromRows', () => {
  it('builds from the operator’s worktree, not from the published manifest', () => {
    const job = buildJobFromRows({
      job: ledgerRow(),
      projectState: 'LIVE_SUBSCRIPTION',
      artifacts,
      operatorEditFiles: [
        {
          path: 'src/content/site.md',
          content: 'what the operator wrote',
          type: 'file' as const,
        },
        {
          path: 'src/pages/pricing.astro',
          content: '<h1>Pricing</h1>',
          type: 'file' as const,
        },
      ],
    });
    expect(job.kind).toBe('OPERATOR_EDIT_BUILD');
    expect(job.operatorEdit?.sessionId).toBe(SESSION);
    expect(job.approvedPreviewFiles).toHaveLength(2);
    expect(job.approvedPreviewFiles[0]?.content).toBe(
      'what the operator wrote',
    );
    // Seeding from the artifact row would build the site as it was before the
    // operator started, and publish it as though it were their work.
    expect(
      job.approvedPreviewFiles.some(
        (file) => file.content === 'the published site',
      ),
    ).toBe(false);
  });

  it('leaves every other kind reading the published manifest', () => {
    const job = buildJobFromRows({
      job: ledgerRow({ kind: 'SITE_REBUILD', payload: {} }),
      projectState: 'LIVE_SUBSCRIPTION',
      artifacts,
    });
    expect(job.kind).toBe('SITE_REBUILD');
    expect(job.operatorEdit).toBeUndefined();
    expect(job.approvedPreviewFiles[0]?.content).toBe('the published site');
  });

  it('carries no intent when the payload names no session', () => {
    const job = buildJobFromRows({
      job: ledgerRow({ payload: { operatorEdit: { sessionId: 'nope' } } }),
      projectState: 'LIVE_SUBSCRIPTION',
      artifacts,
      operatorEditFiles: [{ path: 'a.md', content: 'x', type: 'file' as const }],
    });
    // The workflow leg fails the job loudly on this rather than publishing.
    expect(job.operatorEdit).toBeUndefined();
  });
});

describe('the retry rule', () => {
  it('never re-runs a deterministic refusal about an operator session', () => {
    for (const code of [
      'OPERATOR_EDIT_MANIFEST_MISSING',
      'OPERATOR_EDIT_INVALID_STATE',
      'PLACEHOLDER_COPY_SHIPPED',
      'EMPTY_IMAGE_SHIPPED',
      'GENERATED_HTML_UNSAFE',
    ]) {
      expect(TERMINAL_BUILD_FAILURE_CODES.has(code)).toBe(true);
      expect(isRetryableBuildFailure({ error_code: code })).toBe(false);
    }
  });

  it('judges an unrecognised operator failure by its detail, like its siblings', () => {
    expect(
      UNCLASSIFIED_BUILD_FAILURE_CODES.has('OPERATOR_EDIT_BUILD_FAILED'),
    ).toBe(true);
    expect(
      classifyBuildFailure({
        error_code: 'OPERATOR_EDIT_BUILD_FAILED',
        error_detail: 'fetch failed: ECONNRESET',
      }),
    ).toBe('transient');
    expect(
      classifyBuildFailure({
        error_code: 'OPERATOR_EDIT_BUILD_FAILED',
        error_detail: 'TypeError: cannot read property of undefined',
      }),
    ).toBe('terminal');
  });
});
