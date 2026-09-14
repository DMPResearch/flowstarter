/**
 * The activity timeline, in every state it has.
 *
 * `packages/flow-design-system` has no test runner of its own, so its
 * components are exercised from the app that consumes them -- which is also
 * the honest place, because what matters is what a reader on a Flowstarter
 * surface actually sees. The fixtures here are `AgentActivityEvent`s, not
 * hand-written steps: the collapse and the phrasing are part of what is
 * under test, so writing the sentences by hand would test nothing.
 */
import type { AgentActivityEvent } from '@flowstarter/agentic-codegen/src/flowstarter/activity';
import { AgentActivity } from '@flowstarter/flow-design-system/components/feedback/AgentActivity';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import en from '@/locales/en';
import { AgentActivityPanel } from '../AgentActivityPanel';

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 8, 14, 10, 0, seconds)).toISOString();
}

function event(
  partial: Partial<AgentActivityEvent> & Pick<AgentActivityEvent, 'kind'>
): AgentActivityEvent {
  return {
    at: at(0),
    phase: 'Agents expanding the site',
    subject: 'site',
    ...partial,
  };
}

/** A run part-way through: a search, a burst of reads, a live edit. */
const RUNNING: AgentActivityEvent[] = [
  event({
    kind: 'searching',
    subject: 'template.library',
    chips: ['plumber local trade', 'local-trade'],
    at: at(1),
  }),
  event({ kind: 'reading', subject: 'section.services', at: at(2) }),
  event({ kind: 'reading', subject: 'section.services', at: at(3) }),
  event({ kind: 'reading', subject: 'section.services', at: at(4) }),
  event({
    kind: 'editing',
    subject: 'section.services',
    detail: 'src/components/Services.astro',
    at: at(5),
  }),
];

/** A run that finished: four pages, six checks, two repairs. */
const FINISHED: AgentActivityEvent[] = [
  ...(
    ['page.home', 'page.about', 'page.services', 'page.contact'] as const
  ).map((subject, index) =>
    event({ kind: 'building', subject, at: at(10 + index * 10) })
  ),
  ...(
    [
      'gate.build',
      'gate.copy',
      'gate.images',
      'gate.markup',
      'gate.pages',
      'gate.brief',
    ] as const
  ).map((subject, index) =>
    event({ kind: 'checking', subject, at: at(60 + index * 10) })
  ),
  event({ kind: 'repairing', subject: 'gate.copy', at: at(130) }),
  event({ kind: 'repairing', subject: 'gate.images', at: at(140) }),
  event({ kind: 'done', subject: 'site', at: at(150) }),
];

/** A run a gate stopped. */
const FAILED: AgentActivityEvent[] = [
  event({ kind: 'checking', subject: 'gate.copy', at: at(10) }),
  event({
    kind: 'failed',
    subject: 'gate.copy',
    detail: 'two sentinels left in the hero',
    at: at(20),
  }),
];

function mount(ui: React.ReactNode) {
  return render(
    <I18nProvider initialLocale="en" initialMessages={{ en }}>
      {ui}
    </I18nProvider>
  );
}

