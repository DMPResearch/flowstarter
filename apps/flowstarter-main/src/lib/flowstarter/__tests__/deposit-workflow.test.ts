/**
 * The deposit gate, exercised through both Stripe webhook events.
 *
 * A deposit reaches Flowstarter one of two ways: the self-serve Checkout
 * PaymentIntent, or an operator-created deposit invoice. Both must advance
 * PREVIEW_READY -> DEPOSIT_PAID and enqueue exactly one full-site build, and
 * both must survive Stripe redelivering the same event.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  enqueueFullBuildFromDeposit,
  enqueueFullBuildFromDepositInvoice,
  productionActivationAllowed,
} from '../deposit-workflow';

interface ClientScript {
  workspace?: { data: unknown; error: unknown };
  insertResult?: { data: unknown; error: unknown };
  existingJob?: { data: unknown; error: unknown };
  stateUpdate?: { data: unknown; error: unknown };
  /** How the best-effort `project_events` insert resolves, or throws. */
  eventInsert?: { error: unknown } | 'throw';
}

const script: ClientScript = {};
const captured: {
  insert?: Record<string, unknown>;
  update?: Record<string, unknown>;
  /** Every insert into `project_events`, in call order — dispatch failures land here. */
  events: Array<Record<string, unknown>>;
  tables: string[];
} = { events: [], tables: [] };

function builderFor(table: string) {
  captured.tables.push(table);
  const builder = {
    _mode: 'select' as 'select' | 'insert' | 'update',
    select() {
      return builder;
    },
    insert(values: Record<string, unknown>) {
      builder._mode = 'insert';
      // project_events is a side-channel audit trail, not the row under test:
      // routing it separately means it can never clobber the job/workspace
      // insert a test is actually asserting on.
      if (table === 'project_events') {
        captured.events.push(values);
      } else {
        captured.insert = values;
      }
      return builder;
    },
    update(values: Record<string, unknown>) {
      builder._mode = 'update';
      captured.update = values;
      return builder;
    },
    eq() {
      return builder;
    },
    in() {
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(script.workspace ?? { data: null, error: null });
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      if (table === 'project_events' && script.eventInsert === 'throw') {
        return Promise.reject(new Error('project_events is unreachable')).then(
          resolve,
          reject
        );
      }
      return Promise.resolve(
        table === 'project_events'
          ? script.eventInsert ?? { error: null }
          : { data: null, error: null }
      ).then(resolve, reject);
    },
    single() {
      if (table === 'workspaces') {
        return Promise.resolve(
          script.stateUpdate ?? { data: { id: 'ws' }, error: null }
        );
      }
      return Promise.resolve(
        builder._mode === 'insert'
          ? script.insertResult ?? { data: { id: 'job-1' }, error: null }
          : script.existingJob ?? { data: null, error: null }
      );
    },
  };
  return builder;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builderFor }),
}));

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

function event(id = 'evt_1'): Stripe.Event {
  return { id } as Stripe.Event;
}

function depositInvoice(
  overrides: Record<string, unknown> = {}
): Stripe.Invoice {
  return {
    id: 'in_deposit_1',
    currency: 'eur',
    amount_paid: 15_980,
    metadata: { invoiceType: 'deposit', workspaceId: WORKSPACE_ID },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function workspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: WORKSPACE_ID,
      project_state: ProjectState.PREVIEW_READY,
      billing_currency: 'eur',
      deposit_invoice_id: 'in_deposit_1',
      final_value_minor: 79_900,
      deposit_payment_intent_id: null,
      ...overrides,
    },
    error: null,
  };
}

beforeEach(() => {
  delete script.workspace;
  delete script.insertResult;
  delete script.existingJob;
  delete script.stateUpdate;
  delete script.eventInsert;
  captured.insert = undefined;
  captured.update = undefined;
  captured.events = [];
  captured.tables = [];
});

