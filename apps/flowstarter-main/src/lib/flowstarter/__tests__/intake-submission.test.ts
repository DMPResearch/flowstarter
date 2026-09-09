/**
 * `intake_submissions` is how the deterministic routing verdict gets
 * calibrated against reality later. `recordIntakeSubmission` always writes
 * `decided_by: 'rules'`; `applyRoutingOverride` is the one escape hatch
 * (`decided_by: 'override'`) and it must leave an audit trail in
 * `project_events`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRoutingOverride,
  recordIntakeSubmission,
} from '../intake-submission';
import type { RoutingResult } from '../routing-rules';

vi.mock('server-only', () => ({}));

interface Call {
  table: string;
  op: 'insert' | 'select' | 'update';
  args: unknown[];
}

const calls: Call[] = [];
const script: {
  insertResult?: { data: unknown; error: unknown };
  selectResult?: { data: unknown; error: unknown };
  updateResult?: { data: unknown; error: unknown };
  /** The `project_events` audit insert, which resolves through `then` too. */
  eventResult?: { data: unknown; error: unknown };
} = {};

function builderFor(table: string) {
  const builder = {
    insert(values: Record<string, unknown>) {
      calls.push({ table, op: 'insert', args: [values] });
      return builder;
    },
    select(columns: string) {
      calls.push({ table, op: 'select', args: [columns] });
      return builder;
    },
    update(values: Record<string, unknown>) {
      calls.push({ table, op: 'update', args: [values] });
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.push({
        table,
        op: calls[calls.length - 1]?.op ?? 'select',
        args: ['eq', column, value],
      });
      return builder;
    },
    order(column: string, opts: unknown) {
      calls.push({
        table,
        op: calls[calls.length - 1]?.op ?? 'select',
        args: ['order', column, opts],
      });
      return builder;
    },
    limit(n: number) {
      calls.push({
        table,
        op: calls[calls.length - 1]?.op ?? 'select',
        args: ['limit', n],
      });
      return builder;
    },
    single() {
      return Promise.resolve(
        script.insertResult ?? { data: { id: 'row-1' }, error: null }
      );
    },
    maybeSingle() {
      return Promise.resolve(
        script.selectResult ?? { data: { id: 'row-1' }, error: null }
      );
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      const scripted =
        table === 'project_events' ? script.eventResult : script.updateResult;
      return Promise.resolve(scripted ?? { data: null, error: null }).then(
        resolve,
        reject
      );
    },
  };
  return builder;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builderFor }),
}));

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

const routing: RoutingResult = {
  decision: 'custom',
  score: 8,
  rulesFired: ['tightBudget', 'tightDeadline'],
  reasons: ['tight budget', 'tight deadline'],
};

beforeEach(() => {
  calls.length = 0;
  delete script.insertResult;
  delete script.selectResult;
  delete script.updateResult;
  delete script.eventResult;
});

describe('recordIntakeSubmission', () => {
  it('writes the payload + routing verdict with decided_by "rules"', async () => {
    script.insertResult = { data: { id: 'intake-1' }, error: null };

    const result = await recordIntakeSubmission({
      workspaceId: WORKSPACE_ID,
      payload: { businessName: 'Acme' },
      routing,
    });

    expect(result).toEqual({ id: 'intake-1' });
    const insertCall = calls.find(
      (c) => c.table === 'intake_submissions' && c.op === 'insert'
    );
    expect(insertCall?.args[0]).toEqual({
      workspace_id: WORKSPACE_ID,
      payload: { businessName: 'Acme' },
      score: 8,
      routing_decision: 'custom',
      rules_fired: ['tightBudget', 'tightDeadline'],
      decided_by: 'rules',
    });
  });

  it('rejects a workspace id that is not a uuid', async () => {
    await expect(
      recordIntakeSubmission({
        workspaceId: 'not-a-uuid',
        payload: {},
        routing,
      })
    ).rejects.toThrow('valid workspaceId');
    expect(calls).toHaveLength(0);
  });

  it('surfaces a database error rather than reporting success', async () => {
    script.insertResult = { data: null, error: new Error('insert failed') };
    await expect(
      recordIntakeSubmission({
        workspaceId: WORKSPACE_ID,
        payload: {},
        routing,
      })
    ).rejects.toThrow('insert failed');
  });
});

