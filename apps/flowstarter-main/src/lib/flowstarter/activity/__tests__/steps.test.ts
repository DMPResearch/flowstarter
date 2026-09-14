/**
 * The phrasing half of the activity timeline: tokens in, sentences out.
 *
 * The collapse rule itself is tested in `packages/agentic-codegen`. What is
 * tested here is the thing that only this app can get wrong -- a token the
 * pipeline can emit for which the dictionary has no row, which would put
 * `agentActivity.subject.section.stats` on a client's dashboard.
 */
import {
  ACTIVITY_SUBJECTS,
  AGENT_ACTIVITY_KINDS,
  type AgentActivityEvent,
} from '@flowstarter/agentic-codegen/src/flowstarter/activity';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en';
import {
  activityCopyKeys,
  activityFailureLine,
  activitySteps,
  activitySummaryLine,
  activityTranslate,
  type ActivityTranslate,
} from '../steps';

/** The real dictionary, with the same `{placeholder}` substitution `t` does. */
const t: ActivityTranslate = (key, vars) => {
  let template: string = (en as Record<string, string>)[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) {
    template = template.replace(
      new RegExp(`\\{${name}\\}`, 'g'),
      String(value)
    );
  }
  return template;
};

function event(
  partial: Partial<AgentActivityEvent> & Pick<AgentActivityEvent, 'kind'>
): AgentActivityEvent {
  return {
    at: '2026-09-14T10:00:00.000Z',
    phase: 'Agents expanding the site',
    subject: 'site',
    ...partial,
  };
}

describe('the dictionary', () => {
  it('has a row for every kind and every subject the pipeline can emit', () => {
    const missing = activityCopyKeys().filter(
      (key) => !(key in (en as Record<string, string>))
    );
    expect(missing).toEqual([]);
  });

  it('covers the closed sets rather than a hand-written list', () => {
    const keys = activityCopyKeys();
    for (const kind of AGENT_ACTIVITY_KINDS) {
      expect(keys).toContain(`agentActivity.step.${kind}.active`);
    }
    for (const subject of ACTIVITY_SUBJECTS) {
      expect(keys).toContain(`agentActivity.subject.${subject}`);
    }
  });

  it('says nothing with an em dash or an emoji', () => {
    for (const key of activityCopyKeys()) {
      const value = (en as Record<string, string>)[key] ?? '';
      expect(value).not.toMatch(/—/);
      // The surrogate range rather than a unicode property escape: the test
      // tsconfig does not target a version that has the latter.
      expect(value).not.toMatch(/[\uD800-\uDBFF][\uDC00-\uDFFF]/);
      // The arrows-and-dingbats block, and the variation selector that turns
      // a plain glyph into an emoji. Checked separately because a character
      // class holding both is a combined character ESLint refuses.
      expect(value).not.toMatch(/[←-➿]/);
      expect(value).not.toMatch(/️/);
    }
  });
});

describe('activitySteps', () => {
  it('phrases a live step in the present and a finished one in the past', () => {
    const steps = activitySteps(
      [
        event({ kind: 'editing', subject: 'section.services' }),
        event({
          kind: 'checking',
          subject: 'gate.copy',
          at: '2026-09-14T10:05:00.000Z',
        }),
      ],
      t
    );
    expect(steps[0]?.label).toBe('Edited the services section');
    expect(steps[1]?.label).toBe('Checking the placeholder copy check');
    expect(steps[1]?.state).toBe('active');
  });

  it('shows a collapsed burst as a count rather than describing it', () => {
    const steps = activitySteps(
      [
        event({ kind: 'reading', subject: 'section.services' }),
        event({
          kind: 'reading',
          subject: 'section.services',
          at: '2026-09-14T10:00:01.000Z',
        }),
        event({
          kind: 'reading',
          subject: 'section.services',
          at: '2026-09-14T10:00:02.000Z',
        }),
        event({ kind: 'done', at: '2026-09-14T10:00:03.000Z' }),
      ],
      t
    );
    expect(steps[0]?.label).toBe('Read the services section (3)');
  });

  it('keeps the file path from a client and gives it to an operator', () => {
    const events = [
      event({
        kind: 'reading',
        subject: 'section.hero',
        detail: 'src/components/Hero.astro',
      }),
    ];
    expect(activitySteps(events, t)[0]?.detail).toBeUndefined();
    expect(activitySteps(events, t, { detail: true })[0]?.detail).toBe(
      'src/components/Hero.astro'
    );
  });

  it('carries the search chips through to the step', () => {
    const steps = activitySteps(
      [
        event({
          kind: 'searching',
          subject: 'template.library',
          chips: ['plumber local trade'],
        }),
      ],
      t
    );
    expect(steps[0]?.chips).toEqual(['plumber local trade']);
    expect(steps[0]?.label).toBe('Searching the template library');
  });

  it('returns no steps for no events, and invents nothing', () => {
    expect(activitySteps([], t)).toEqual([]);
  });
});

describe('activitySummaryLine', () => {
  it('says the counts and nothing else', () => {
    const line = activitySummaryLine(
      [
        event({ kind: 'building', subject: 'page.home' }),
        event({ kind: 'building', subject: 'page.about' }),
        event({ kind: 'building', subject: 'page.services' }),
        event({ kind: 'building', subject: 'page.contact' }),
        event({ kind: 'checking', subject: 'gate.copy' }),
        event({ kind: 'checking', subject: 'gate.images' }),
        event({ kind: 'checking', subject: 'gate.markup' }),
        event({ kind: 'checking', subject: 'gate.build' }),
        event({ kind: 'checking', subject: 'gate.pages' }),
        event({ kind: 'checking', subject: 'gate.brief' }),
        event({ kind: 'repairing', subject: 'gate.copy' }),
        event({ kind: 'repairing', subject: 'gate.images' }),
      ],
      t
    );
    expect(line).toBe('Built 4 pages, checked 6 rules, 2 repairs');
  });

  it('says one of a thing in the singular', () => {
    expect(
      activitySummaryLine(
        [
          event({ kind: 'building', subject: 'page.home' }),
          event({ kind: 'checking', subject: 'gate.copy' }),
          event({ kind: 'repairing', subject: 'gate.copy' }),
        ],
        t
      )
    ).toBe('Built 1 page, checked 1 rule, 1 repair');
  });

  it('leaves a count of zero out rather than boasting about it', () => {
    expect(
      activitySummaryLine(
        [event({ kind: 'checking', subject: 'gate.copy' })],
        t
      )
    ).toBe('checked 1 rule');
  });

  it('falls back to a plain word when there is nothing to count', () => {
    expect(activitySummaryLine([event({ kind: 'done' })], t)).toBe('Finished');
  });
});

describe('activityFailureLine', () => {
  it('names the gate in plain words', () => {
    expect(
      activityFailureLine([event({ kind: 'failed', subject: 'gate.copy' })], t)
    ).toBe('Stopped at the placeholder copy check');
  });

  it('says nothing about a run that did not fail', () => {
    expect(activityFailureLine([event({ kind: 'done' })], t)).toBe('');
  });
});

describe('activityTranslate', () => {
  it('hands back the function it was given', () => {
    const translate = activityTranslate(t);
    expect(translate('agentActivity.subject.site')).toBe('the site');
  });
});
