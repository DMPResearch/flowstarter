/**
 * Where a built site posts its enquiries, decided by the worker.
 *
 * Two decisions are being defended, and neither of them is in the job payload:
 *
 *  1. THE HOST is this process's own, through `resolvePlatformDomain()`. A
 *     worker running against the dev zone must not write a production endpoint
 *     into somebody's site because a queued row said so.
 *  2. THE TOKEN is checked rather than trusted. It ends up in public HTML, so
 *     a value carrying a slash would change the path, a value carrying a dot
 *     could collide with the preview shape the endpoint refuses, and a
 *     workspace id is short enough to be refused by the same rule that makes
 *     the id not be the key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen';
import { buildJobFromRows, type JobLedgerRow } from '../src/job-store';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const TOKEN = 'Kx9-_abcdefghijklmnopqrstuvwxyz0123456789AB';

function ledgerRow(overrides: Partial<JobLedgerRow> = {}): JobLedgerRow {
  return {
    id: '4f9d5bf2-1c4a-4a2f-9d4a-4c0f0a7c2f11',
    workspace_id: WORKSPACE_ID,
    kind: 'FULL_SITE_BUILD',
    status: 'queued',
    attempt_count: 0,
    payload: {},
    ...overrides,
  };
}

const artifacts = () => ({
  intake_payload: { projectId: WORKSPACE_ID, business: { name: 'Calm Path' } },
  brand_config: { schemaVersion: '1.0' },
  preview_manifest: {
    files: [{ path: 'src/content/site.md', content: 'Approved preview' }],
  },
});

const jobWith = (leadCaptureToken: string | null | undefined) =>
  buildJobFromRows({
    job: ledgerRow(),
    projectState: ProjectState.DEPOSIT_PAID,
    artifacts: artifacts(),
    leadCaptureToken,
  });

const previous = process.env.PLATFORM_DOMAIN;

beforeEach(() => {
  process.env.PLATFORM_DOMAIN = 'flowstarter.test';
});

afterEach(() => {
  if (previous === undefined) delete process.env.PLATFORM_DOMAIN;
  else process.env.PLATFORM_DOMAIN = previous;
});

describe('leadCaptureEndpoint on the job', () => {
  it('is built from the token and this process own platform host', () => {
    expect(jobWith(TOKEN).leadCaptureEndpoint).toBe(
      `https://flowstarter.test/api/leads/capture/${TOKEN}`,
    );
  });

  it('follows the host this process is configured for, not a queued value', () => {
    process.env.PLATFORM_DOMAIN = 'flowstarter.dev';
    expect(jobWith(TOKEN).leadCaptureEndpoint).toBe(
      `https://flowstarter.dev/api/leads/capture/${TOKEN}`,
    );
  });

  it('is absent when the workspace has no token', () => {
    expect(jobWith(null).leadCaptureEndpoint).toBeUndefined();
    expect(jobWith(undefined).leadCaptureEndpoint).toBeUndefined();
    expect(jobWith('   ').leadCaptureEndpoint).toBeUndefined();
  });

  it('refuses a token that would change the path or fake a preview', () => {
    expect(
      jobWith(`${TOKEN.slice(0, 20)}/../evil`).leadCaptureEndpoint,
    ).toBeUndefined();
    expect(
      jobWith(`preview.${WORKSPACE_ID}`).leadCaptureEndpoint,
    ).toBeUndefined();
    expect(jobWith(WORKSPACE_ID).leadCaptureEndpoint).toBeUndefined();
  });
});
