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

import PipelineBoardPage from '../page';

describe('pipeline board cards', () => {
  it('renders each project card as a link to the project page', () => {
    render(<PipelineBoardPage />);
    const link = screen.getByRole('link', { name: /Riverside Dental/ });
    expect(link).toHaveAttribute('href', '/admin/dashboard/projects/ws-1');
    expect(link.tagName).toBe('A');
  });
});
