/**
 * The client's two enquiry pages.
 *
 * Both read with the service role, which bypasses RLS, so
 * `requireWorkspaceAccess` is the whole of the isolation and the first case in
 * each block is somebody asking for a project that is not theirs. After that:
 * the settings page must show the token and the endpoint (they are public and
 * the client needs both), and the list page must show this workspace's
 * enquiries with spam out of the way.
 */
import { render, screen } from '@testing-library/react';
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClientEnquiriesPage from '../page';
import ClientEnquiriesListPage from '../list/page';

vi.mock('server-only', () => ({}));

const MINE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const THEIRS = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';
const TOKEN = 'Kx9-_abcdefghijklmnopqrstuvwxyz0123456789AB';

const state: {
  authorizedFor: string[];
  workspaces: Array<Record<string, unknown>>;
  leads: Array<Record<string, unknown>>;
  refusalStatus: number;
} = {
  authorizedFor: [MINE],
  workspaces: [],
  leads: [],
  refusalStatus: 404,
};

class NotFoundSignal extends Error {}
class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceAccess: async (workspaceId: string) =>
    state.authorizedFor.includes(workspaceId)
      ? {
          authorized: true,
          userId: 'user_client',
          workspaceId,
          via: 'membership',
        }
      : {
          authorized: false,
          response: NextResponse.json(
            { error: 'Workspace not found' },
            { status: state.refusalStatus }
          ),
        },
}));

function tableRows(table: string): Array<Record<string, unknown>> {
  if (table === 'workspaces') return state.workspaces;
  if (table === 'leads') return state.leads;
  return [];
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      let rows = tableRows(table);
      const keep = (
        predicate: (row: Record<string, unknown>) => boolean,
        column: string
      ) => {
        rows = rows.filter((row) => !(column in row) || predicate(row));
      };
      const builder = {
        select: () => builder,
        update: () => builder,
        eq: (column: string, value: unknown) => {
          keep((row) => row[column] === value, column);
          return builder;
        },
        neq: (column: string, value: unknown) => {
          keep((row) => row[column] !== value, column);
          return builder;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          const direction = options?.ascending === false ? -1 : 1;
          rows = [...rows].sort(
            (a, b) =>
              String(a[column] ?? '').localeCompare(String(b[column] ?? '')) *
              direction
          );
          return builder;
        },
        limit: (count: number) => {
          rows = rows.slice(0, count);
          return builder;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return builder;
    },
  }),
}));

const params = (workspaceId: string) => ({
  params: Promise.resolve({ workspaceId }),
});

function workspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MINE,
    slug: 'acme',
    name: 'Acme',
    client_business_name: 'Acme Dental',
    lead_capture_token: TOKEN,
    ...overrides,
  };
}

function lead(overrides: Record<string, unknown> = {}) {
  return {
    id: `lead-${Math.random()}`,
    workspace_id: MINE,
    name: 'Elena',
    email: 'elena@salon.ro',
    phone: null,
    message: 'Doresc o programare',
    source: '/contact',
    status: 'new',
    created_at: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  process.env.PLATFORM_DOMAIN = 'flowstarter.test';
  state.authorizedFor = [MINE];
  state.workspaces = [workspaceRow()];
  state.leads = [];
  state.refusalStatus = 404;
});

// ── Settings ───────────────────────────────────────────────────────────────

describe('the contact form settings page', () => {
  it('refuses a project that is not the caller own', async () => {
    await expect(ClientEnquiriesPage(params(THEIRS))).rejects.toBeInstanceOf(
      NotFoundSignal
    );
  });

  it('sends a signed-out caller to sign in, and back', async () => {
    state.authorizedFor = [];
    state.refusalStatus = 401;
    await expect(ClientEnquiriesPage(params(MINE))).rejects.toMatchObject({
      to: `/login?next=/dashboard/projects/${MINE}/enquiries`,
    });
  });

  it('shows the token and the endpoint it belongs to', async () => {
    render(await ClientEnquiriesPage(params(MINE)));
    expect(screen.getByTestId('lead-capture-token')).toHaveTextContent(TOKEN);
    expect(screen.getByTestId('lead-capture-endpoint')).toHaveTextContent(
      `https://flowstarter.test/api/leads/capture/${TOKEN}`
    );
  });

  it('offers Rotate, and asks before doing it', async () => {
    render(await ClientEnquiriesPage(params(MINE)));
    expect(screen.getByTestId('lead-capture-rotate')).toBeInTheDocument();
    expect(screen.queryByTestId('lead-capture-confirm')).toBeNull();
  });

  it('points at the list', async () => {
    render(await ClientEnquiriesPage(params(MINE)));
    expect(screen.getByTestId('enquiries-list-link')).toHaveAttribute(
      'href',
      `/dashboard/projects/${MINE}/enquiries/list`
    );
  });
});

// ── The list ───────────────────────────────────────────────────────────────

describe('the enquiries list page', () => {
  it('refuses a project that is not the caller own', async () => {
    await expect(
      ClientEnquiriesListPage(params(THEIRS))
    ).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('says so when there is nothing yet', async () => {
    render(await ClientEnquiriesListPage(params(MINE)));
    expect(screen.getByTestId('leads-empty')).toBeInTheDocument();
  });

  it('shows this workspace enquiries and counts only the real ones', async () => {
    state.leads = [
      lead({ id: 'a1', message: 'Doresc o programare' }),
      lead({ id: 'a2', status: 'spam', message: 'Buy now' }),
      lead({ id: 'b1', workspace_id: THEIRS, message: 'Not yours' }),
    ];
    render(await ClientEnquiriesListPage(params(MINE)));

    expect(screen.getByText('Doresc o programare')).toBeInTheDocument();
    expect(screen.queryByText('Not yours')).toBeNull();
    // Spam is loaded but behind the toggle.
    expect(screen.queryByText('Buy now')).toBeNull();
    expect(screen.getByTestId('leads-spam-toggle')).toHaveTextContent(
      '1 filtered as spam'
    );
    expect(screen.getByTestId('enquiries-summary')).toHaveTextContent(
      '1 message'
    );
  });

  it('offers no spam toggle when there is no spam', async () => {
    state.leads = [lead({ id: 'a1' })];
    render(await ClientEnquiriesListPage(params(MINE)));
    expect(screen.queryByTestId('leads-spam-toggle')).toBeNull();
  });
});
