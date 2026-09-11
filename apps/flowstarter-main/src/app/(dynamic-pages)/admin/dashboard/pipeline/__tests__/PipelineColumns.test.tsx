import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import type { PipelineCard as PipelineCardData } from '@/hooks/usePipeline';
import { PipelineCard } from '../PipelineColumns';

/**
 * A long business name ("Riverside Veterinary Clinic") is exactly the case
 * that broke: `truncate` clips a title to one line with an ellipsis no
 * matter how wide the column actually is. The fix is a two-line clamp that
 * still reads the full name, just wrapped — this pins that choice so it
 * cannot regress back to `truncate`.
 */
const longNameCard: PipelineCardData = {
  workspaceId: 'ws-long-name',
  name: 'riverside-vets',
  businessName: 'Riverside Veterinary Clinic',
  clientEmail: 'tom@riversidevets.example.com',
  projectState: ProjectState.HUMAN_QA,
  quoteMinor: 89900,
  currency: 'eur',
  depositStatus: 'paid',
  depositPaidAt: '2026-08-30T10:00:00.000Z',
  stateSince: '2026-09-11T08:00:00.000Z',
  timeInStateMs: 3_600_000,
  latestJob: null,
  stalled: false,
  stallReasons: [],
  createdAt: '2026-08-25T09:00:00.000Z',
};

describe('PipelineCard title', () => {
  it('reads the full business name, not clipped to an ellipsis', () => {
    render(<PipelineCard card={longNameCard} />);
    expect(screen.getByText('Riverside Veterinary Clinic')).toBeInTheDocument();
  });

  it('clamps to two lines instead of truncating to one', () => {
    render(<PipelineCard card={longNameCard} />);
    const title = screen.getByText('Riverside Veterinary Clinic');
    expect(title.className).not.toMatch(/\btruncate\b/);
    expect(title.className).toMatch(/\bline-clamp-2\b/);
  });
});