describe('deposit paid by operator invoice', () => {
  it('advances the lifecycle and enqueues one build', async () => {
    script.workspace = workspaceRow();

    const result = await enqueueFullBuildFromDepositInvoice(
      event(),
      depositInvoice()
    );

    expect(result).toEqual({
      workspaceId: WORKSPACE_ID,
      jobId: 'job-1',
      duplicate: false,
    });
    expect(captured.insert).toMatchObject({
      workspace_id: WORKSPACE_ID,
      kind: 'FULL_SITE_BUILD',
      status: 'queued',
      stripe_event_id: 'evt_1',
      // An invoice deposit has no PaymentIntent of its own to record.
      stripe_payment_intent_id: null,
    });
    expect(captured.insert?.payload).toMatchObject({
      trigger: 'deposit_paid',
      source: 'deposit_invoice',
      depositPercent: 20,
    });
    expect(captured.update).toMatchObject({
      project_state: ProjectState.DEPOSIT_PAID,
      deposit_status: 'paid',
      outstanding_payment: false,
    });
    // The invoice path must not claim the PaymentIntent slot — it has a unique
    // index and belongs to the Checkout path.
    expect(captured.update).not.toHaveProperty('deposit_payment_intent_id');
  });

  it('still reports success when the build worker cannot be dispatched', async () => {
    // Production without a worker URL used to throw here, failing the webhook
    // after the deposit was recorded and sending Stripe into days of retries.
    script.workspace = workspaceRow();
    const previousEnv = process.env.NODE_ENV;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_URL', '');
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_SECRET', '');
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const result = await enqueueFullBuildFromDepositInvoice(
        event(),
        depositInvoice()
      );

      expect(result).toMatchObject({ jobId: 'job-1', duplicate: false });
      // The operator has to be able to find the job that needs picking up.
      expect(errors.mock.calls[0]?.[0]).toContain('job-1');
      expect(errors.mock.calls[0]?.[0]).toContain('could not be dispatched');
      // A log line is not enough on its own: it must also land on the
      // project's timeline so an operator sees it without tailing a server.
      expect(captured.events).toHaveLength(1);
      expect(captured.events[0]).toMatchObject({
        workspace_id: WORKSPACE_ID,
        kind: 'build_dispatch_failed',
      });
      expect(captured.events[0]?.payload).toMatchObject({ jobId: 'job-1' });
    } finally {
      errors.mockRestore();
      vi.stubEnv('NODE_ENV', previousEnv ?? 'test');
    }
  });

  it('still records a dispatch-failed event outside production, quietly', async () => {
    // Locally the build worker is normally unconfigured — that must not be
    // silent. It is expected, so it logs at `warn`, but it still lands on the
    // timeline exactly like the production failure above.
    script.workspace = workspaceRow();
    const warnings = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      vi.stubEnv('FLOWSTARTER_BUILD_WORKER_URL', '');
      vi.stubEnv('FLOWSTARTER_BUILD_WORKER_SECRET', '');
      const result = await enqueueFullBuildFromDepositInvoice(
        event(),
        depositInvoice()
      );

      expect(result).toMatchObject({ jobId: 'job-1', duplicate: false });
      expect(warnings.mock.calls[0]?.[0]).toContain('could not be dispatched');
      expect(errors).not.toHaveBeenCalled();
      expect(captured.events).toHaveLength(1);
      expect(captured.events[0]).toMatchObject({
        workspace_id: WORKSPACE_ID,
        kind: 'build_dispatch_failed',
        actor: 'system',
      });
    } finally {
      warnings.mockRestore();
      errors.mockRestore();
    }
  });

  it('ignores an invoice that is not a deposit', async () => {
    const result = await enqueueFullBuildFromDepositInvoice(
      event(),
      depositInvoice({
        metadata: { invoiceType: 'final', workspaceId: WORKSPACE_ID },
      })
    );
    expect(result).toBeNull();
    expect(captured.tables).toEqual([]);
  });

  it('does not throw the webhook for a workspace outside the concierge lifecycle', async () => {
    script.workspace = workspaceRow({ project_state: ProjectState.INTAKE });

    const result = await enqueueFullBuildFromDepositInvoice(
      event(),
      depositInvoice()
    );

    expect(result).toBeNull();
    expect(captured.insert).toBeUndefined();
  });

  it('refuses an invoice the server never recorded on the workspace', async () => {
    script.workspace = workspaceRow({ deposit_invoice_id: 'in_some_other' });

    await expect(
      enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
    ).rejects.toThrow(/does not match the invoice recorded/);
    expect(captured.insert).toBeUndefined();
  });

  it('refuses a currency that is not the quoted one', async () => {
    script.workspace = workspaceRow({ billing_currency: 'usd' });

    await expect(
      enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
    ).rejects.toThrow(/currency does not match/);
  });

  it('refuses an invoice marked paid with no money on it', async () => {
    script.workspace = workspaceRow();

    await expect(
      enqueueFullBuildFromDepositInvoice(
        event(),
        depositInvoice({ amount_paid: 0 })
      )
    ).rejects.toThrow(/no amount paid/);
  });

  it('converges on the existing job when Stripe redelivers the event', async () => {
    script.workspace = workspaceRow();
    script.insertResult = { data: null, error: { code: '23505' } };
    script.existingJob = {
      data: { id: 'job-1', status: 'queued' },
      error: null,
    };

    const result = await enqueueFullBuildFromDepositInvoice(
      event(),
      depositInvoice()
    );

    expect(result).toEqual({
      workspaceId: WORKSPACE_ID,
      jobId: 'job-1',
      duplicate: true,
    });
  });

  it('does not re-advance state for a build that already succeeded', async () => {
    script.workspace = workspaceRow({
      project_state: ProjectState.DEPOSIT_PAID,
    });
    script.insertResult = { data: null, error: { code: '23505' } };
    script.existingJob = {
      data: { id: 'job-1', status: 'succeeded' },
      error: null,
    };

    const result = await enqueueFullBuildFromDepositInvoice(
      event(),
      depositInvoice()
    );

    expect(result).toEqual({
      workspaceId: WORKSPACE_ID,
      jobId: 'job-1',
      duplicate: true,
    });
    expect(captured.update).toBeUndefined();
  });
});

