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
        from: () => ({
          select: () => ({
            gte: async () => ({ data: null, error: { message: 'boom' } }),
          }),
        }),
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
        from: () => ({
          select: () => ({
            gte: async () => {
              throw new Error('connection reset');
            },
          }),
        }),
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
        from: () => ({
          select: () => ({
            gte: async () => ({ data: [{ cost_eur: 25 }], error: null }),
          }),
        }),
      }),
    }));

    const { funnelBudgetState } = await freshModule();
    const result = await funnelBudgetState();

    expect(result.state).toBe('blocked');
    expect(result.reason).toBe('over-cap');
    expect(result.spentEur).toBe(25);
    vi.doUnmock('@supabase/supabase-js');
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
