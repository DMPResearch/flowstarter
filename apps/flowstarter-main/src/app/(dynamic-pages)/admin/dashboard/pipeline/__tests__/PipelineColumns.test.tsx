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

function job(id: string, status: string): PipelineCardData['latestJob'] {
  return {
    id,
    kind: 'FULL_SITE_BUILD',
    status,
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: '2026-09-11T08:00:00.000Z',
    startedAt: '2026-09-11T08:01:00.000Z',
    finishedAt: null,
    errorCode: status === 'failed' ? 'FULL_SITE_BUILD_FAILED' : null,
    ageMs: 600_000,
  };
}

/** Everything normal about a project, all at once: paid, quoted, finished. */
const healthyCard: PipelineCardData = {
  ...longNameCard,
  workspaceId: 'ws-healthy',
  latestJob: job('job-1', 'succeeded'),
};

const failedCard: PipelineCardData = {
  ...longNameCard,
  workspaceId: 'ws-failed',
  stalled: true,
  stallReasons: ['The site build failed 3 times in a row.'],
  latestJob: job('job-2', 'failed'),
};

/**
 * Every tone the card paints with, from both places a tone can be written:
 * an inline style and a Tailwind arbitrary value.
 *
 * Read off the raw attributes, not `element.style`: jsdom's CSSOM drops any
 * declaration whose value it cannot parse, and `var()` inside `background`,
 * `color` or the `border-left` shorthand is exactly that — they all read back
 * as `''`, which would let a wrongly-painted card pass.
 */
function paintedTones(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('*'))
    .flatMap((node) => [
      node.getAttribute('style') ?? '',
      node.getAttribute('class') ?? '',
    ])
    .flatMap((value) =>
      Array.from(value.matchAll(/--fs-tone-([a-z]+)/g)).map((match) => match[1])
    );
}

/**
 * A column of cards each wearing a green "Deposit paid" and a green
 * "Finished" is a wall of green flagging the normal case, which is how the
 * board came to have a colour on every card and no colour that meant
 * anything. These pin the rule: neutral unless something is wrong, and then
 * one colour, `danger`, in one place.
 */
describe('PipelineCard colour', () => {
  it('paints nothing but neutral when the project is healthy', () => {
    const { container } = render(<PipelineCard card={healthyCard} />);
    expect(new Set(paintedTones(container))).toEqual(new Set(['neutral']));
  });

  it('spends its one colour on the failure, and nowhere else', () => {
    const { container } = render(<PipelineCard card={failedCard} />);
    expect(new Set(paintedTones(container))).toEqual(
      new Set(['neutral', 'danger'])
    );
  });

  it('gives the stall reasons a neutral fill with a danger rule, not a danger fill', () => {
    render(<PipelineCard card={failedCard} />);
    const reasons = screen
      .getByText('The site build failed 3 times in a row.')
      .closest('ul');

    expect(reasons).not.toBeNull();
    expect(reasons!.className).toContain('bg-[var(--fs-tone-neutral-soft)]');
    expect(reasons!.className).toContain(
      'border-l-2 border-l-[var(--fs-tone-danger)]'
    );
    expect(reasons!.className).not.toContain('--fs-tone-danger-soft');
  });
});

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
