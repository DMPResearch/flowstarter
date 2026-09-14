import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The board's cards are the only way from the cross-project view into a
// project. After the glass migration they rendered as <div href> and stopped
// being links (caught on camera while recording the showcase clip), so this
// pins the card to a real anchor.
vi.mock('../../components/TeamDashboardShell', () => ({
  TeamDashboardShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/hooks/usePipeline', () => ({
  usePipelineBoard: () => ({
    data: {
      columns: [
        {
          state: 'INTAKE',
          stalledCount: 0,
          cards: [
            {
              workspaceId: 'ws-1',
              name: 'riverside-dental',
              businessName: 'Riverside Dental',
              clientEmail: 'owner@example.com',
              projectState: 'INTAKE',
              quoteMinor: 79900,
              currency: 'eur',
              depositStatus: 'none',
              depositPaidAt: null,
              stateSince: '2026-09-11T10:00:00.000Z',
              timeInStateMs: 120_000,
              latestJob: null,
              stalled: false,
              stallReasons: [],
              createdAt: '2026-09-11T09:00:00.000Z',
            },
          ],
        },
      ],
      total: 1,
      stalledCount: 0,
      generatedAt: '2026-09-11T10:02:00.000Z',
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    isFetching: false,
  }),
}));

// The custom work lane is a second, independent query on this page (see
// `useCustomWorkLane`). It is not what this test is about, and its own
// rendering is covered in `custom-work-lane.test.tsx`.
vi.mock('@/hooks/useCustomWorkLane', () => ({
  useCustomWorkLane: () => ({ data: { cards: [], total: 0, waitingCount: 0 } }),
  useMarkCustomWorkContacted: () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
}));

import en from '@/locales/en';
import { I18nProvider } from '@/lib/i18n';
import PipelineBoardPage from '../page';

describe('pipeline board cards', () => {
  it('renders each project card as a link to the project page', () => {
    render(
      <I18nProvider initialMessages={{ en }}>
        <PipelineBoardPage />
      </I18nProvider>
    );
    const link = screen.getByRole('link', { name: /Riverside Dental/ });
    expect(link).toHaveAttribute('href', '/admin/dashboard/projects/ws-1');
    expect(link.tagName).toBe('A');
  });
});
