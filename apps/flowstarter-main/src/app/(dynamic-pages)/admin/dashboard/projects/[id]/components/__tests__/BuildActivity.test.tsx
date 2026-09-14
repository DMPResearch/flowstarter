/**
 * The operator's copy of the agent timeline.
 *
 * It is the same component the client sees, asked one different question:
 * `detail` is on, so the file a step edited and the verdict a gate returned
 * are on screen. That is the whole point of the operator view -- the person
 * reading it is the person who has to open that file -- so what is pinned
 * here is that the detail survives the trip, that the steps arrive in the
 * order the worker wrote them, and that an empty tab says why it is empty
 * rather than rendering nothing at all.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import en from '@/locales/en';
import { BuildActivity } from '../PipelineTab';

const PROJECT_ID = 'c009105e-f8ec-42bf-bdcf-cf92bb500f45';
const JOB_ID = '8c2a5e0e-9a3d-4b0a-9c9b-3a0f0f1a2b3c';

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function activityRow(
  kind: string,
  subject: string,
  seconds: number,
  detail?: string
) {
  return {
    id: `${kind}-${seconds}`,
    kind: 'activity',
    actor: 'system',
    body: 'Agents expanding the site',
    payload: {
      activity: {
        at: new Date(Date.UTC(2026, 8, 14, 10, 0, seconds)).toISOString(),
        phase: 'Agents expanding the site',
        kind,
        subject,
        ...(detail ? { detail } : {}),
      },
    },
    createdAt: new Date(Date.UTC(2026, 8, 14, 10, 0, seconds)).toISOString(),
  };
}

function answer(events: unknown[]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ events }),
  }));
}

function mount(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en" initialMessages={{ en }}>
        {ui}
      </I18nProvider>
    </QueryClientProvider>
  );
}

/** The step labels currently drawn, in order. */
function steps(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.fs-activity__label')).map(
    (node) => node.textContent ?? ''
  );
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('BuildActivity', () => {
  it('asks the events endpoint for the activity rows and nothing else', async () => {
    global.fetch = answer([]) as unknown as typeof fetch;

    mount(
      <BuildActivity
        projectId={PROJECT_ID}
        jobId={JOB_ID}
        status="running"
        placeholder
      />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/admin/projects/${PROJECT_ID}/pipeline/jobs/${JOB_ID}/events?kinds=activity`,
        { cache: 'no-store' }
      );
    });
  });

  it('draws the steps in the order the worker wrote them, with the file paths', async () => {
    global.fetch = answer([
      activityRow('searching', 'template.library', 1),
      activityRow(
        'reading',
        'section.services',
        4,
        'src/components/Services.astro'
      ),
      activityRow(
        'reading',
        'section.services',
        5,
        'src/components/Services.astro'
      ),
      activityRow(
        'editing',
        'section.services',
        9,
        'src/components/Services.astro'
      ),
    ]) as unknown as typeof fetch;

    const { container } = mount(
      <BuildActivity projectId={PROJECT_ID} jobId={JOB_ID} status="running" />
    );

    await waitFor(() => {
      expect(steps(container)).toEqual([
        'Searched the template library',
        'Read the services section (2)',
        'Editing the services section',
      ]);
    });
    // The operator's extra, which a client never receives.
    expect(container.textContent).toContain('src/components/Services.astro');
  });

  it('drops a row whose payload is not one of ours rather than repairing it', async () => {
    global.fetch = answer([
      activityRow('editing', 'page.home', 1),
      { id: 'junk', kind: 'activity', payload: { activity: { kind: 'nope' } } },
      { id: 'empty', kind: 'activity', payload: {} },
    ]) as unknown as typeof fetch;

    const { container } = mount(
      <BuildActivity projectId={PROJECT_ID} jobId={JOB_ID} status="running" />
    );

    await waitFor(() => expect(steps(container)).toHaveLength(1));
  });

  it('says why a tab is empty instead of drawing nothing', async () => {
    global.fetch = answer([]) as unknown as typeof fetch;

    mount(
      <BuildActivity
        projectId={PROJECT_ID}
        jobId={JOB_ID}
        status="succeeded"
        placeholder
      />
    );

    // It says "waiting" while the request is in flight, which is true, and
    // settles on "none" once a finished build has answered with nothing.
    await waitFor(() => {
      expect(screen.getByTestId('build-activity-empty')).toHaveTextContent(
        en['agentActivity.operator.none']
      );
    });
  });

  it('draws nothing at all inside a card with no steps', async () => {
    global.fetch = answer([]) as unknown as typeof fetch;

    const { container } = mount(
      <BuildActivity projectId={PROJECT_ID} jobId={JOB_ID} status="succeeded" />
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.querySelector('.fs-activity')).toBeNull();
    expect(
      container.querySelector('[data-testid="build-activity-empty"]')
    ).toBeNull();
  });

  it('names the gate in plain words when a build was stopped', async () => {
    global.fetch = answer([
      activityRow('checking', 'gate.copy', 1),
      activityRow(
        'failed',
        'gate.copy',
        4,
        'Two placeholder sentinels are still in src/components/Hero.astro'
      ),
    ]) as unknown as typeof fetch;

    const { container } = mount(
      <BuildActivity projectId={PROJECT_ID} jobId={JOB_ID} status="failed" />
    );

    await waitFor(() => {
      expect(container.querySelector('.fs-activity')).toHaveAttribute(
        'data-status',
        'failed'
      );
    });
    // `getAllByText`: the failure line is drawn once under the header and the
    // failed step says the same words in the list.
    expect(
      screen.getAllByText('Stopped at the placeholder copy check').length
    ).toBeGreaterThan(0);
  });
});