describe('deposit paid by Checkout PaymentIntent', () => {
  function depositIntent(
    overrides: Record<string, unknown> = {}
  ): Stripe.PaymentIntent {
    return {
      id: 'pi_1',
      status: 'succeeded',
      currency: 'eur',
      amount_received: 15_980,
      metadata: { kind: 'flowstarter_deposit', workspaceId: WORKSPACE_ID },
      ...overrides,
    } as unknown as Stripe.PaymentIntent;
  }

  it('still records the PaymentIntent and tags the source', async () => {
    script.workspace = workspaceRow();

    const result = await enqueueFullBuildFromDeposit(event(), depositIntent());

    expect(result).toMatchObject({ jobId: 'job-1', duplicate: false });
    expect(captured.insert).toMatchObject({ stripe_payment_intent_id: 'pi_1' });
    expect(captured.insert?.payload).toMatchObject({
      source: 'payment_intent',
    });
    expect(captured.update).toMatchObject({
      project_state: ProjectState.DEPOSIT_PAID,
      deposit_payment_intent_id: 'pi_1',
    });
  });

  it('still rejects an amount that is not exactly 20% of the quote', async () => {
    script.workspace = workspaceRow();

    await expect(
      enqueueFullBuildFromDeposit(
        event(),
        depositIntent({ amount_received: 1_000 })
      )
    ).rejects.toThrow(/Deposit amount mismatch/);
  });

  it('ignores a PaymentIntent that is not a Flowstarter deposit', async () => {
    const result = await enqueueFullBuildFromDeposit(
      event(),
      depositIntent({ metadata: { kind: 'something_else' } })
    );
    expect(result).toBeNull();
  });
});

// ── The gate, from the outside ────────────────────────────────────────────
//
// Every refusal below happens before a job row exists. A deposit that reaches
// the build queue is one whose amount, currency, workspace and lifecycle state
// all agreed with what the server had already decided.

