/**
 * The brief page.
 *
 * Every row on this page is read with the service role, which bypasses RLS, so
 * `requireWorkspaceAccess` is the whole of the isolation and the first cases
 * here are a stranger and a signed-out caller. After that, the thing worth
 * asserting is that a workspace with no brief row yet still renders a form:
 * the first visit is the common case, and a 500 there would mean nobody could
 * ever start one.
 */
import { render, screen } from '@testing-library/react';
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClientBriefPage from '../page';

vi.mock('server-only', () => ({}));

const MINE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const THEIRS = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';
const PHOTO = '11111111-1111-4111-8111-111111111111';

const GOOD_OFFER =
  'We fit and service gas boilers for homes across the county, and we take on ' +
  'the emergency call-outs nobody else will.';

const state: {
  authorizedFor: string[];
  refusalStatus: number;
  workspace: Record<string, unknown> | null;
  brief: Record<string, unknown> | null;
  assets: Array<Record<string, unknown>>;
} = {
  authorizedFor: [MINE],
  refusalStatus: 404,
  workspace: null,
  brief: null,
  assets: [],
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

/**
 * The asset lister is the real module's job and has its own tests; what
 * matters here is that the page asks it for THIS workspace and nothing else,
 * which the recorded argument asserts.
 */
const listedFor: string[] = [];
vi.mock('@/app/api/client/assets/asset-storage', () => ({
  listWorkspaceAssets: async (workspaceId: string) => {
    listedFor.push(workspaceId);
    return state.assets;
  },
}));

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      let rows: Array<Record<string, unknown>> =
        table === 'workspaces'
          ? state.workspace
            ? [state.workspace]
            : []
          : state.brief
          ? [state.brief]
          : [];
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          rows = rows.filter(
            (row) => !(column in row) || row[column] === value
          );
          return builder;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      };
      return builder;
    },
  }),
}));

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PHOTO,
    source: 'upload',
    kind: null,
    mime: 'image/png',
    width: 2400,
    height: 1600,
    usableFor: ['hero'],
    selected: true,
    rightsConfirmedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    usable: true,
    url: 'https://storage.test/signed.png',
    ...overrides,
  };
}

async function renderPage(workspaceId: string) {
  const element = (await ClientBriefPage({
    params: Promise.resolve({ workspaceId }),
  })) as React.ReactElement;
  return render(element);
}

beforeEach(() => {
  state.authorizedFor = [MINE];
  state.refusalStatus = 404;
  state.workspace = { id: MINE };
  state.brief = null;
  state.assets = [];
  listedFor.length = 0;
});

describe('ClientBriefPage', () => {
  it('gives a non-member a 404 and reads nobody else s files', async () => {
    await expect(renderPage(THEIRS)).rejects.toBeInstanceOf(NotFoundSignal);
    expect(listedFor).toEqual([]);
  });

  it('sends a signed-out caller to the login page and back', async () => {
    state.authorizedFor = [];
    state.refusalStatus = 401;
    await expect(renderPage(MINE)).rejects.toMatchObject({
      to: `/login?next=/dashboard/projects/${MINE}/brief`,
    });
  });

  it('404s when the workspace itself is gone', async () => {
    state.workspace = null;
    await expect(renderPage(MINE)).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('renders an empty form on a first visit', async () => {
    await renderPage(MINE);
    expect(screen.getByTestId('brief-form')).toBeInTheDocument();
    expect(screen.getByTestId('brief-offer')).toHaveValue('');
    expect(screen.getAllByTestId('brief-missing-item').length).toBeGreaterThan(
      0
    );
    expect(listedFor).toEqual([MINE]);
  });

  it('opens with a way back to the project', async () => {
    await renderPage(MINE);
    expect(screen.getByTestId('brief-back-link')).toHaveAttribute(
      'href',
      `/dashboard/projects/${MINE}`
    );
  });

  it('renders the stored brief, including the photo marked as the portrait', async () => {
    state.assets = [assetRow({ kind: 'portrait' })];
    state.brief = {
      workspace_id: MINE,
      offer: GOOD_OFFER,
      projects: [
        {
          name: 'Boiler swap',
          line: 'Same day',
          link: 'https://example.com',
          screenshotAssetIds: [],
        },
      ],
      no_projects: false,
      design_reference_asset_ids: [],
      photo_asset_ids: [PHOTO],
      ready_at: null,
      override_at: null,
    };

    await renderPage(MINE);
    expect(screen.getByTestId('brief-offer')).toHaveValue(GOOD_OFFER);
    expect(screen.getAllByTestId('brief-project-row')).toHaveLength(1);
    expect(screen.getByTestId('brief-project-name')).toHaveValue('Boiler swap');
    expect(screen.getByTestId('brief-portrait')).toBeChecked();
  });

  it('renders a row whose projects column is not the shape we expect', async () => {
    state.brief = {
      workspace_id: MINE,
      offer: GOOD_OFFER,
      projects: 'not an array',
      no_projects: true,
      design_reference_asset_ids: null,
      photo_asset_ids: null,
      ready_at: null,
      override_at: null,
    };
    await renderPage(MINE);
    expect(screen.queryAllByTestId('brief-project-row')).toHaveLength(0);
    expect(screen.getByTestId('brief-no-projects')).toBeChecked();
  });

  it('drops entries in the projects column that are not objects', async () => {
    state.brief = {
      workspace_id: MINE,
      offer: GOOD_OFFER,
      projects: [null, { name: 'Kept', screenshotAssetIds: [1, 'x'] }],
      no_projects: false,
      design_reference_asset_ids: [],
      photo_asset_ids: [],
      ready_at: null,
      override_at: null,
    };
    await renderPage(MINE);
    expect(screen.getAllByTestId('brief-project-row')).toHaveLength(1);
    expect(screen.getByTestId('brief-project-name')).toHaveValue('Kept');
  });

  it('says the brief is complete when nothing blocking is left', async () => {
    state.assets = [
      assetRow({ kind: 'portrait' }),
      assetRow({ id: '22222222-2222-4222-8222-222222222222' }),
    ];
    state.brief = {
      workspace_id: MINE,
      offer: GOOD_OFFER,
      projects: [],
      no_projects: true,
      design_reference_asset_ids: ['33333333-3333-4333-8333-333333333333'],
      photo_asset_ids: [PHOTO, '22222222-2222-4222-8222-222222222222'],
      ready_at: '2026-09-12T09:00:00.000Z',
      override_at: null,
    };
    await renderPage(MINE);
    expect(screen.getByTestId('brief-ready')).toHaveTextContent(
      'Your brief is complete'
    );
  });
});
