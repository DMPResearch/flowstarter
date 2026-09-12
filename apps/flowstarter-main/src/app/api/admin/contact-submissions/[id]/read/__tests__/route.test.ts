import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const authState: { userId: string | null; role: string | undefined } = {
  userId: 'user_team_1',
  role: 'team',
};

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: { metadata: { role: authState.role } },
  }),
  clerkClient: async () => ({
    users: {
      getUser: async () => ({
        publicMetadata: {},
        emailAddresses: [],
        primaryEmailAddressId: null,
      }),
    },
  }),
}));

const eqSpy = vi.fn(async () => ({
  error: null as { message: string } | null,
}));
const updateSpy = vi.fn((_values: unknown) => ({ eq: eqSpy }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      update: (values: unknown) => updateSpy(values),
    }),
  }),
}));

import { POST } from '../route';

function postRequest(): NextRequest {
  return new NextRequest(
    'http://localhost/api/admin/contact-submissions/1/read',
    { method: 'POST' }
  );
}

describe('POST /api/admin/contact-submissions/[id]/read', () => {
  beforeEach(() => {
    authState.userId = 'user_team_1';
    authState.role = 'team';
    updateSpy.mockClear();
    eqSpy.mockClear();
    eqSpy.mockResolvedValue({ error: null });
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  it('rejects a signed-out caller', async () => {
    authState.userId = null;
    const res = await POST(postRequest(), {
      params: Promise.resolve({ id: '1' }),
    });
    expect(res.status).toBe(401);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a caller who is not a team member', async () => {
    authState.role = 'client';
    const res = await POST(postRequest(), {
      params: Promise.resolve({ id: '1' }),
    });
    expect(res.status).toBe(403);
  });

  it('marks the row read', async () => {
    const res = await POST(postRequest(), {
      params: Promise.resolve({ id: '1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ read_at: expect.any(String) })
    );
    expect(eqSpy).toHaveBeenCalledWith('id', '1');
  });
});