describe('deposits the gate turns away', () => {
  function depositIntent(
    overrides: Record<string, unknown> = {}
  ): Stripe.PaymentIntent {
    return {
      id: 'pi_1',
      status: 'succeeded',
      currency: 'eur',
      amount_received: 15_980,
      metadata: { kind: 'flowstarter_deposit', workspaceId: WORKSPACE_ID },
      ...overrides,
    } as unknown as Stripe.PaymentIntent;
  }

  it('refuses a deposit whose metadata names no workspace we could verify', async () => {
    for (const workspaceId of [undefined, '', 'ws-1']) {
      await expect(
        enqueueFullBuildFromDeposit(
          event(),
          depositIntent({
            metadata: { kind: 'flowstarter_deposit', workspaceId },
          })
        )
      ).rejects.toThrow(/valid workspaceId/);
    }
    expect(captured.tables).toEqual([]);
  });

  it('refuses a PaymentIntent Stripe has not marked succeeded', async () => {
    await expect(
      enqueueFullBuildFromDeposit(
        event(),
        depositIntent({ status: 'requires_payment_method' })
      )
    ).rejects.toThrow(/not succeeded/);
    expect(captured.tables).toEqual([]);
  });

  it('refuses to build for a workspace that does not exist or cannot be read', async () => {
    script.workspace = { data: null, error: null };
    await expect(
      enqueueFullBuildFromDeposit(event(), depositIntent())
    ).rejects.toThrow(/workspace does not exist/);

    script.workspace = { data: null, error: new Error('workspaces is down') };
    await expect(
      enqueueFullBuildFromDeposit(event(), depositIntent())
    ).rejects.toThrow('workspaces is down');
    expect(captured.insert).toBeUndefined();
  });

  it('refuses to start a build from a state a deposit cannot leave', async () => {
    script.workspace = workspaceRow({ project_state: ProjectState.HUMAN_QA });
    await expect(
      enqueueFullBuildFromDeposit(event(), depositIntent())
    ).rejects.toThrow(/cannot start a build from state HUMAN_QA/);
  });

  it('refuses a workspace that was never quoted', async () => {
    script.workspace = workspaceRow({ final_value_minor: null });
    await expect(
      enqueueFullBuildFromDeposit(event(), depositIntent())
    ).rejects.toThrow(/final value is not configured/);
  });

  it('refuses a second, different payment for a workspace already deposited on', async () => {
    script.workspace = workspaceRow({
      deposit_payment_intent_id: 'pi_somebody_else',
    });
    await expect(
      enqueueFullBuildFromDeposit(event(), depositIntent())
    ).rejects.toThrow(/already associated with a different deposit/);
    expect(captured.insert).toBeUndefined();
  });

  it('accepts the same PaymentIntent redelivered against its own workspace', async () => {
    script.workspace = workspaceRow({ deposit_payment_intent_id: 'pi_1' });
    await expect(
      enqueueFullBuildFromDeposit(event(), depositIntent())
    ).resolves.toMatchObject({ jobId: 'job-1' });
  });
});

describe('deposit invoices the gate ignores', () => {
  it('ignores an invoice with no id, and one naming no workspace', async () => {
    expect(
      await enqueueFullBuildFromDepositInvoice(
        event(),
        depositInvoice({ id: null })
      )
    ).toBeNull();
    expect(
      await enqueueFullBuildFromDepositInvoice(
        event(),
        depositInvoice({ metadata: { invoiceType: 'deposit' } })
      )
    ).toBeNull();
    expect(
      await enqueueFullBuildFromDepositInvoice(
        event(),
        depositInvoice({
          metadata: { invoiceType: 'deposit', workspaceId: 'not-a-uuid' },
        })
      )
    ).toBeNull();
    expect(captured.tables).toEqual([]);
  });

  it('accepts the older projectId spelling of the same field', async () => {
    script.workspace = workspaceRow();
    await expect(
      enqueueFullBuildFromDepositInvoice(
        event(),
        depositInvoice({
          metadata: { invoiceType: 'deposit', projectId: WORKSPACE_ID },
        })
      )
    ).resolves.toMatchObject({ workspaceId: WORKSPACE_ID });
  });

  it('ignores an invoice for a workspace that is gone, and surfaces a failed read', async () => {
    script.workspace = { data: null, error: null };
    expect(
      await enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
    ).toBeNull();

    script.workspace = { data: null, error: new Error('workspaces is down') };
    await expect(
      enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
    ).rejects.toThrow('workspaces is down');
  });
});

