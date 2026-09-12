/**
 * MVP readiness review, "Lead capture": "The admin 'Custom inquiries' page
 * reads `/api/admin/custom-inquiries`, a different table [than
 * `contact_submissions`]... Nothing ever reads it." This is the new route
 * that does, with the same auth guard as `/api/admin/custom-inquiries`.
 */
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

let queryResult: {
  data: unknown[] | null;
  error: { message: string } | null;
  count: number | null;
};
const rangeSpy = vi.fn();
const orderSpy = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: (_cols: string, _opts: unknown) => ({
        order: (...args: unknown[]) => {
          orderSpy(...args);
          return {
            range: (...rangeArgs: unknown[]) => {
              rangeSpy(...rangeArgs);
              return Promise.resolve({ ...queryResult, table });
            },
          };
        },
      }),
    }),
  }),
}));

import { GET } from '../route';

function getRequest(query = ''): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/contact-submissions${query}`
  );
}

describe('GET /api/admin/contact-submissions', () => {
  beforeEach(() => {
    authState.userId = 'user_team_1';
    authState.role = 'team';
    queryResult = {
      data: [
        {
          id: '1',
          created_at: '2026-09-13T00:00:00Z',
          name: 'Elena',
          email: 'elena@example.ro',
          subject: 'Project',
          message: 'Hello',
          read_at: null,
          responded_at: null,
          notes: null,
        },
      ],
      error: null,
      count: 1,
    };
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  it('rejects a signed-out caller', async () => {
    authState.userId = null;
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  it('rejects a caller who is not a team member', async () => {
    authState.role = 'client';
    const res = await GET(getRequest());
    expect(res.status).toBe(403);
  });

  it('lists submissions newest first with their read state', async () => {
    const res = await GET(getRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.submissions).toHaveLength(1);
    expect(json.submissions[0]).toMatchObject({ id: '1', read_at: null });
    expect(json.total).toBe(1);
    // Newest first.
    expect(orderSpy).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('surfaces a db error as 500', async () => {
    queryResult = { data: null, error: { message: 'boom' }, count: null };
    const res = await GET(getRequest());
    expect(res.status).toBe(500);
  });
});
