/**
 * The client project page.
 *
 * Every row on this page is read with the service role, which bypasses RLS.
 * `requireWorkspaceAccess` is therefore the whole of the isolation, and the
 * first case here is a non-member asking for someone else's project.
 */
import { render, screen } from '@testing-library/react';
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import ClientProjectPage from '../page';

vi.mock('server-only', () => ({}));

const MINE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const THEIRS = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';

const state: {
  authorizedFor: string[];
  workspace: Record<string, unknown> | null;
  hosts: Array<{ hostname: string; is_primary: boolean }>;
  messages: Array<Record<string, unknown>>;
  leads: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  products: Array<Record<string, unknown>>;
  bookings: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  /** Status the access helper refuses with: 404 for a stranger, 401 signed out. */
  refusalStatus: number;
} = {
  authorizedFor: [MINE],
  workspace: null,
  hosts: [],
  messages: [],
  leads: [],
  events: [],
  products: [],
  bookings: [],
  jobs: [],
  refusalStatus: 404,
};

/** Recent enough to land inside both the 30-day and the this-month windows. */
const NOW_ISO = new Date().toISOString();

function lead(overrides: Record<string, unknown> = {}) {
  return {
    id: `lead-${Math.random()}`,
    workspace_id: MINE,
    status: 'new',
    created_at: NOW_ISO,
    ...overrides,
  };
}

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: `booking-${Math.random()}`,
    workspace_id: MINE,
    external_uid: `bk_${Math.random()}`,
    status: 'booked',
    start_at: NOW_ISO,
    created_at: NOW_ISO,
    ...overrides,
  };
}

function event(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `event-${Math.random()}`,
    workspace_id: MINE,
    kind,
    created_at: NOW_ISO,
    ...overrides,
  };
}

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

const notifyClientBuildNeedsReview = vi.fn(
  async (_input: { workspaceId: string; jobId: string }) => ({ sent: true })
);
vi.mock('@/lib/flowstarter/build-failure-notice', () => ({
  notifyClientBuildNeedsReview: (input: {
    workspaceId: string;
    jobId: string;
  }) => notifyClientBuildNeedsReview(input),
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
          // Mirrors the real helper: 404, never 403, so the response does not
          // confirm the workspace exists.
          response: NextResponse.json(
            { error: 'Workspace not found' },
            { status: state.refusalStatus }
          ),
        },
}));

/**
 * A chainable stand-in for the service-role client.
 *
 * It filters rather than returning everything, because the overview tiles are
 * counts over `eq`/`neq`/`gte` and a fake that ignored filters would report
 * the same number for "enquiries this month" and "enquiries ever". A filter is
 * only applied to rows that actually carry the column, which is how the older
 * `workspace_hosts` fixtures (hostname and is_primary only) still work.
 */
function tableRows(table: string): Array<Record<string, unknown>> {
  if (table === 'workspaces') return state.workspace ? [state.workspace] : [];
  if (table === 'workspace_hosts') return state.hosts;
  if (table === 'project_messages') return state.messages;
  if (table === 'leads') return state.leads;
  if (table === 'project_events') return state.events;
  if (table === 'commerce_products') return state.products;
  if (table === 'workspace_bookings') return state.bookings;
  if (table === 'flowstarter_agent_jobs') return state.jobs;
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
        eq: (column: string, value: unknown) => {
          keep((row) => row[column] === value, column);
          return builder;
        },
        neq: (column: string, value: unknown) => {
          keep((row) => row[column] !== value, column);
          return builder;
        },
        gte: (column: string, value: string) => {
          keep((row) => String(row[column]) >= value, column);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          keep((row) => values.includes(row[column]), column);
          return builder;
        },
        order: () => builder,
        limit: (count: number) => {
          rows = rows.slice(0, count);
          return builder;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows, count: rows.length, error: null }),
      };
      return builder;
    },
  }),
}));

/** The overview tile with this key, or undefined when the rules omitted it. */
function tile(key: string): HTMLElement | undefined {
  return screen
    .getAllByTestId('site-overview-tile')
    .find((element) => element.dataset.key === key);
}

function workspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MINE,
    slug: 'acme',
    name: 'Acme',
    client_business_name: 'Acme Dental',
    project_state: ProjectState.PREVIEW_READY,
    deploy_status: 'pending',
    final_value_minor: 250_000,
    setup_fee: null,
    billing_currency: 'eur',
    deposit_status: 'pending',
    final_status: 'pending',
    final_invoice_url: null,
    tier_name: 'starter',
    cal_com_url: null,
    ...overrides,
  };
}

/** A workspace whose site is actually being served, which most tiles need. */
function liveWorkspace(overrides: Record<string, unknown> = {}) {
  return workspaceRow({
    project_state: ProjectState.LIVE_SUBSCRIPTION,
    deploy_status: 'live',
    ...overrides,
  });
}

async function renderPage(workspaceId: string) {
  const element = (await ClientProjectPage({
    params: Promise.resolve({ workspaceId }),
  })) as React.ReactElement;
  return render(element);
}

beforeEach(() => {
  state.authorizedFor = [MINE];
  state.workspace = workspaceRow();
  state.hosts = [];
  state.messages = [];
  state.leads = [];
  state.events = [];
  state.products = [];
  state.bookings = [];
  state.jobs = [];
  state.refusalStatus = 404;
  notifyClientBuildNeedsReview.mockClear();
});