describe('when the ledger write itself fails', () => {
  it('does not report a build that was never queued', async () => {
    script.workspace = workspaceRow();

    script.insertResult = { data: null, error: new Error('jobs is down') };
    await expect(
      enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
    ).rejects.toThrow('jobs is down');

    script.insertResult = { data: null, error: null };
    await expect(
      enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
    ).rejects.toThrow(/Could not enqueue full site build/);
  });

  it('does not invent a job id when the duplicate cannot be read back', async () => {
    script.workspace = workspaceRow();
    script.insertResult = { data: null, error: { code: '23505' } };

    script.existingJob = { data: null, error: null };
    await expect(
      enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
    ).rejects.toThrow(/Existing build job was not found/);

    script.existingJob = { data: null, error: new Error('jobs is down') };
    await expect(
      enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
    ).rejects.toThrow('jobs is down');
  });

  it('fails the webhook when the deposit could not be recorded on the workspace', async () => {
    // Stripe retrying is right here: the money moved and the row did not.
    script.workspace = workspaceRow();
    script.stateUpdate = { data: null, error: new Error('workspaces is down') };

    await expect(
      enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
    ).rejects.toThrow('workspaces is down');
  });
});

describe('losing the dispatch-failure note', () => {
  function withoutWorker() {
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_URL', '');
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_SECRET', '');
  }

  it('still lets the deposit land when the timeline row cannot be written', async () => {
    script.workspace = workspaceRow();
    script.eventInsert = { error: { message: 'project_events is down' } };
    withoutWorker();
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
      ).resolves.toMatchObject({ jobId: 'job-1' });
      expect(
        errors.mock.calls.some((call) =>
          String(call[0]).includes('could not record build_dispatch_failed')
        )
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('still lets the deposit land when writing it throws', async () => {
    script.workspace = workspaceRow();
    script.eventInsert = 'throw';
    withoutWorker();
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
      ).resolves.toMatchObject({ jobId: 'job-1' });
      expect(
        errors.mock.calls.some((call) =>
          String(call[0]).includes('could not record build_dispatch_failed')
        )
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('when a site may be switched on for real', () => {
  const ready = {
    projectState: ProjectState.HUMAN_QA,
    finalStatus: 'paid',
    stripeSubscriptionId: 'sub_1',
    subscriptionStatus: 'active',
  };

  it('needs human QA, the balance paid, and a live subscription', () => {
    expect(productionActivationAllowed(ready)).toBe(true);
    expect(
      productionActivationAllowed({ ...ready, subscriptionStatus: 'trialing' })
    ).toBe(true);
    expect(
      productionActivationAllowed({ ...ready, subscriptionStatus: 'trial' })
    ).toBe(true);
  });

  it('refuses each missing piece on its own', () => {
    expect(
      productionActivationAllowed({
        ...ready,
        projectState: ProjectState.AGENTS_WORKING,
      })
    ).toBe(false);
    expect(
      productionActivationAllowed({ ...ready, finalStatus: 'pending' })
    ).toBe(false);
    expect(
      productionActivationAllowed({ ...ready, stripeSubscriptionId: null })
    ).toBe(false);
    expect(
      productionActivationAllowed({ ...ready, subscriptionStatus: 'past_due' })
    ).toBe(false);
    expect(
      productionActivationAllowed({ ...ready, subscriptionStatus: null })
    ).toBe(false);
  });
});
