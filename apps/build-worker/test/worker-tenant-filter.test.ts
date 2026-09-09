/**
 * Static guard: every `.from(<tenant table>)` call in this worker's `src/`
 * must either carry `.eq('workspace_id', ...)` in the same statement, or go
 * through `withTenant(...)` (see `src/tenancy.ts`).
 *
 * This worker's Supabase client authenticates with the service role and
 * bypasses RLS (see the module doc on `src/job-store.ts`), so the only thing
 * standing between one workspace's query and another workspace's row is
 * remembering to filter by hand at every call site. This test is the
 * backstop for that: it reads every `.ts` source file under `src/`
 * (excluding tests and `tenancy.ts` itself), finds every `.from('table')`
 * call on a table known to carry a `workspace_id` column, and asserts the
 * enclosing statement is filtered. A call site this can't account for fails
 * with the offending file and table.
 *
 * A handful of call sites in `job-store.ts` are legitimately not filtered by
 * `workspace_id` -- see `ALLOW_LIST` below, each with a comment explaining
 * why. Everything else must be filtered or go through `withTenant`.
 *
 * Note on location: the Phase 0 spec named this file
 * `src/__tests__/worker-tenant-filter.test.ts`, but this package's
 * `vitest.config.ts` only collects `test/**\/*.test.ts` (matching every
 * other test here) -- a file under `src/__tests__` would silently never
 * run. It lives at `test/worker-tenant-filter.test.ts` instead so it
 * actually executes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_DIR = join(__dirname, '..', 'src');

/**
 * Every table that carries a `workspace_id` column, as of the tenant
 * isolation audit in `supabase/migrations/20260909143500_tenant_isolation_hardening.sql`.
 * `workspaces` is included even though its tenant column is its own `id` (see
 * the allow-list below) -- listing it here keeps this test honest about which
 * tables it is deliberately relaxing, rather than skipping them silently.
 *
 * The worker queries five of these today. The rest are listed because the
 * guard has to be standing before the query arrives, not after: a worker that
 * grows an unfiltered read of `site_versions` next month fails here, at the
 * moment it is written.
 *
 * Deliberately NOT in this set, because their tenant key is not
 * `workspace_id` and the filter this guard looks for could not express it:
 *   discovery_leads      project_id, referencing workspaces(id)
 *   funnel_previews      claimed_workspace_id, and null until a claim
 *   selfserve_builds     project_id, into selfserve_projects
 *   selfserve_payments   project_id, into selfserve_projects
 * The self-serve pair have no workspace behind them at all. All four are
 * server-only in the database and proved so by
 * `apps/flowstarter-main/scripts/verify-rls-local.mjs`; this worker has no
 * query on any of them.
 */
const TENANT_TABLES = new Set([
  'workspaces',
  // Queried by this worker today.
  'flowstarter_agent_jobs',
  'flowstarter_agent_job_events',
  'flowstarter_project_artifacts',
  // Not queried yet. The guard stands anyway.
  'ai_audit_logs',
  'asset_rights_confirmations',
  'assets',
  'brand_signals',
  'client_constraint_profiles',
  'commerce_products',
  'deployments',
  'editor_sessions',
  'flowstarter_change_requests',
  'intake_submissions',
  'leads',
  'llm_usage',
  'project_events',
  'project_messages',
  'setup_payment_milestones',
  'site_versions',
  'vault_encrypted_secrets',
  'workspace_billing_profiles',
  'workspace_hosts',
  'workspace_memberships',
]);

interface AllowListEntry {
  /** Path relative to `src/`. */
  file: string;
  table: string;
  /**
   * A substring that must appear in the matched statement. Pins the entry
   * to one specific call site instead of exempting every query against
   * `table` in `file`.
   */
  match: string;
  reason: string;
}

