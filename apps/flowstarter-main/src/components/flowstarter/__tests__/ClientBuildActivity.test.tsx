/**
 * The build timeline on the client's dashboard, and the two things it has to
 * get right.
 *
 * The first is that it draws nothing until there is something to draw. A
 * project whose build has just been claimed, a route that is not answering,
 * an empty timeline: all three have to leave the page exactly as it was, so
 * the stepper is never pushed down by an empty box that says nothing.
 *
 * The second is that `SiteOverview` only asks for it in the one stage where a
 * build is running, and never on a surface that was handed no workspace at all
 * -- the design gallery mounts it against fixtures and must not fetch.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { I18nProvider } from '@/lib/i18n';
import en from '@/locales/en';
import { ClientBuildActivity } from '../ClientBuildActivity';
import { SiteOverview, buildIsRunning } from '../SiteOverview';

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

const originalFetch = global.fetch;

function wrap(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en" initialMessages={{ en }}>
        {node}
      </I18nProvider>
    </QueryClientProvider>
  );
}

function answer(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    json: async () => body,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('ClientBuildActivity', () => {
  it('renders the panel once steps arrive', async () => {
    global.fetch = answer({
      status: 'running',
      events: [
        {
          at: '2026-09-14T10:00:00.000Z',
          phase: 'build',
          kind: 'editing',
          subject: 'page.home',
        },
      ],
    }) as unknown as typeof fetch;

    wrap(<ClientBuildActivity workspaceId={WORKSPACE} live />);

    expect(
      await screen.findByText(en['agentActivity.headline.build'])
    ).toBeInTheDocument();
    // `getAllByText`, not `getByText`: the live step is deliberately said
    // twice, once in the list and once in the screen-reader live region.
    expect(
      screen.getAllByText(
        en['agentActivity.step.editing.active'].replace(
          '{subject}',
          en['agentActivity.subject.page.home']
        )
      ).length
    ).toBeGreaterThan(0);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/client/site/${WORKSPACE}/activity`,
      { cache: 'no-store' }
    );
  });

  it('renders nothing while the timeline is empty', async () => {
    global.fetch = answer({
      status: 'running',
      events: [],
    }) as unknown as typeof fetch;

    const { container } = wrap(
      <ClientBuildActivity workspaceId={WORKSPACE} live={false} />
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the request fails', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    const { container } = wrap(
      <ClientBuildActivity workspaceId={WORKSPACE} live={false} />
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('names a finished build as finished', async () => {
    global.fetch = answer({
      status: 'done',
      events: [
        {
          at: '2026-09-14T10:00:00.000Z',
          phase: 'publish',
          kind: 'done',
          subject: 'site',
        },
      ],
    }) as unknown as typeof fetch;

    wrap(<ClientBuildActivity workspaceId={WORKSPACE} live={false} />);

    expect(
      await screen.findByText(en['agentActivity.headline.buildDone'])
    ).toBeInTheDocument();
  });

  it('names a stopped build as stopped', async () => {
    global.fetch = answer({
      status: 'failed',
      events: [
        {
          at: '2026-09-14T10:00:00.000Z',
          phase: 'gate',
          kind: 'failed',
          subject: 'gate.links',
        },
      ],
    }) as unknown as typeof fetch;

    wrap(<ClientBuildActivity workspaceId={WORKSPACE} live={false} />);

    expect(
      await screen.findByText(en['agentActivity.headline.stopped'])
    ).toBeInTheDocument();
  });
});

describe('the placement rule', () => {
  it('is the one stage that means an agent is working on it', () => {
    expect(buildIsRunning(ProjectState.AGENTS_WORKING)).toBe(true);
    for (const state of [
      ProjectState.INTAKE,
      ProjectState.PREVIEW_READY,
      ProjectState.DEPOSIT_PAID,
      ProjectState.HUMAN_QA,
      ProjectState.LIVE_SUBSCRIPTION,
    ]) {
      expect(buildIsRunning(state)).toBe(false);
    }
  });

  it('asks for the timeline while the site is being built', async () => {
    global.fetch = answer({
      status: 'running',
      events: [
        {
          at: '2026-09-14T10:00:00.000Z',
          phase: 'build',
          kind: 'building',
          subject: 'site',
        },
      ],
    }) as unknown as typeof fetch;

    wrap(
      <SiteOverview
        state={ProjectState.AGENTS_WORKING}
        tiles={[]}
        workspaceId={WORKSPACE}
      />
    );

    expect(
      await screen.findByText(en['agentActivity.headline.build'])
    ).toBeInTheDocument();
  });

  it('does not ask once the site is live', async () => {
    global.fetch = answer({
      status: 'done',
      events: [],
    }) as unknown as typeof fetch;

    wrap(
      <SiteOverview
        state={ProjectState.LIVE_SUBSCRIPTION}
        tiles={[]}
        workspaceId={WORKSPACE}
      />
    );

    await waitFor(() =>
      expect(
        screen.queryByText(en['agentActivity.headline.build'])
      ).not.toBeInTheDocument()
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not fetch on a surface with no workspace, such as the gallery', async () => {
    global.fetch = answer({
      status: 'running',
      events: [],
    }) as unknown as typeof fetch;

    wrap(<SiteOverview state={ProjectState.AGENTS_WORKING} tiles={[]} />);

    await waitFor(() => expect(global.fetch).not.toHaveBeenCalled());
  });
});
