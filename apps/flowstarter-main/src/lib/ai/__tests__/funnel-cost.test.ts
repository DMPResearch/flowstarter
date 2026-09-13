/**
 * MVP readiness review, "Security": "The spend cap fails open... every
 * failure path in `funnel-cost.ts` returns `ok`: no service key, missing
 * table, query error, any throw." This is the regression suite for the
 * fix: outside development every one of those paths must now return
 * `blocked` with `reason: 'accounting-error'`, and a cost-ledger write
 * failure must be logged and counted rather than silently swallowed.
 * Development keeps the old fail-open behaviour, since the local stack
 * routinely runs without `SUPABASE_SERVICE_ROLE_KEY` or a seeded table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function freshModule() {
  vi.resetModules();
  return import('../funnel-cost');
}

/** `NODE_ENV` is typed read-only (Next augments the global env shape), so it
 * can only be changed by replacing the whole `process.env` object rather
 * than assigning the property directly. */
function setNodeEnv(value: string): void {
  process.env = {
    ...process.env,
    NODE_ENV: value as typeof process.env.NODE_ENV,
  };
}

describe('funnelBudgetState — accounting failures', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('fails CLOSED when no service client can be built, outside development', async () => {
    setNodeEnv('test');
    const { funnelBudgetState } = await freshModule();

    const result = await funnelBudgetState();

    expect(result.state).toBe('blocked');
    expect(result.reason).toBe('accounting-error');
  });

  it('fails OPEN in development when no service client can be built', async () => {
    setNodeEnv('development');
    const { funnelBudgetState } = await freshModule();

    const result = await funnelBudgetState();

    expect(result.state).toBe('ok');
    expect(result.reason).toBeUndefined();
  });

  it('fails CLOSED on a query error, outside development, and never on-cap open', async () => {
    setNodeEnv('production');
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        rpc: async () => ({ data: null, error: { message: 'boom' } }),
      }),
    }));

    const { funnelBudgetState } = await freshModule();
    const result = await funnelBudgetState();

    expect(result.state).toBe('blocked');
    expect(result.reason).toBe('accounting-error');
    vi.doUnmock('@supabase/supabase-js');
  });

  it('fails CLOSED when the query throws, outside development', async () => {
    setNodeEnv('staging');
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        rpc: async () => {
          throw new Error('connection reset');
        },
      }),
    }));

    const { funnelBudgetState } = await freshModule();
    const result = await funnelBudgetState();

    expect(result.state).toBe('blocked');
    expect(result.reason).toBe('accounting-error');
    vi.doUnmock('@supabase/supabase-js');
  });

  it('still reports a real over-cap block with its own distinct reason', async () => {
    setNodeEnv('production');
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    process.env.DISCOVERY_FUNNEL_BUDGET_EUR = '10';

    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        rpc: async () => ({ data: 25, error: null }),
      }),
    }));

    const { funnelBudgetState } = await freshModule();
    const result = await funnelBudgetState();

    expect(result.state).toBe('blocked');
    expect(result.reason).toBe('over-cap');
    expect(result.spentEur).toBe(25);
    vi.doUnmock('@supabase/supabase-js');
  });

  it('uses a server-side aggregate (funnel_budget_spent_eur), never a row fetch that could hit max_rows', async () => {
    // Security audit F06: `select cost_eur ...` fetched individual rows and
    // summed them client-side, silently truncating once the ledger passed
    // PostgREST's max_rows. This asserts the fix's shape directly: the RPC
    // is called by name, with the month-to-date `since` boundary, and its
    // single returned number is trusted as the total regardless of how many
    // rows contributed to it (simulated here as a total no batch of
    // individually-fetched rows under max_rows could represent honestly:
    // an amount a naive per-row sum limited to 1000 rows could never reach
    // if each row were a fraction of a cent, so a real truncation bug would
    // instead report something far lower than this and fail the assertion).
    setNodeEnv('production');
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    process.env.DISCOVERY_FUNNEL_BUDGET_EUR = '10000';

    const rpcSpy = vi.fn(
      async (name: string, args: Record<string, unknown>) => {
        expect(name).toBe('funnel_budget_spent_eur');
        expect(typeof (args as { since: string }).since).toBe('string');
        return { data: 9999.99, error: null };
      }
    );
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ rpc: rpcSpy }),
    }));

    const { funnelBudgetState } = await freshModule();
    const result = await funnelBudgetState();

    expect(rpcSpy).toHaveBeenCalledOnce();
    expect(result.spentEur).toBe(9999.99);
    // Not 'blocked': the RPC's own number is trusted directly, never
    // recomputed from (and truncated by) a capped row fetch.
    expect(result.state).not.toBe('blocked');
    vi.doUnmock('@supabase/supabase-js');
  });
});

