/**
 * The stepper above the discovery conversation.
 *
 * It replaces the `{ done: 0, total: 1 }` placeholder the graph conversation
 * used to seed its own progress bar with: every stage is visible from the
 * first frame, and the questions-answered count is computed from the script
 * itself, never a network round trip.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en';
import { DiscoveryStepper } from '../DiscoveryStepper';
import {
  DEPOSIT_STEP,
  EMPTY_DISCOVERY,
  PREVIEW_STEP,
  STEPS,
  type Step,
} from '../discovery.logic';
import { conversationProgress } from '../intake-script';

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

describe('DiscoveryStepper', () => {
  it('renders all 6 stages in order with their labels', () => {
    render(
      <DiscoveryStepper
        steps={STEPS}
        current={1}
        data={EMPTY_DISCOVERY}
        answered={[]}
        t={t}
      />
    );

    const nav = screen.getByTestId('discovery-stepper');
    const items = within(nav).getAllByRole('listitem');
    expect(items).toHaveLength(6);

    const expectedLabels = [
      'landing.discovery.stepper.name',
      'landing.discovery.stepper.contact',
      'landing.discovery.stepper.business',
      'landing.discovery.stepper.links',
      'landing.discovery.stepper.preview',
      'landing.discovery.stepper.deposit',
    ].map(t);
    items.forEach((item, index) => {
      expect(within(item).getByText(expectedLabels[index])).toBeInTheDocument();
    });
  });

  it('marks the first stage current and shows the correct progress on the first frame', () => {
    render(
      <DiscoveryStepper
        steps={STEPS}
        current={1}
        data={EMPTY_DISCOVERY}
        answered={[]}
        t={t}
      />
    );

    const nav = screen.getByTestId('discovery-stepper');
    const items = within(nav).getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).toHaveAttribute('data-state', 'current');

    // Never "0/1" — the total comes from the script's applicable questions.
    const { done, total } = conversationProgress(EMPTY_DISCOVERY, []);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', String(done));
    expect(bar).toHaveAttribute('aria-valuemax', String(total));
    expect(
      screen.getByText(`${done} of ${total} questions answered`)
    ).toBeInTheDocument();
  });

  it('renders earlier stages as done, with a check, once the wizard has moved on', () => {
    render(
      <DiscoveryStepper
        steps={STEPS}
        current={3 as Step}
        data={EMPTY_DISCOVERY}
        answered={[]}
        t={t}
      />
    );

    const nav = screen.getByTestId('discovery-stepper');
    const items = within(nav).getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('data-state', 'done');
    expect(items[1]).toHaveAttribute('data-state', 'done');
    expect(items[2]).toHaveAttribute('data-state', 'current');
    expect(items[2]).toHaveAttribute('aria-current', 'step');
    expect(items[3]).toHaveAttribute('data-state', 'upcoming');
  });

  it(
    'reads the same denominator as the questions-answered line while the ' +
      "scripted conversation runs, instead of the wizard's own 6 stages " +
      '(readiness review: "Step 1 of 6" next to a four-question line)',
    () => {
      render(
        <DiscoveryStepper
          steps={STEPS}
          current={1}
          data={EMPTY_DISCOVERY}
          answered={[]}
          t={t}
        />
      );

      // The bug this pins is the mismatch, not a particular number. The
      // denominator has to be whatever `conversationProgress` says, because
      // that is what the questions-answered line beside it says, and a visitor
      // reading two different totals about the same conversation is the defect
      // the readiness review found.
      //
      // Deliberately derived rather than hardcoded. The count moved from four
      // to five when the optional connect-a-photo offer joined the quick
      // phase, and a literal here would have failed for a change that is not a
      // regression. The number that must not move is how many questions a
      // visitor MUST answer, which is still four and is pinned by
      // `quickRequiredCount` in intake-friction.test.ts.
      const { total } = conversationProgress(EMPTY_DISCOVERY, []);
      expect(total).toBeGreaterThan(0);
      expect(STEPS.length).not.toBe(total);

      expect(
        screen.getByText(`Step 1 of ${total}: Your name`)
      ).toBeInTheDocument();
      expect(screen.queryByText(`Step 1 of ${STEPS.length}`)).toBeNull();
    }
  );

  it.each([PREVIEW_STEP, DEPOSIT_STEP])(
    'hides the progress bar once the wizard is at step %i, past the scripted conversation, but keeps the stepper',
    (current) => {
      render(
        <DiscoveryStepper
          steps={STEPS}
          current={current as Step}
          data={EMPTY_DISCOVERY}
          answered={[]}
          t={t}
        />
      );
      expect(screen.getByTestId('discovery-stepper')).toBeInTheDocument();
      expect(screen.queryByRole('progressbar')).toBeNull();
    }
  );
});