describe('client project page authorization', () => {
  it('404s a non-member asking for another tenant’s project', async () => {
    await expect(renderPage(THEIRS)).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('sends a signed-out caller to sign in rather than 404ing them', async () => {
    state.authorizedFor = [];
    state.refusalStatus = 401;

    await expect(renderPage(MINE)).rejects.toMatchObject({
      to: `/login?next=/dashboard/projects/${MINE}`,
    });
  });

  it('renders the project for a member', async () => {
    await renderPage(MINE);
    expect(screen.getByText('Acme Dental')).toBeInTheDocument();
  });
});

describe('project stepper', () => {
  it('highlights the stage the project is actually in', async () => {
    state.workspace = workspaceRow({
      project_state: ProjectState.AGENTS_WORKING,
    });
    await renderPage(MINE);

    const current = screen
      .getAllByTestId('project-stage')
      .filter((el) => el.dataset.status === 'current');
    expect(current).toHaveLength(1);
    expect(current[0].dataset.state).toBe(ProjectState.AGENTS_WORKING);
    expect(screen.getByTestId('project-stage-title')).toHaveTextContent(
      /building your site/i
    );
  });

  it('marks earlier stages done and later ones upcoming', async () => {
    state.workspace = workspaceRow({ project_state: ProjectState.HUMAN_QA });
    await renderPage(MINE);

    const stages = screen.getAllByTestId('project-stage');
    expect(stages).toHaveLength(6);
    expect(stages.map((el) => el.dataset.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'current',
      'upcoming',
    ]);
  });

  it('never shows the raw enum name', async () => {
    state.workspace = workspaceRow({
      project_state: ProjectState.LIVE_SUBSCRIPTION,
    });
    await renderPage(MINE);
    expect(screen.queryByText(/LIVE_SUBSCRIPTION/)).not.toBeInTheDocument();
  });
});

describe('payment calls to action', () => {
  it('offers the deposit only in PREVIEW_READY', async () => {
    await renderPage(MINE);
    expect(screen.getByTestId('payment-cta-deposit')).toBeInTheDocument();
    // Links into the existing unlock flow rather than a second checkout.
    expect(
      screen.getByRole('link', { name: /Pay your .* deposit/i })
    ).toHaveAttribute('href', `/unlock/${MINE}`);
  });

  it('hides the deposit once it is paid', async () => {
    state.workspace = workspaceRow({ deposit_status: 'paid' });
    await renderPage(MINE);
    expect(screen.queryByTestId('payment-cta-deposit')).not.toBeInTheDocument();
  });

  it('hides the deposit in every other state', async () => {
    for (const projectState of [
      ProjectState.INTAKE,
      ProjectState.DEPOSIT_PAID,
      ProjectState.AGENTS_WORKING,
      ProjectState.LIVE_SUBSCRIPTION,
    ]) {
      state.workspace = workspaceRow({ project_state: projectState });
      const view = await renderPage(MINE);
      expect(
        screen.queryByTestId('payment-cta-deposit')
      ).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('asks for the balance at HUMAN_QA, which is where the balance gate sits', async () => {
    state.workspace = workspaceRow({
      project_state: ProjectState.HUMAN_QA,
      deposit_status: 'paid',
      final_status: 'sent',
    });
    await renderPage(MINE);

    expect(screen.getByTestId('payment-cta-balance')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-cta-deposit')).not.toBeInTheDocument();
  });

  it('asks for nothing once the balance is paid', async () => {
    state.workspace = workspaceRow({
      project_state: ProjectState.HUMAN_QA,
      deposit_status: 'paid',
      final_status: 'paid',
    });
    await renderPage(MINE);
    expect(screen.queryByTestId('payment-cta-balance')).not.toBeInTheDocument();
  });
});

describe('open asks and the site link', () => {
  it('lifts open asset requests out of the thread', async () => {
    state.messages = [
      {
        id: 'm1',
        workspace_id: MINE,
        direction: 'outbound',
        kind: 'asset_request',
        body: 'We need a few things',
        asks: [{ id: 'a1', label: 'Your logo, as a PNG' }],
        status: 'sent',
        sent_at: '2026-08-01T10:00:00Z',
        answered_at: null,
        created_by: 'team',
        created_at: '2026-08-01T10:00:00Z',
      },
      {
        id: 'm2',
        workspace_id: MINE,
        direction: 'outbound',
        kind: 'asset_request',
        body: 'Already handled',
        asks: [{ id: 'a2', label: 'Opening hours' }],
        status: 'answered',
        sent_at: '2026-07-01T10:00:00Z',
        answered_at: '2026-07-02T10:00:00Z',
        created_by: 'team',
        created_at: '2026-07-01T10:00:00Z',
      },
    ];
    await renderPage(MINE);

    const asks = screen.getAllByTestId('open-ask');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toHaveTextContent('Your logo, as a PNG');
  });

  it('offers no site link until something is deployed', async () => {
    await renderPage(MINE);
    expect(screen.queryByTestId('site-link')).not.toBeInTheDocument();
  });

  it('links the primary hostname once the site is live', async () => {
    state.workspace = workspaceRow({
      project_state: ProjectState.LIVE_SUBSCRIPTION,
      deploy_status: 'live',
    });
    state.hosts = [{ hostname: 'acmedental.ie', is_primary: true }];
    await renderPage(MINE);

    expect(screen.getByTestId('site-link')).toHaveAttribute(
      'href',
      'https://acmedental.ie'
    );
  });
});

/**
 * The "Your site" panel.
 *
 * Every number here is a count over rows the service role can see across every
 * tenant, so the cases below seed rows for this workspace and one for another,
 * and assert the tile reports only the first. The copy cases exist because a
 * tile that says "0" for a site that is not built yet and a site nobody
 * contacted are two different messages.
 */
describe('the site overview', () => {
  it('keeps the project stepper inside the new section', async () => {
    await renderPage(MINE);
    expect(screen.getByText('Your site')).toBeInTheDocument();
    expect(screen.getAllByTestId('project-stage')).toHaveLength(6);
  });

  it('shows the edits, enquiries, bookings, changes and brief tiles to a member', async () => {
    await renderPage(MINE);
    expect(
      screen.getAllByTestId('site-overview-tile').map((el) => el.dataset.key)
    ).toEqual(['credits', 'enquiries', 'bookings', 'changes', 'brief']);
  });

  it('points the brief tile at the page the client fills it in on', async () => {
    await renderPage(MINE);
    const brief = screen
      .getAllByTestId('site-overview-tile')
      .find((el) => el.dataset.key === 'brief');
    const href =
      brief?.getAttribute('href') ??
      brief?.querySelector('a')?.getAttribute('href') ??
      brief?.closest('a')?.getAttribute('href');
    expect(href).toBe(`/dashboard/projects/${MINE}/brief`);
  });

  it('counts this month’s proposals against the plan allowance', async () => {
    state.events = Array.from({ length: 4 }, () => event('site_edit_proposed'));
    await renderPage(MINE);

    expect(tile('credits')).toHaveTextContent('46 of 50');
    expect(tile('credits')).toHaveTextContent(/Edits left this month/);
    expect(tile('credits')).toHaveAttribute(
      'href',
      `/dashboard/projects/${MINE}/editor`
    );
  });

  it('gives a Pro plan the larger allowance the copy sells', async () => {
    state.workspace = workspaceRow({ tier_name: 'pro' });
    state.events = [event('site_edit_proposed')];
    await renderPage(MINE);
    expect(tile('credits')).toHaveTextContent('149 of 150');
  });

  it('never counts another workspace’s edits against this client', async () => {
    state.events = [
      event('site_edit_proposed'),
      event('site_edit_proposed', { workspace_id: THEIRS }),
    ];
    await renderPage(MINE);
    expect(tile('credits')).toHaveTextContent('49 of 50');
  });

  it('counts applied edits, not proposals, as changes made', async () => {
    state.events = [
      event('site_edit_proposed'),
      event('site_edited'),
      event('site_edited'),
    ];
    await renderPage(MINE);
    expect(tile('changes')).toHaveTextContent('2');
    expect(tile('changes')).toHaveTextContent(
      'Changes you made in the editor this month.'
    );
  });

  it('explains an empty enquiries tile before the site is live', async () => {
    await renderPage(MINE);
    expect(tile('enquiries')).toHaveAttribute('data-tone', 'muted');
    expect(tile('enquiries')).toHaveTextContent(
      /will show here once your site is live/
    );
  });

  it('counts real enquiries once the site is serving', async () => {
    state.workspace = liveWorkspace();
    state.hosts = [{ hostname: 'acmedental.ie', is_primary: true }];
    state.leads = [
      lead(),
      lead({ status: 'contacted' }),
      lead({ status: 'spam' }),
      lead({ workspace_id: THEIRS }),
    ];
    await renderPage(MINE);

    // Two enquiries, one of them still waiting; the spam row is not an
    // enquiry and the other tenant's row is not this client's.
    expect(tile('enquiries')).toHaveTextContent(
      'In the last 30 days. 2 enquiries in total, 1 waiting for a reply.'
    );
    expect(tile('enquiries')).toHaveAttribute('data-tone', 'attention');
  });

  it('asks the client to connect a booking link when there is none', async () => {
    await renderPage(MINE);
    expect(tile('bookings')).toHaveTextContent('Not set up');
    expect(tile('bookings')).toHaveAttribute('data-tone', 'attention');
    expect(tile('bookings')).toHaveAttribute(
      'href',
      `/dashboard/projects/${MINE}/booking`
    );
  });

  // A connected calendar with nothing on it is not the same fact as a
  // calendar nobody has hooked up, and the tile has to say which.
  it('says a connected calendar is empty rather than calling it set up', async () => {
    state.workspace = workspaceRow({ cal_com_url: 'https://cal.com/acme' });
    await renderPage(MINE);
    expect(tile('bookings')).toHaveTextContent(
      'Nothing booked yet. Your calendar is connected and taking bookings.'
    );
    expect(tile('bookings')).toHaveAttribute('data-tone', 'muted');
  });

  it('counts the bookings in the table, and points at the list once there are any', async () => {
    state.workspace = workspaceRow({ cal_com_url: 'https://cal.com/acme' });
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    state.bookings = [
      booking({ start_at: soon }),
      booking({ start_at: soon }),
      // Cancelled, so present in the table and absent from the count.
      booking({ start_at: soon, status: 'cancelled' }),
    ];
    await renderPage(MINE);
    expect(tile('bookings')).toHaveTextContent('2');
    expect(tile('bookings')).toHaveAttribute('data-tone', 'ok');
    expect(tile('bookings')).toHaveAttribute(
      'href',
      `/dashboard/projects/${MINE}/booking/list`
    );
  });

  // The numbers are read with the service role, which bypasses RLS, so the
  // workspace filter is the whole of the isolation.
  it('never counts another tenant’s bookings', async () => {
    state.workspace = workspaceRow({ cal_com_url: 'https://cal.com/acme' });
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    state.bookings = [booking({ workspace_id: THEIRS, start_at: soon })];
    await renderPage(MINE);
    expect(tile('bookings')).toHaveTextContent(
      'Nothing booked yet. Your calendar is connected and taking bookings.'
    );
  });

  it('treats a blank booking link as no booking link', async () => {
    state.workspace = workspaceRow({ cal_com_url: '   ' });
    await renderPage(MINE);
    expect(tile('bookings')).toHaveTextContent('Not set up');
  });

  it('keeps the shop tile off a plan with nothing to sell', async () => {
    await renderPage(MINE);
    expect(tile('store')).toBeUndefined();
  });

  it('shows the shop tile on an ecommerce plan', async () => {
    state.workspace = workspaceRow({ tier_name: 'ecommerce' });
    state.products = [
      { id: 'p1', workspace_id: MINE },
      { id: 'p2', workspace_id: MINE },
      { id: 'p3', workspace_id: THEIRS },
    ];
    await renderPage(MINE);

    expect(tile('store')).toHaveTextContent('2');
    expect(tile('store')).toHaveTextContent('2 products in your catalogue.');
  });

  it('never shows a column name or a plan key in the tiles', async () => {
    state.workspace = liveWorkspace({ tier_name: 'ecommerce' });
    state.products = [{ id: 'p1', workspace_id: MINE }];
    await renderPage(MINE);

    for (const element of screen.getAllByTestId('site-overview-tile')) {
      expect(element.textContent).not.toMatch(
        /tier_name|workspace_id|site_edit|cal_com_url/i
      );
    }
  });
});

/**
 * The state this page had no words for on 2026-09-12: a paid build that
 * failed, rolled back to DEPOSIT_PAID by the worker so a retry could claim
 * it, and read by the dashboard as "about to start".
 */
describe('a build that stopped', () => {
  const JOB = '74859ac5-6737-4dde-80ce-d82ef5e76a59';

  function failedBuild(overrides: Record<string, unknown> = {}) {
    return {
      id: JOB,
      workspace_id: MINE,
      kind: 'FULL_SITE_BUILD',
      status: 'failed',
      created_at: NOW_ISO,
      run_after: NOW_ISO,
      started_at: NOW_ISO,
      finished_at: NOW_ISO,
      ...overrides,
    };
  }

  it('tells the client a person is checking it, not that it is about to start', async () => {
    state.workspace = workspaceRow({
      project_state: ProjectState.DEPOSIT_PAID,
      deposit_status: 'paid',
      final_status: 'paid',
    });
    state.jobs = [failedBuild()];

    await renderPage(MINE);

    const title = screen.getByTestId('project-stage-title');
    expect(title).toHaveTextContent('Your build needs a second look');
    expect(title.dataset.buildAttention).toBe('failed');
    expect(screen.queryByText(/about to start/)).toBeNull();
    expect(screen.getByTestId('payment-line-balance')).toHaveTextContent(
      /needs a second look/
    );
  });

  it('emails the client once, keyed on the job that stopped', async () => {
    state.workspace = workspaceRow({
      project_state: ProjectState.DEPOSIT_PAID,
      deposit_status: 'paid',
    });
    state.jobs = [failedBuild()];

    await renderPage(MINE);

    expect(notifyClientBuildNeedsReview).toHaveBeenCalledTimes(1);
    expect(notifyClientBuildNeedsReview.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: MINE,
      jobId: JOB,
    });
  });

  it('says nothing and sends nothing while the build is running normally', async () => {
    state.workspace = workspaceRow({
      project_state: ProjectState.AGENTS_WORKING,
      deposit_status: 'paid',
    });
    state.jobs = [failedBuild({ status: 'running', finished_at: null })];

    await renderPage(MINE);

    expect(screen.getByTestId('project-stage-title')).toHaveTextContent(
      "We're building your site"
    );
    expect(notifyClientBuildNeedsReview).not.toHaveBeenCalled();
  });
});
