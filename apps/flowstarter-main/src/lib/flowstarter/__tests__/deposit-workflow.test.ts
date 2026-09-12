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
  /** Makes reading the ledger fail, which is how the notifier gives up safely. */
  eventSelectFails?: boolean;
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
      // Reading the audit trail back is not decoration here: the "tell the
      // client once" guard is a select over `project_events`, so a fake that
      // always answers empty would make a redelivery test prove nothing.
      if (table === 'project_events' && builder._mode === 'select') {
        return Promise.resolve(
          script.eventSelectFails
            ? { data: null, error: { message: 'project_events unavailable' } }
            : { data: captured.events, error: null }
        ).then(resolve, reject);
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

/**
 * The preview a workspace claimed. Scripted rather than faked through
 * postgrest, because what is under test here is what reaches the job payload,
 * not how the row is read.
 */
const previewScript: {
  row?: unknown;
  throws?: boolean;
  requested: string[];
} = { requested: [] };

vi.mock('@/lib/hosting/funnel-previews', () => ({
  loadFunnelPreview: async (previewId: string) => {
    previewScript.requested.push(previewId);
    if (previewScript.throws) throw new Error('funnel_previews is unreachable');
    return previewScript.row ?? null;
  },
}));

const sendEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
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

const PREVIEW_ID = 'ccb48228-2fca-4cae-b1ed-7fcf9ce6a48a';
const HEADLINE = 'I build websites with AI agents, supervised by people';

/** A claimed preview row carrying one free change the client approved. */
function previewRow(overrides: Record<string, unknown> = {}) {
  return {
    previewId: PREVIEW_ID,
    templateSlug: 'creative-portfolio',
    artifactPath: `funnel/${PREVIEW_ID}/site.tar.gz`,
    manifest: {
      files: [
        {
          path: 'src/content/site-labels.md',
          content: `heroHeadline: "${HEADLINE}"`,
          type: 'file',
        },
      ],
      intake: {
        projectId: WORKSPACE_ID,
        business: {
          name: 'Darius Mihai Popescu',
          niche: 'Creative & design',
          location: 'Remote',
        },
        socialMedia: [],
        locale: 'en-GB',
        submittedAt: '2026-09-11T18:00:00.000Z',
        consent: {
          publicProfileAnalysis: true,
          acceptedAt: '2026-09-11T18:00:00.000Z',
        },
      },
      appliedEdits: [
        {
          index: 1,
          instruction: `Make the hero headline say ${HEADLINE}`,
          changedPaths: ['src/content/site-labels.md'],
          addedPhrases: [HEADLINE],
          appliedAt: '2026-09-11T18:30:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  delete previewScript.row;
  delete previewScript.throws;
  previewScript.requested = [];
  delete script.workspace;
  delete script.insertResult;
  delete script.existingJob;
  delete script.stateUpdate;
  delete script.eventInsert;
  delete script.eventSelectFails;
  captured.insert = undefined;
  captured.update = undefined;
  captured.events = [];
  captured.tables = [];
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true, id: 'em_1' });
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

/**
 * The email the concierge path never sent.
 *
 * The deposit block that was supposed to say "your deposit is in and your
 * build has started" lived inside the booking-deposit handler and returned
 * before reaching the send for every concierge payment, so a client who paid
 * a real deposit heard nothing at all. These cases pin the four things that
 * have to be true of the replacement: it fires on both concierge entry
 * points, it fires once, it fires at the client rather than at us, and it
 * cannot take the deposit down with it.
 */
describe('telling the client their deposit landed', () => {
  function paidIntent(): Stripe.PaymentIntent {
    return {
      id: 'pi_1',
      status: 'succeeded',
      currency: 'eur',
      amount_received: 15_980,
      metadata: { kind: 'flowstarter_deposit', workspaceId: WORKSPACE_ID },
    } as unknown as Stripe.PaymentIntent;
  }

  function withClient(overrides: Record<string, unknown> = {}) {
    return workspaceRow({
      client_email: 'client@example.com',
      client_name: 'Darius',
      client_business_name: 'Acme Dental',
      name: 'Acme workspace',
      ...overrides,
    });
  }

  function mail(): { to: string; subject: string; html: string } {
    return sendEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
    };
  }

  it('emails the client on the Checkout deposit path', async () => {
    script.workspace = withClient();

    await enqueueFullBuildFromDeposit(event(), paidIntent());

    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The old handler mailed hello@flowstarter.net. This one mails the person
    // who paid.
    expect(mail().to).toBe('client@example.com');
    expect(mail().subject).toBe(
      'Your deposit is in and your build has started'
    );
    expect(mail().html).toContain(`/dashboard/projects/${WORKSPACE_ID}`);
    expect(mail().html).toContain('Acme Dental');
  });

  /**
   * The build is queued on deposit and then waits for the in-depth brief, so
   * this email is the only thing standing between a client and a build that
   * sits still for a week while they believe nothing is needed from them.
   */
  it('asks for the brief and links straight to the page that holds it', async () => {
    script.workspace = withClient();

    await enqueueFullBuildFromDeposit(event(), paidIntent());

    expect(mail().html).toContain(`/dashboard/projects/${WORKSPACE_ID}/brief`);
    expect(mail().html).toContain('Fill in your brief');
    expect(mail().html).not.toContain('Nothing else is needed from you');
  });

  it('emails the client on the operator invoice path too', async () => {
    script.workspace = withClient();

    await enqueueFullBuildFromDepositInvoice(event(), depositInvoice());

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mail().to).toBe('client@example.com');
  });

  it('records the send so a redelivered event does not repeat it', async () => {
    script.workspace = withClient();

    await enqueueFullBuildFromDeposit(event(), paidIntent());
    const ledger = captured.events.find(
      (row) => row.kind === 'client_email_sent'
    );
    expect(ledger).toMatchObject({
      workspace_id: WORKSPACE_ID,
      actor: 'system:client_email',
    });
    expect(ledger?.payload).toMatchObject({ notification: 'deposit_paid' });

    // Stripe redelivers. The build gate is already idempotent; the mail has to
    // be too, because a second copy is what makes a client stop reading them.
    await enqueueFullBuildFromDeposit(event(), paidIntent());
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the workspace has no client address', async () => {
    script.workspace = workspaceRow({ client_email: null });

    const result = await enqueueFullBuildFromDeposit(event(), paidIntent());

    expect(result).toMatchObject({ jobId: 'job-1' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('still queues the build when the mailer is unreachable', async () => {
    script.workspace = withClient();
    sendEmail.mockRejectedValue(new Error('socket hang up'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A throw here would fail the webhook after the money is recorded and the
    // job is queued, and Stripe would retry for days over a mail server.
    await expect(
      enqueueFullBuildFromDeposit(event(), paidIntent())
    ).resolves.toMatchObject({ jobId: 'job-1', duplicate: false });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('still queues the build when the ledger cannot be read', async () => {
    script.workspace = withClient();
    script.eventSelectFails = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      enqueueFullBuildFromDepositInvoice(event(), depositInvoice())
    ).resolves.toMatchObject({ jobId: 'job-1' });
    expect(sendEmail).not.toHaveBeenCalled();
    errors.mockRestore();
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

describe('the build payload carries what the client approved', () => {
  function depositIntent(): Stripe.PaymentIntent {
    return {
      id: 'pi_1',
      status: 'succeeded',
      currency: 'eur',
      amount_received: 15_980,
      metadata: { kind: 'flowstarter_deposit', workspaceId: WORKSPACE_ID },
    } as unknown as Stripe.PaymentIntent;
  }

  it('puts the claimed preview and its free changes on the FULL_SITE_BUILD', async () => {
    script.workspace = workspaceRow({ claimed_preview_id: PREVIEW_ID });
    previewScript.row = previewRow();

    await enqueueFullBuildFromDeposit(event(), depositIntent());

    expect(previewScript.requested).toEqual([PREVIEW_ID]);
    const payload = captured.insert?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      trigger: 'deposit_paid',
      source: 'payment_intent',
      depositPercent: 20,
      balancePercent: 80,
      claimedPreviewId: PREVIEW_ID,
    });
    expect(payload['previewIntent']).toMatchObject({
      previewId: PREVIEW_ID,
      manifest: {
        ref: `funnel_previews:${PREVIEW_ID}`,
        artifactPath: `funnel/${PREVIEW_ID}/site.tar.gz`,
        templateSlug: 'creative-portfolio',
        fileCount: 1,
      },
      brief: { businessName: 'Darius Mihai Popescu' },
    });
    expect((payload['previewIntent'] as { edits: unknown[] }).edits).toEqual([
      {
        index: 1,
        instruction: `Make the hero headline say ${HEADLINE}`,
        changedPaths: ['src/content/site-labels.md'],
        addedPhrases: [HEADLINE],
        appliedAt: '2026-09-11T18:30:00.000Z',
      },
    ]);
  });

  it('leaves an operator-created project with the payload it always had', async () => {
    // No claimed preview: the workspace was created by hand, there is no
    // preview to be continuous with, and the build must be unaffected.
    script.workspace = workspaceRow({ claimed_preview_id: null });

    const result = await enqueueFullBuildFromDeposit(event(), depositIntent());

    expect(result?.jobId).toBe('job-1');
    expect(previewScript.requested).toEqual([]);
    expect(captured.insert?.payload).toEqual({
      trigger: 'deposit_paid',
      source: 'payment_intent',
      depositPercent: 20,
      balancePercent: 80,
    });
  });

  it('still takes the deposit when the preview row has gone', async () => {
    script.workspace = workspaceRow({ claimed_preview_id: PREVIEW_ID });
    previewScript.row = null;

    const result = await enqueueFullBuildFromDeposit(event(), depositIntent());

    expect(result?.jobId).toBe('job-1');
    const payload = captured.insert?.payload as Record<string, unknown>;
    expect(payload['claimedPreviewId']).toBe(PREVIEW_ID);
    expect(payload).not.toHaveProperty('previewIntent');
  });

  it('never fails a paid deposit because the preview could not be read', async () => {
    script.workspace = workspaceRow({ claimed_preview_id: PREVIEW_ID });
    previewScript.throws = true;
    const warnings = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    try {
      const result = await enqueueFullBuildFromDeposit(
        event(),
        depositIntent()
      );

      expect(result?.jobId).toBe('job-1');
      expect(captured.insert?.payload).not.toHaveProperty('previewIntent');
      expect(warnings.mock.calls[0]?.[0]).toContain(
        'could not read the approved preview'
      );
    } finally {
      warnings.mockRestore();
    }
  });

  it('carries the preview through the operator-invoice deposit too', async () => {
    script.workspace = workspaceRow({ claimed_preview_id: PREVIEW_ID });
    previewScript.row = previewRow();

    await enqueueFullBuildFromDepositInvoice(event(), depositInvoice());

    const payload = captured.insert?.payload as Record<string, unknown>;
    expect(payload['source']).toBe('deposit_invoice');
    expect(payload['claimedPreviewId']).toBe(PREVIEW_ID);
    expect(payload['previewIntent']).toBeTruthy();
  });
});