describe('reserveFunnelSpend / settleFunnelReservation / releaseFunnelReservation', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.doUnmock('@supabase/supabase-js');
  });

  it('allows a reservation that fits under the cap, via the atomic RPC', async () => {
    setNodeEnv('production');
    const rpcSpy = vi.fn(async () => ({
      data: [
        {
          reservation_id: 'res-1',
          allowed: true,
          spent_eur: 1.5,
          caller_spent_eur: 0,
          reason: null,
        },
      ],
      error: null,
    }));
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ rpc: rpcSpy }),
    }));

    const { reserveFunnelSpend } = await freshModule();
    const result = await reserveFunnelSpend({
      estimateEur: 0.5,
      kind: 'codegen',
      ip: '203.0.113.9',
    });

    expect(result).toEqual({
      allowed: true,
      reservationId: 'res-1',
      spentEur: 1.5,
    });
    expect(rpcSpy).toHaveBeenCalledWith(
      'reserve_funnel_spend',
      expect.objectContaining({ p_estimate_eur: 0.5, p_kind: 'codegen' })
    );
  });

  it('refuses a reservation that would exceed the global cap, with reason over-cap', async () => {
    setNodeEnv('production');
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        rpc: async () => ({
          data: [
            {
              reservation_id: null,
              allowed: false,
              spent_eur: 49.8,
              caller_spent_eur: 0,
              reason: 'over-cap',
            },
          ],
          error: null,
        }),
      }),
    }));

    const { reserveFunnelSpend } = await freshModule();
    const result = await reserveFunnelSpend({
      estimateEur: 0.5,
      kind: 'codegen',
    });

    expect(result).toEqual({
      allowed: false,
      reason: 'over-cap',
      spentEur: 49.8,
    });
  });

  it('refuses a reservation that would exceed the per-caller cap, with reason over-caller-cap', async () => {
    setNodeEnv('production');
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        rpc: async () => ({
          data: [
            {
              reservation_id: null,
              allowed: false,
              spent_eur: 1,
              caller_spent_eur: 4.9,
              reason: 'over-caller-cap',
            },
          ],
          error: null,
        }),
      }),
    }));

    const { reserveFunnelSpend } = await freshModule();
    const result = await reserveFunnelSpend({
      estimateEur: 0.5,
      kind: 'codegen',
      ip: '203.0.113.9',
    });

    expect(result).toEqual({
      allowed: false,
      reason: 'over-caller-cap',
      spentEur: 1,
    });
  });

  it('fails CLOSED (not reserved) on a reservation RPC error outside development', async () => {
    setNodeEnv('production');
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        rpc: async () => ({ data: null, error: { message: 'boom' } }),
      }),
    }));

    const { reserveFunnelSpend } = await freshModule();
    const result = await reserveFunnelSpend({
      estimateEur: 0.5,
      kind: 'codegen',
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('accounting-error');
  });

  it('fails OPEN (reserved) on a reservation RPC error in development', async () => {
    setNodeEnv('development');
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        rpc: async () => ({ data: null, error: { message: 'boom' } }),
      }),
    }));

    const { reserveFunnelSpend } = await freshModule();
    const result = await reserveFunnelSpend({
      estimateEur: 0.5,
      kind: 'codegen',
    });

    expect(result).toEqual({
      allowed: true,
      reservationId: 'dev-unreserved',
      spentEur: 0,
    });
  });

  it('settleFunnelReservation keeps the reserved estimate when no actual cost/usage is given', async () => {
    setNodeEnv('production');
    const rpcSpy = vi.fn(async () => ({ error: null }));
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ rpc: rpcSpy }),
    }));

    const { settleFunnelReservation } = await freshModule();
    await settleFunnelReservation('res-1');

    expect(rpcSpy).toHaveBeenCalledWith('settle_funnel_reservation', {
      p_reservation_id: 'res-1',
      p_actual_cost_eur: null,
      p_tokens_in: null,
      p_tokens_out: null,
    });
  });

  it('settleFunnelReservation uses a real reported cost when given one', async () => {
    setNodeEnv('production');
    const rpcSpy = vi.fn(async () => ({ error: null }));
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ rpc: rpcSpy }),
    }));

    const { settleFunnelReservation } = await freshModule();
    await settleFunnelReservation('res-1', { costUsd: 1.23 });

    expect(rpcSpy).toHaveBeenCalledWith(
      'settle_funnel_reservation',
      expect.objectContaining({ p_actual_cost_eur: 1.23 })
    );
  });

  it('settleFunnelReservation counts and logs a failed RPC, without throwing', async () => {
    setNodeEnv('production');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        rpc: async () => ({ error: { message: 'boom' } }),
      }),
    }));

    const {
      settleFunnelReservation,
      costLedgerWriteFailureCount,
      _resetCostLedgerWriteFailureCountForTests,
    } = await freshModule();
    _resetCostLedgerWriteFailureCountForTests();

    await expect(settleFunnelReservation('res-1')).resolves.toBeUndefined();
    expect(costLedgerWriteFailureCount()).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('releaseFunnelReservation calls the release RPC and never throws', async () => {
    setNodeEnv('production');
    const rpcSpy = vi.fn(async () => ({ error: null }));
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({ rpc: rpcSpy }),
    }));

    const { releaseFunnelReservation } = await freshModule();
    await expect(releaseFunnelReservation('res-1')).resolves.toBeUndefined();

    expect(rpcSpy).toHaveBeenCalledWith('release_funnel_reservation', {
      p_reservation_id: 'res-1',
    });
  });
});