const ALLOW_LIST: AllowListEntry[] = [
  // -- flowstarter_agent_jobs: every access below is keyed by the job's own
  // primary key (`id`), a worker-minted random UUID that is never
  // user-supplied. A specific job id already identifies exactly one
  // tenant's job -- and `claim()`'s first read is literally how the
  // workspace_id for that job becomes known, so requiring a workspace_id
  // filter on it would be circular.
  {
    file: 'job-store.ts',
    table: 'flowstarter_agent_jobs',
    match: `.select('id, workspace_id, kind, status, attempt_count, payload')`,
    reason:
      "claim(): initial read, keyed by the job's own id; this is the read that discovers workspace_id.",
  },
  {
    file: 'job-store.ts',
    table: 'flowstarter_agent_jobs',
    match: `.eq('attempt_count', row.attempt_count)`,
    reason:
      'claim(): compare-and-set update keyed by (id, status, attempt_count), all already known from the read above.',
  },
  {
    file: 'job-store.ts',
    table: 'flowstarter_agent_jobs',
    match: 'worktree_branch: worktree.branch,',
    reason:
      'markAgentWorking() and markRebuildStarted(): updates keyed by the job id the caller already holds.',
  },
  {
    file: 'job-store.ts',
    table: 'flowstarter_agent_jobs',
    match: `.maybeSingle<{ workspace_id: string }>()`,
    reason:
      "workspaceFor(): the lookup that discovers a job's workspace so events can be stamped with it; requiring the filter would be circular.",
  },
  {
    file: 'job-store.ts',
    table: 'flowstarter_agent_jobs',
    match: `.maybeSingle<{ payload: unknown }>()`,
    reason:
      'currentPayload(): payload read keyed by the job id the caller already holds, shared by markHumanQa() and markRebuilt().',
  },
  {
    file: 'job-store.ts',
    table: 'flowstarter_agent_jobs',
    match: 'pull_request_url: result.pullRequestUrl,',
    reason:
      'markHumanQa() and markRebuilt(): updates keyed by the job id the caller already holds.',
  },
  {
    file: 'job-store.ts',
    table: 'flowstarter_agent_jobs',
    match: 'error_code: failure.code,',
    reason:
      'markFailed(): update keyed by the job id the caller already holds.',
  },
  // -- flowstarter_agent_job_events: both call sites are keyed by a job id
  // the worker obtained from its own claim() read, not from user input, so
  // there is nothing a caller could supply to point either query at another
  // tenant's job.
  {
    file: 'job-store.ts',
    table: 'flowstarter_agent_job_events',
    match: 'body: event.body.slice(0, 4_000),',
    reason:
      'appendEvent(): insert keyed by the job id the worker obtained from its own claim; workspace_id is stamped from workspaceFor(jobId) in the same call.',
  },
  {
    file: 'job-store.ts',
    table: 'flowstarter_agent_job_events',
    match: `.eq('kind', 'note')`,
    reason:
      'readOperatorNotes(): select keyed by the job id the worker obtained from its own claim.',
  },
  // -- workspaces: this table IS the tenant, not tenant-owned data. It has
  // no `workspace_id` column -- its own primary key `id` *is* the workspace
  // id -- so `.eq('id', ...)` here is the tenant filter for this table,
  // not a cross-tenant query.
  {
    file: 'job-store.ts',
    table: 'workspaces',
    match: `.select('id, project_state, cal_com_url')`,
    reason:
      "claim(): filtered on workspaces.id, which is the workspace's own id.",
  },
  {
    file: 'job-store.ts',
    table: 'workspaces',
    match: `.update({ project_state: ProjectState.AGENTS_WORKING })`,
    reason:
      "markAgentWorking(): filtered on workspaces.id, which is the workspace's own id.",
  },
  {
    file: 'job-store.ts',
    table: 'workspaces',
    match: `.update({ project_state: ProjectState.HUMAN_QA })`,
    reason:
      "markHumanQa(): filtered on workspaces.id, which is the workspace's own id.",
  },
  {
    file: 'job-store.ts',
    table: 'workspaces',
    match: `.update({ project_state: ProjectState.DEPOSIT_PAID })`,
    reason:
      "markFailed(): filtered on workspaces.id, which is the workspace's own id.",
  },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    if (entry === 'tenancy.ts') continue;
    out.push(full);
  }
  return out;
}

/**
 * Extracts the statement containing `index`: from just after the previous
 * top-level `;` to the next `;` that occurs at paren-depth 0. Chained
 * Supabase calls span multiple lines but stay inside one statement, so this
 * captures the whole `.from(...).eq(...)....` chain regardless of where
 * within it `index` falls.
 */
function extractStatement(content: string, index: number): string {
  const prevSemicolon = content.lastIndexOf(';', index);
  const start = prevSemicolon === -1 ? -1 : prevSemicolon;
  let depth = 0;
  let end = content.length;
  for (let i = start + 1; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth <= 0) {
      end = i + 1;
      break;
    }
  }
  return content.slice(start + 1, end);
}

interface Violation {
  file: string;
  table: string;
  statement: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  const fromCallPattern = /\.from\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*\)/g;

  for (const filePath of listSourceFiles(SRC_DIR)) {
    const relFile = relative(SRC_DIR, filePath);
    const content = readFileSync(filePath, 'utf8');

    fromCallPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = fromCallPattern.exec(content))) {
      const table = match[1];
      if (!table || !TENANT_TABLES.has(table)) continue;

      const statement = extractStatement(content, match.index);

      if (
        statement.includes(`.eq('workspace_id'`) ||
        statement.includes('withTenant(')
      ) {
        continue;
      }

      const allowed = ALLOW_LIST.some(
        (entry) =>
          entry.file === relFile &&
          entry.table === table &&
          statement.includes(entry.match),
      );
      if (allowed) continue;

      violations.push({ file: relFile, table, statement });
    }
  }

  return violations;
}

describe('worker tenant filter guard', () => {
  it('every tenant-table query is filtered by workspace_id, goes through withTenant(), or is allow-listed', () => {
    const violations = findViolations();

    if (violations.length > 0) {
      const details = violations
        .map(
          (v) =>
            `  - ${v.file}: .from('${v.table}') without a workspace_id filter\n    ${v.statement.slice(0, 240).replace(/\s+/g, ' ')}`,
        )
        .join('\n');
      throw new Error(
        `Found ${violations.length} unfiltered tenant-table quer${violations.length === 1 ? 'y' : 'ies'}:\n${details}`,
      );
    }

    expect(violations).toEqual([]);
  });

  it('every allow-list entry still matches real source (catches a stale exemption)', () => {
    const sourceCache = new Map<string, string>();
    for (const entry of ALLOW_LIST) {
      let content = sourceCache.get(entry.file);
      if (content === undefined) {
        content = readFileSync(join(SRC_DIR, entry.file), 'utf8');
        sourceCache.set(entry.file, content);
      }
      expect(
        content.includes(entry.match),
        `Allow-list entry for ${entry.file} / ${entry.table} no longer matches source: "${entry.match}"`,
      ).toBe(true);
    }
  });

  it('sanity: this scan actually finds tenant-table queries (guards against a broken scanner)', () => {
    // If this drops to 0, the regex/statement-extraction logic broke and the
    // guard above would be trivially "passing" for the wrong reason.
    let total = 0;
    const fromCallPattern = /\.from\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*\)/g;
    for (const filePath of listSourceFiles(SRC_DIR)) {
      const content = readFileSync(filePath, 'utf8');
      fromCallPattern.lastIndex = 0;
      while (fromCallPattern.exec(content)) total++;
    }
    expect(total).toBeGreaterThan(0);
  });
});
