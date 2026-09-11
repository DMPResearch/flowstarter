import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(() => ({ mocked: 'client' })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

const ORIGINAL_ENV = { ...process.env };

describe('supabase-clients/server target guard', () => {
  beforeEach(() => {
    vi.resetModules();
    createClientMock.mockClear();
    process.env = { ...ORIGINAL_ENV };
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('throws under FLOWSTARTER_ENV=development with a remote Supabase URL', async () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      'https://avptvzherjxymmbtbbbr.supabase.co';
    delete process.env.FLOWSTARTER_ALLOW_REMOTE_SUPABASE;

    const { createSupabaseClient } = await import('../server');
    expect(() => createSupabaseClient()).toThrow(/development/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('does not throw under FLOWSTARTER_ENV=development with a local Supabase URL', async () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';

    const { createSupabaseClient } = await import('../server');
    expect(() => createSupabaseClient()).not.toThrow();
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('createSupabaseServiceRoleClient also throws against a remote target in development', async () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      'https://avptvzherjxymmbtbbbr.supabase.co';
    delete process.env.FLOWSTARTER_ALLOW_REMOTE_SUPABASE;

    const { createSupabaseServiceRoleClient } = await import('../server');
    expect(() => createSupabaseServiceRoleClient()).toThrow(/development/);
  });

  it('createSupabaseServerClientWithAuth also throws against a remote target in development', async () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      'https://avptvzherjxymmbtbbbr.supabase.co';
    delete process.env.FLOWSTARTER_ALLOW_REMOTE_SUPABASE;

    const { createSupabaseServerClientWithAuth } = await import('../server');
    expect(() => createSupabaseServerClientWithAuth('jwt')).toThrow(
      /development/
    );
  });

  it('is a no-op in test env against a remote target (guard never fires)', async () => {
    process.env.FLOWSTARTER_ENV = 'test';
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      'https://avptvzherjxymmbtbbbr.supabase.co';

    const { createSupabaseClient } = await import('../server');
    expect(() => createSupabaseClient()).not.toThrow();
  });
});