describe('recordGenerationCost — write failures are logged and counted', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.doUnmock('@supabase/supabase-js');
  });

  it('counts a failure when there is no service client configured', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const {
      recordGenerationCost,
      costLedgerWriteFailureCount,
      _resetCostLedgerWriteFailureCountForTests,
    } = await freshModule();
    _resetCostLedgerWriteFailureCountForTests();

    await recordGenerationCost({ kind: 'preview' });

    expect(costLedgerWriteFailureCount()).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('counts a failure when the insert itself returns an error', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: () => ({
          insert: async () => ({ error: { message: 'insert failed' } }),
        }),
      }),
    }));

    const {
      recordGenerationCost,
      costLedgerWriteFailureCount,
      _resetCostLedgerWriteFailureCountForTests,
    } = await freshModule();
    _resetCostLedgerWriteFailureCountForTests();

    await recordGenerationCost({ kind: 'preview' });

    expect(costLedgerWriteFailureCount()).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does not count or throw on a successful write', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: () => ({
          insert: async () => ({ error: null }),
        }),
      }),
    }));

    const {
      recordGenerationCost,
      costLedgerWriteFailureCount,
      _resetCostLedgerWriteFailureCountForTests,
    } = await freshModule();
    _resetCostLedgerWriteFailureCountForTests();

    await expect(
      recordGenerationCost({ kind: 'preview' })
    ).resolves.toBeUndefined();
    expect(costLedgerWriteFailureCount()).toBe(0);
  });
});