describe('applyRoutingOverride', () => {
  it('flips the latest submission to an override and logs a project_events row', async () => {
    script.selectResult = { data: { id: 'intake-1' }, error: null };
    script.updateResult = { data: null, error: null };

    const result = await applyRoutingOverride({
      workspaceId: WORKSPACE_ID,
      decision: 'standard',
      reason: 'Client confirmed no bespoke work needed',
      actor: 'user_admin1',
    });

    expect(result).toEqual({ id: 'intake-1' });

    const update = calls.find(
      (c) => c.table === 'intake_submissions' && c.op === 'update'
    );
    expect(update?.args[0]).toEqual({
      routing_decision: 'standard',
      decided_by: 'override',
      overridden: true,
      override_reason: 'Client confirmed no bespoke work needed',
    });

    const event = calls.find(
      (c) => c.table === 'project_events' && c.op === 'insert'
    );
    expect(event?.args[0]).toMatchObject({
      workspace_id: WORKSPACE_ID,
      kind: 'routing_overridden',
      actor: 'user_admin1',
      payload: {
        decision: 'standard',
        reason: 'Client confirmed no bespoke work needed',
        intakeSubmissionId: 'intake-1',
      },
    });
  });

  it('throws when no intake submission exists for the workspace', async () => {
    script.selectResult = { data: null, error: null };
    await expect(
      applyRoutingOverride({
        workspaceId: WORKSPACE_ID,
        decision: 'custom',
        reason: 'reason',
        actor: 'user_admin1',
      })
    ).rejects.toThrow('no intake_submissions row');
  });

  it('rejects a blank reason', async () => {
    await expect(
      applyRoutingOverride({
        workspaceId: WORKSPACE_ID,
        decision: 'custom',
        reason: '   ',
        actor: 'user_admin1',
      })
    ).rejects.toThrow('reason');
  });

  it('rejects a workspace id that is not a uuid', async () => {
    await expect(
      applyRoutingOverride({
        workspaceId: 'not-a-uuid',
        decision: 'custom',
        reason: 'valid reason',
        actor: 'user_admin1',
      })
    ).rejects.toThrow('valid workspaceId');
    expect(calls).toHaveLength(0);
  });

  it('surfaces a failed lookup rather than silently overriding nothing', async () => {
    script.selectResult = { data: null, error: new Error('select failed') };
    await expect(
      applyRoutingOverride({
        workspaceId: WORKSPACE_ID,
        decision: 'custom',
        reason: 'valid reason',
        actor: 'user_admin1',
      })
    ).rejects.toThrow('select failed');
  });

  it('surfaces a failed write rather than reporting an override that did not land', async () => {
    script.selectResult = { data: { id: 'intake-1' }, error: null };
    script.updateResult = { data: null, error: new Error('update failed') };
    await expect(
      applyRoutingOverride({
        workspaceId: WORKSPACE_ID,
        decision: 'custom',
        reason: 'valid reason',
        actor: 'user_admin1',
      })
    ).rejects.toThrow('update failed');
    // The audit row is never written for an override that did not happen.
    expect(
      calls.find((c) => c.table === 'project_events' && c.op === 'insert')
    ).toBeUndefined();
  });

  it('fails when the override cannot be written to the audit trail', async () => {
    // An override nobody can see afterwards is worse than no override: the
    // routing decision would silently disagree with the record of why.
    script.selectResult = { data: { id: 'intake-1' }, error: null };
    script.eventResult = { data: null, error: new Error('event write failed') };

    await expect(
      applyRoutingOverride({
        workspaceId: WORKSPACE_ID,
        decision: 'custom',
        reason: 'valid reason',
        actor: 'user_admin1',
      })
    ).rejects.toThrow('event write failed');
  });

  it('rejects a blank actor', async () => {
    await expect(
      applyRoutingOverride({
        workspaceId: WORKSPACE_ID,
        decision: 'custom',
        reason: 'valid reason',
        actor: '',
      })
    ).rejects.toThrow('actor');
  });
});
