/**
 * The two-pane intake stage.
 *
 * On a phone there is no room for the conversation and the preview at once,
 * so the preview collapses to a status strip. The behaviour worth protecting
 * is that the strip is a real control -- it toggles, it says whether it is
 * open, and it can be worked from the keyboard -- rather than a decoration
 * with a tap handler on it. The desktop split is CSS, so it is not asserted
 * here; jsdom has no layout.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { IntakeStage } from '../steps/IntakeStage';

/**
 * Echoes keys, except the one line whose interpolation is under test: a key
 * with no placeholders in it cannot show whether the count was substituted.
 */
const t = (key: string) =>
  key === 'landing.discovery.preview.pane.stripCount'
    ? '{done} of {total} details in'
    : key;

function renderStage(answeredCount = 2) {
  return render(
    <IntakeStage
      answeredCount={answeredCount}
      factTotal={4}
      t={t}
      conversation={<p>the conversation</p>}
      preview={<p>the preview</p>}
    />
  );
}

describe('IntakeStage', () => {
  it('renders both panes', () => {
    renderStage();
    expect(screen.getByText('the conversation')).toBeInTheDocument();
    expect(screen.getByText('the preview')).toBeInTheDocument();
  });

  it('starts with the mobile strip closed', () => {
    renderStage();
    const strip = screen.getByTestId('preview-strip-toggle');
    expect(strip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('intake-preview-region').dataset.open).toBe('no');
  });

  it('opens the preview when the strip is tapped, and closes it again', async () => {
    renderStage();
    const strip = screen.getByTestId('preview-strip-toggle');
    const region = screen.getByTestId('intake-preview-region');

    await userEvent.click(strip);
    expect(strip).toHaveAttribute('aria-expanded', 'true');
    expect(region.dataset.open).toBe('yes');

    await userEvent.click(strip);
    expect(strip).toHaveAttribute('aria-expanded', 'false');
    expect(region.dataset.open).toBe('no');
  });

  it('toggles from the keyboard too', async () => {
    renderStage();
    const strip = screen.getByTestId('preview-strip-toggle');
    strip.focus();
    await userEvent.keyboard('{Enter}');
    expect(strip).toHaveAttribute('aria-expanded', 'true');
  });

  it('names the region it controls, so the state is announced', () => {
    renderStage();
    expect(screen.getByTestId('preview-strip-toggle')).toHaveAttribute(
      'aria-controls',
      'intake-preview-region'
    );
    expect(screen.getByTestId('intake-preview-region')).toHaveAttribute(
      'id',
      'intake-preview-region'
    );
  });

  it('counts the answers on the strip', () => {
    renderStage(3);
    // The catalogue is stubbed to echo keys, so the interpolation is what is
    // being checked, not the wording.
    expect(screen.getByTestId('preview-strip-toggle')).toHaveTextContent(
      '3 of 4'
    );
  });
});
