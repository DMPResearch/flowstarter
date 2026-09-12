/**
 * The Stripe event ledger.
 *
 * The contract under test is small and load-bearing: write the event down
 * before anything happens to it, report honestly whether it has already been
 * dealt with, and throw — never return a flag — when the database refuses,
 * because the route's only correct answer to a lost write is 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

type Result = {
  data?: unknown;
  error?: { code?: string; message: string } | null;
};

interface Capture {
  table: string;
  mode: string;
  values: Record<string, unknown> | null;
  filters: Record<string, unknown>;
}

const captured: Capture[] = [];
let respond: (call: Capture) => Result = () => ({ data: null, error: null });

function builderFor(table: string) {
  const state: Capture = { table, mode: 'select', values: null, filters: {} };
  const resolve = () => {
    captured.push({ ...state, filters: { ...state.filters } });
    const result = respond(state);
    return Promise.resolve({
      data: result.data ?? null,
      error: result.error ?? null,
    });
  };
  const builder = {
    insert(values: Record<string, unknown>) {
      state.mode = 'insert';
      state.values = values;
      return builder;
    },
    update(values: Record<string, unknown>) {
      state.mode = 'update';
      state.values = values;
      return builder;
    },
    select(columns: string) {
      state.filters.columns = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      state.filters[column] = value;
      return builder;
    },
    neq(column: string, value: unknown) {
      state.filters[`neq:${column}`] = value;
      return builder;
    },
    order(column: string, opts: unknown) {
      state.filters.order = [column, opts];
      return builder;
    },
    limit(n: number) {
      state.filters.limit = n;
      return resolve();
    },
    maybeSingle: () => resolve(),
    single: () => resolve(),
    then: (onFulfilled: unknown, onRejected: unknown) =>
      resolve().then(
        onFulfilled as never,
        onRejected as never
      ) as unknown as Promise<unknown>,
  };
  return builder;
}

const supabase = { from: builderFor } as never;

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => supabase,
}));

import {
  claimStripeEvent,
  finishStripeEvent,
  latestAppliedCreated,
  markStripeEventFailed,
  stripeObjectId,
} from '../stripe-events';

function event(overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    created: 1_700_000_000,
    data: { object: { id: 'sub_1' } },
    ...overrides,
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  captured.length = 0;
  respond = () => ({ data: null, error: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('stripeObjectId', () => {
  it('reads the object id out of the event payload', () => {
    expect(stripeObjectId(event())).toBe('sub_1');
  });

  it('is null for an object with no usable id', () => {
    expect(
      stripeObjectId(event({ data: { object: {} } } as Partial<Stripe.Event>))
    ).toBeNull();
    expect(
      stripeObjectId(
        event({ data: { object: { id: '' } } } as Partial<Stripe.Event>)
      )
    ).toBeNull();
  });
});

describe('claimStripeEvent', () => {
  it('records a first delivery and reports it unprocessed', async () => {
    const claim = await claimStripeEvent(supabase, event());
    expect(claim).toEqual({
      alreadyProcessed: false,
      previousOutcome: null,
      attempts: 1,
    });
    expect(captured[0]).toMatchObject({
      table: 'stripe_events',
      mode: 'insert',
      values: {
        id: 'evt_1',
        type: 'customer.subscription.updated',
        created: new Date(1_700_000_000 * 1000).toISOString(),
        object_id: 'sub_1',
      },
    });
  });

  it('falls back to now rather than throwing on a payload with no created', async () => {
    const claim = await claimStripeEvent(
      supabase,
      event({ created: undefined } as unknown as Partial<Stripe.Event>)
    );
    expect(claim.alreadyProcessed).toBe(false);
    const values = captured[0].values as { created: string };
    expect(Number.isNaN(Date.parse(values.created))).toBe(false);
  });

  it('reports a redelivery of a processed event and bumps its attempt count', async () => {
    respond = (call) => {
      if (call.mode === 'insert')
        return { error: { code: '23505', message: 'duplicate key' } };
      if (call.mode === 'select')
        return {
          data: {
            processed_at: '2026-09-12T10:00:00.000Z',
            outcome: 'processed',
            attempts: 2,
          },
        };
      return { error: null };
    };
    const claim = await claimStripeEvent(supabase, event());
    expect(claim).toEqual({
      alreadyProcessed: true,
      previousOutcome: 'processed',
      attempts: 3,
    });
    expect(captured.at(-1)).toMatchObject({
      mode: 'update',
      values: { attempts: 3 },
      filters: { id: 'evt_1' },
    });
  });

  it('lets a retry through when the previous attempt never finished', async () => {
    respond = (call) => {
      if (call.mode === 'insert')
        return { error: { code: '23505', message: 'duplicate key' } };
      if (call.mode === 'select')
        return {
          data: { processed_at: null, outcome: 'failed', attempts: 1 },
        };
      return { error: null };
    };
    const claim = await claimStripeEvent(supabase, event());
    expect(claim.alreadyProcessed).toBe(false);
    expect(claim.previousOutcome).toBe('failed');
    expect(claim.attempts).toBe(2);
  });

  it('treats a conflict whose row then vanished as a first delivery', async () => {
    respond = (call) => {
      if (call.mode === 'insert')
        return { error: { code: '23505', message: 'duplicate key' } };
      return { data: null };
    };
    const claim = await claimStripeEvent(supabase, event());
    expect(claim.alreadyProcessed).toBe(false);
    expect(claim.attempts).toBe(1);
  });

  it('throws on any database error that is not a duplicate', async () => {
    respond = () => ({
      error: { code: '08006', message: 'connection failure' },
    });
    await expect(claimStripeEvent(supabase, event())).rejects.toMatchObject({
      message: 'connection failure',
    });
  });

  it('throws when the conflicting row cannot be read back', async () => {
    respond = (call) =>
      call.mode === 'insert'
        ? { error: { code: '23505', message: 'duplicate key' } }
        : { error: { message: 'read failed' } };
    await expect(claimStripeEvent(supabase, event())).rejects.toMatchObject({
      message: 'read failed',
    });
  });

  it('throws when the attempt counter cannot be written', async () => {
    respond = (call) => {
      if (call.mode === 'insert')
        return { error: { code: '23505', message: 'duplicate key' } };
      if (call.mode === 'select')
        return { data: { processed_at: null, outcome: null, attempts: 1 } };
      return { error: { message: 'update failed' } };
    };
    await expect(claimStripeEvent(supabase, event())).rejects.toMatchObject({
      message: 'update failed',
    });
  });
});

describe('latestAppliedCreated', () => {
  it('returns the newest applied event as unix seconds', async () => {
    respond = () => ({ data: [{ created: '2023-11-14T22:13:20.000Z' }] });
    const created = await latestAppliedCreated(supabase, {
      objectId: 'sub_1',
      excludeEventId: 'evt_2',
    });
    expect(created).toBe(1_700_000_000);
    expect(captured[0].filters).toMatchObject({
      object_id: 'sub_1',
      outcome: 'processed',
      'neq:id': 'evt_2',
      limit: 1,
    });
  });

  it('returns null when nothing has been applied to the object yet', async () => {
    respond = () => ({ data: [] });
    await expect(
      latestAppliedCreated(supabase, {
        objectId: 'sub_1',
        excludeEventId: 'evt_2',
      })
    ).resolves.toBeNull();
  });

  it('throws rather than guessing when the lookup fails', async () => {
    respond = () => ({ error: { message: 'lookup failed' } });
    await expect(
      latestAppliedCreated(supabase, {
        objectId: 'sub_1',
        excludeEventId: 'evt_2',
      })
    ).rejects.toMatchObject({ message: 'lookup failed' });
  });
});

describe('finishStripeEvent', () => {
  it('stamps processed_at for every final outcome', async () => {
    for (const outcome of ['processed', 'ignored', 'superseded'] as const) {
      captured.length = 0;
      await finishStripeEvent(supabase, { eventId: 'evt_1', outcome });
      const values = captured[0].values as Record<string, unknown>;
      expect(values.outcome).toBe(outcome);
      expect(values.processed_at).toEqual(expect.any(String));
    }
  });

  it('leaves processed_at null for a failure, so Stripe’s retry finds work', async () => {
    await finishStripeEvent(supabase, {
      eventId: 'evt_1',
      outcome: 'failed',
      error: 'deposit paid failed',
    });
    expect(captured[0].values).toMatchObject({
      outcome: 'failed',
      processed_at: null,
      last_error: 'deposit paid failed',
    });
  });

  it('truncates a long error rather than refusing to record it', async () => {
    await finishStripeEvent(supabase, {
      eventId: 'evt_1',
      outcome: 'failed',
      error: 'x'.repeat(900),
    });
    expect(
      (captured[0].values as { last_error: string }).last_error
    ).toHaveLength(500);
  });

  it('throws when the stamp itself cannot be written', async () => {
    respond = () => ({ error: { message: 'ledger down' } });
    await expect(
      finishStripeEvent(supabase, { eventId: 'evt_1', outcome: 'processed' })
    ).rejects.toMatchObject({ message: 'ledger down' });
  });
});

describe('markStripeEventFailed', () => {
  it('records the failure', async () => {
    await markStripeEventFailed(supabase, {
      eventId: 'evt_1',
      error: 'boom',
    });
    expect(captured[0].values).toMatchObject({
      outcome: 'failed',
      last_error: 'boom',
    });
  });

  it('never throws over a database that is itself the problem', async () => {
    respond = () => ({ error: { message: 'ledger down too' } });
    await expect(
      markStripeEventFailed(supabase, { eventId: 'evt_1', error: 'boom' })
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
