/**
 * What the operator sees, and the one thing they can do about it.
 *
 * The card is the whole argument for the lane: an operator must be able to read
 * why somebody was routed away from the generator, in the visitor's own quoted
 * words, without opening anything.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import en from '@/locales/en';
import type { CustomWorkCard } from '@/hooks/useCustomWorkLane';
import { CustomWorkLane } from '../CustomWorkLane';

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

function card(overrides: Partial<CustomWorkCard> = {}): CustomWorkCard {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Sarah Smith',
    email: 'sarah@example.com',
    description: 'A portal my customers log into to track their orders',
    linkUrl: 'https://acme.example.com',
    scope: 'custom',
    confidence: 0.94,
    evidence: ['customers log into', 'track their orders'],
    classifier: 'llm:2026-09-14.1',
    route: 'discovery-call',
    routeRule: 'customAboveThreshold',
    source: 'funnel',
    bookingStatus: 'offered',
    contacted: false,
    contactedAt: null,
    contactedBy: null,
    confirmationSentAt: '2026-09-14T11:00:00.000Z',
    createdAt: '2026-09-14T11:00:00.000Z',
    waitingFor: '1h',
    needsAttention: false,
    ...overrides,
  };
}

function renderLane(cards: CustomWorkCard[], markingId: string | null = null) {
  const onMarkContacted = vi.fn();
  render(
    <CustomWorkLane
      cards={cards}
      waitingCount={cards.filter((c) => !c.contacted).length}
      onMarkContacted={onMarkContacted}
      markingId={markingId}
      t={t}
    />
  );
  return { onMarkContacted, user: userEvent.setup() };
}

describe('the custom work lane', () => {
  it('is titled for what it holds', () => {
    renderLane([card()]);
    expect(
      screen.getByText(t('admin.customWork.lane.title'))
    ).toBeInTheDocument();
  });

  it('shows the visitor, the brief and the evidence that routed them', () => {
    renderLane([card()]);
    expect(screen.getByText('Sarah Smith')).toBeInTheDocument();
    expect(screen.getByText('sarah@example.com')).toBeInTheDocument();
    expect(
      screen.getByText('A portal my customers log into to track their orders')
    ).toBeInTheDocument();
    expect(screen.getByText('customers log into')).toBeInTheDocument();
    expect(screen.getByText('track their orders')).toBeInTheDocument();
    // The verdict and the rule, so the decision can be argued with.
    expect(screen.getByText(/llm:2026-09-14\.1/)).toHaveTextContent(
      'customAboveThreshold'
    );
  });

  it('counts the leads nobody has replied to', () => {
    renderLane([card(), card({ id: 'b', contacted: true })]);
    expect(
      screen.getByText(`1 ${t('admin.customWork.lane.waiting')}`)
    ).toBeInTheDocument();
  });

  it('offers Mark contacted, and calls back with the lead id', async () => {
    const { onMarkContacted, user } = renderLane([card()]);
    await user.click(
      screen.getByRole('button', {
        name: t('admin.customWork.card.markContacted'),
      })
    );
    expect(onMarkContacted).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111'
    );
  });

  it('replaces the action with a note once the lead has been answered', () => {
    renderLane([
      card({ contacted: true, contactedAt: '2026-09-14T11:30:00Z' }),
    ]);
    expect(
      screen.queryByRole('button', {
        name: t('admin.customWork.card.markContacted'),
      })
    ).toBeNull();
    expect(
      screen.getByText(t('admin.customWork.card.contacted'))
    ).toBeInTheDocument();
  });

  it('disables the action while it is saving', () => {
    renderLane([card()], '11111111-1111-4111-8111-111111111111');
    expect(
      screen.getByRole('button', { name: t('admin.customWork.card.marking') })
    ).toBeDisabled();
  });

  it('says when the branded confirmation never reached the visitor', () => {
    renderLane([card({ confirmationSentAt: null })]);
    expect(
      screen.getByText(t('admin.customWork.card.noConfirmation'))
    ).toBeInTheDocument();
    // And says nothing at all when it did.
    screen.getByText(t('admin.customWork.card.markContacted'));
  });

  it('marks a lead that came through the contact form', () => {
    renderLane([card({ source: 'contact_form' })]);
    expect(
      screen.getByText(t('admin.customWork.card.viaForm'))
    ).toBeInTheDocument();
  });

  it('says so plainly when there is nothing in it', () => {
    renderLane([]);
    expect(
      screen.getByText(t('admin.customWork.lane.empty'))
    ).toBeInTheDocument();
  });
});
