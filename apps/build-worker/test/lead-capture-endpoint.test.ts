/**
 * Where a built site posts its enquiries, decided by the worker.
 *
 * Three decisions are being defended, and none of them is in the job payload:
 *
 *  1. THE ORIGIN is this process's own, through `publicAppOrigin()` -- not
 *     `resolvePlatformDomain()`, which names the zone client sites are hosted
 *     under and is a different question everywhere but production. A worker
 *     running against the dev or staging zone must write an endpoint
 *     something actually answers at, not the bare apex, and must never write
 *     a production endpoint into somebody's site because a queued row said
 *     so.
 *  2. THE TOKEN is checked rather than trusted. It ends up in public HTML, so
 *     a value carrying a slash would change the path, a value carrying a dot
 *     could collide with the preview shape the endpoint refuses, and a
 *     workspace id is short enough to be refused by the same rule that makes
 *     the id not be the key.
 *  3. `FLOWSTARTER_PUBLIC_APP_ORIGIN` overrides every guess outright, for a
 *     slot (a PR staging box) that answers somewhere other than its
 *     environment's default subdomain.
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

const ENV_KEYS = [
  'FLOWSTARTER_ENV',
  'NODE_ENV',
  'PLATFORM_DOMAIN',
  'FLOWSTARTER_PUBLIC_APP_ORIGIN',
  'NEXT_PUBLIC_SITE_URL',
  'PORT',
] as const;

const previous: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) previous[key] = process.env[key];
  // The suite's own baseline: a production-shaped process, the way the
  // pre-existing cases here always assumed.
  process.env.FLOWSTARTER_ENV = 'production';
  process.env.PLATFORM_DOMAIN = 'flowstarter.test';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

describe('leadCaptureEndpoint on the job', () => {
  it('is built from the token and this process own platform origin, in production', () => {
    expect(jobWith(TOKEN).leadCaptureEndpoint).toBe(
      `https://flowstarter.test/api/leads/capture/${TOKEN}`,
    );
  });

  it('follows the domain this process is configured for, not a queued value', () => {
    process.env.PLATFORM_DOMAIN = 'flowstarter.dev';
    expect(jobWith(TOKEN).leadCaptureEndpoint).toBe(
      `https://flowstarter.dev/api/leads/capture/${TOKEN}`,
    );
  });

  it('posts to staging.{domain} on the shared staging box, where the bare apex 404s', () => {
    process.env.FLOWSTARTER_ENV = 'staging';
    delete process.env.PLATFORM_DOMAIN;
    expect(jobWith(TOKEN).leadCaptureEndpoint).toBe(
      `https://staging.flowstarter.dev/api/leads/capture/${TOKEN}`,
    );
  });

  it('posts to NEXT_PUBLIC_SITE_URL in development, not flowstarter.dev', () => {
    process.env.FLOWSTARTER_ENV = 'development';
    delete process.env.PLATFORM_DOMAIN;
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3067';
    expect(jobWith(TOKEN).leadCaptureEndpoint).toBe(
      `http://localhost:3067/api/leads/capture/${TOKEN}`,
    );
  });

  it('is overridden outright by FLOWSTARTER_PUBLIC_APP_ORIGIN, for a slot on its own subdomain', () => {
    process.env.FLOWSTARTER_PUBLIC_APP_ORIGIN =
      'https://pr-7.staging.flowstarter.dev';
    expect(jobWith(TOKEN).leadCaptureEndpoint).toBe(
      `https://pr-7.staging.flowstarter.dev/api/leads/capture/${TOKEN}`,
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