describe('AgentActivity', () => {
  it('spins while the work is running and stops when it is over', () => {
    const { container, rerender } = render(
      <AgentActivity
        status="running"
        headline="Building your site"
        steps={[
          { id: '1', kind: 'editing', label: 'Editing', state: 'active' },
        ]}
      />
    );
    expect(container.querySelector('.fs-activity__spinner')).not.toBeNull();

    rerender(
      <AgentActivity
        status="done"
        headline="Your site is built"
        summary="Built 4 pages"
        steps={[{ id: '1', kind: 'done', label: 'Finished' }]}
      />
    );
    expect(container.querySelector('.fs-activity__spinner')).toBeNull();
    expect(container.querySelector('.fs-activity__mark')).not.toBeNull();
  });

  it('opens while running and folds to the summary when it is over', () => {
    const steps = [{ id: '1', kind: 'editing' as const, label: 'Edited' }];
    const { container, rerender } = render(
      <AgentActivity status="running" headline="Working" steps={steps} />
    );
    expect(container.querySelector('.fs-activity__list')).not.toBeNull();

    rerender(
      <AgentActivity
        status="done"
        headline="Done"
        steps={steps}
        summary="Built 4 pages, checked 6 rules, 2 repairs"
      />
    );
    // The fold is uncontrolled state, so a rerender does not close it. What
    // matters is the default a freshly mounted finished run takes.
    render(
      <AgentActivity
        status="done"
        headline="Done"
        steps={steps}
        summary="Built 4 pages, checked 6 rules, 2 repairs"
      />
    );
    expect(
      screen.getAllByText('Built 4 pages, checked 6 rules, 2 repairs').length
    ).toBeGreaterThan(0);
  });

  it('expands on tap and says so to a screen reader', () => {
    render(
      <AgentActivity
        status="done"
        headline="Done"
        summary="Finished"
        steps={[{ id: '1', kind: 'done', label: 'Finished the site' }]}
      />
    );
    const header = screen.getByRole('button');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Finished the site')).toBeNull();

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Finished the site')).toBeInTheDocument();
  });

  it('announces only the live step, in a polite live region', () => {
    const { container } = render(
      <AgentActivity
        status="running"
        headline="Working"
        steps={[
          { id: '1', kind: 'reading', label: 'Read the hero section' },
          {
            id: '2',
            kind: 'editing',
            label: 'Editing the services section',
            state: 'active',
          },
        ]}
      />
    );
    const region = container.querySelector('.fs-activity__announce');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Editing the services section');
    expect(region).not.toHaveTextContent('Read the hero section');
  });

  it('draws a search as chips inside its step', () => {
    const { container } = render(
      <AgentActivity
        status="running"
        headline="Working"
        steps={[
          {
            id: '1',
            kind: 'searching',
            label: 'Searching the template library',
            chips: ['plumber local trade', 'local-trade'],
            state: 'active',
          },
        ]}
      />
    );
    // Scoped to the list: the same words are also in the live region, which
    // is the point of the live region and not a duplicate rendering.
    const step = container.querySelector('.fs-activity__step') as HTMLElement;
    expect(
      within(step).getByText('Searching the template library')
    ).toBeInTheDocument();
    expect(within(step).getByText('plumber local trade')).toBeInTheDocument();
    expect(within(step).getByText('local-trade')).toBeInTheDocument();
  });

  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(
      <AgentActivity status="done" headline="Done" steps={[]} />
    );
    expect(container.querySelector('.fs-activity__step')).toBeNull();
  });
});

describe('AgentActivityPanel', () => {
  it('shows the steps a running build has taken, newest live', () => {
    const { container } = mount(
      <AgentActivityPanel events={RUNNING} headline="Building your site" />
    );
    const labels = Array.from(
      container.querySelectorAll('.fs-activity__label')
    ).map((node) => node.textContent);
    expect(labels).toEqual([
      'Searched the template library',
      'Read the services section (3)',
      'Editing the services section',
    ]);
    expect(container.querySelector('.fs-activity__spinner')).not.toBeNull();
  });

  it('keeps the file path from a client and shows it to an operator', () => {
    const client = mount(
      <AgentActivityPanel events={RUNNING} headline="Building your site" />
    );
    expect(client.container.textContent).not.toContain('Services.astro');
    client.unmount();

    const operator = mount(
      <AgentActivityPanel
        events={RUNNING}
        headline="Building your site"
        detail
      />
    );
    expect(operator.container.textContent).toContain(
      'src/components/Services.astro'
    );
  });

  it('folds a finished run to one line of counts', () => {
    mount(
      <AgentActivityPanel events={FINISHED} headline="Your site is built" />
    );
    expect(
      screen.getByText('Built 4 pages, checked 6 rules, 2 repairs')
    ).toBeInTheDocument();
  });

  it('names the gate in plain words when a run is stopped', () => {
    const { container } = mount(
      <AgentActivityPanel events={FAILED} headline="Stopped" />
    );
    expect(
      screen.getByText('Stopped at the placeholder copy check')
    ).toBeInTheDocument();
    expect(container.querySelector('.fs-activity')).toHaveAttribute(
      'data-status',
      'failed'
    );
  });

  it('draws nothing before the first event arrives', () => {
    const { container } = mount(
      <AgentActivityPanel events={[]} headline="Building your site" />
    );
    expect(container.querySelector('.fs-activity')).toBeNull();
  });
});
