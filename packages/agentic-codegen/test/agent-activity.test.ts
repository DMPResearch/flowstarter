/**
 * The rules behind the activity timeline: what a path is called, what a phase
 * means, what a burst collapses to, and what a run may never say.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_SUBJECTS,
  ActivityRecorder,
  activityForPhase,
  activityForToolCall,
  activityStatus,
  assertSafeEvent,
  collapseActivity,
  isAgentActivityEvent,
  looksLikeSecret,
  parseActivityEvents,
  projectForClient,
  subjectForFailureCode,
  subjectForPath,
  subjectsForPaths,
  summariseActivity,
  UnsafeActivityEventError,
  type AgentActivityEvent,
} from '../src/index';

function event(
  partial: Partial<AgentActivityEvent> & Pick<AgentActivityEvent, 'kind'>,
): AgentActivityEvent {
  return {
    at: '2026-09-14T10:00:00.000Z',
    phase: 'Agents expanding the site',
    subject: 'site',
    ...partial,
  };
}

/**
 * Credential-shaped strings, minted here rather than written down.
 *
 * The rule under test refuses anything that looks like a secret, so testing it
 * needs something that looks like one -- and a quoted literal shaped like an
 * API key is a literal every secret scanner in the pipeline has to treat as a
 * real one. GitGuardian did exactly that on the first push of this branch. So
 * the prefix and the body are joined at run time from random bytes: the value
 * matches the pattern, and no commit in the history carries a string a scanner
 * can mistake for a leak.
 */
function mintedKey(): string {
  return ['sk', randomBytes(12).toString('hex')].join('-');
}

function mintedAssignment(name: string, separator: string): string {
  return `${name}${separator}${randomBytes(10).toString('hex')}`;
}

describe('subjectForPath', () => {
  it('names the pages of a generated site', () => {
    expect(subjectForPath('src/pages/index.astro')).toBe('page.home');
    expect(subjectForPath('src/pages/about.astro')).toBe('page.about');
    expect(subjectForPath('src/pages/services.astro')).toBe('page.services');
    expect(subjectForPath('src/pages/contact.astro')).toBe('page.contact');
    expect(subjectForPath('src/pages/book.astro')).toBe('page.booking');
    expect(subjectForPath('src/pages/work.astro')).toBe('page.work');
    expect(subjectForPath('src/pages/blog.astro')).toBe('page.blog');
    expect(subjectForPath('src/pages/privacy.astro')).toBe('page.legal');
  });

  it('names a dynamic route after the folder that holds it', () => {
    expect(subjectForPath('src/pages/case-studies/[slug].astro')).toBe(
      'page.work',
    );
  });

  it('falls back to the generic page for a route it does not know', () => {
    expect(subjectForPath('src/pages/franchise-enquiries.astro')).toBe(
      'page.other',
    );
  });

  it('names the sections of a page', () => {
    expect(subjectForPath('src/components/Hero.astro')).toBe('section.hero');
    expect(subjectForPath('src/components/Services.astro')).toBe(
      'section.services',
    );
    expect(subjectForPath('src/components/CaseStudies.astro')).toBe(
      'section.work',
    );
    expect(subjectForPath('src/components/Testimonial.astro')).toBe(
      'section.testimonials',
    );
    expect(subjectForPath('src/components/CTASection.astro')).toBe(
      'section.cta',
    );
    expect(subjectForPath('src/components/Footer.astro')).toBe(
      'section.footer',
    );
    expect(subjectForPath('src/components/FollowBar.astro')).toBe(
      'section.header',
    );
    expect(subjectForPath('src/components/Stats.astro')).toBe('section.stats');
  });

  it('lets the folder name a component nested under a section', () => {
    expect(
      subjectForPath('src/components/contact/ContactFormPanel.astro'),
    ).toBe('section.contact');
    // `form/` is not a section anyone names, and a phone field is not
    // self-evidently the contact block, so the rule declines rather than
    // deciding it probably is.
    expect(subjectForPath('src/components/form/PhoneField.astro')).toBe(
      'section.other',
    );
  });

  it('names the site-wide things a build touches', () => {
    expect(subjectForPath('src/content/site-labels.md')).toBe('content.site');
    expect(subjectForPath('src/lib/site-data.ts')).toBe('content.site');
    expect(subjectForPath('src/styles/global.css')).toBe('style.site');
    expect(subjectForPath('src/layouts/Layout.astro')).toBe('section.header');
    expect(subjectForPath('public/images/hero.webp')).toBe('image.site');
    expect(subjectForPath('astro.config.mjs')).toBe('setup.site');
    expect(subjectForPath('src/scripts/site.js')).toBe('setup.site');
  });

  it('declines to name what it cannot place', () => {
    expect(subjectForPath('')).toBe('file.other');
    expect(subjectForPath('README.md')).toBe('file.other');
  });

  it('is case and separator insensitive', () => {
    expect(subjectForPath('SRC\\Pages\\Index.astro')).toBe('page.home');
    expect(subjectForPath('./src/components/hero.astro')).toBe('section.hero');
  });

  it('only produces subjects the event model allows', () => {
    const known = new Set<string>(ACTIVITY_SUBJECTS);
    const paths = [
      'src/pages/index.astro',
      'src/components/Expertise.astro',
      'src/styles/global.css',
      'public/logo.svg',
      'anything/else.txt',
    ];
    for (const path of paths)
      expect(known.has(subjectForPath(path))).toBe(true);
  });

  it('keeps order and drops duplicates across a list of paths', () => {
    expect(
      subjectsForPaths([
        'src/pages/index.astro',
        'src/components/Hero.astro',
        'src/pages/index.astro',
      ]),
    ).toEqual(['page.home', 'section.hero']);
  });
});

describe('subjectForFailureCode', () => {
  it('names the gate behind a build failure code', () => {
    expect(subjectForFailureCode('PLACEHOLDER_COPY_SHIPPED')).toBe('gate.copy');
    expect(subjectForFailureCode('GENERATED_HTML_UNSAFE')).toBe('gate.markup');
    expect(subjectForFailureCode('PAGE_BUDGET_EXCEEDED')).toBe('gate.pages');
    expect(subjectForFailureCode('APPROVED_EDIT_DROPPED')).toBe('gate.changes');
  });

  it('does not invent a gate for a code it has never seen', () => {
    expect(subjectForFailureCode('SOME_NEW_CODE')).toBe('gate.other');
  });
});

describe('activityForPhase', () => {
  it('reads the phases the pipeline already says', () => {
    expect(activityForPhase('Checking for placeholder copy')).toEqual({
      kind: 'checking',
      subject: 'gate.copy',
    });
    expect(activityForPhase('Publishing your live preview')).toEqual({
      kind: 'publishing',
      subject: 'preview',
    });
    expect(activityForPhase('Handed to human QA')).toEqual({
      kind: 'done',
      subject: 'site',
    });
  });

  it('matches a templated phase on its prefix', () => {
    expect(activityForPhase('Live, in version 7').kind).toBe('done');
    expect(activityForPhase('Applying 2 notes from the team').kind).toBe(
      'editing',
    );
    expect(activityForPhase('Materializing the site the client has').kind).toBe(
      'building',
    );
  });

  it('falls back to the first word, the way the board does', () => {
    expect(activityForPhase('Removing the winter banner').kind).toBe(
      'repairing',
    );
    expect(activityForPhase('Committing everything').kind).toBe('publishing');
  });

  it('says the least it can rather than guessing', () => {
    expect(activityForPhase('Blorping the flange')).toEqual({
      kind: 'thinking',
      subject: 'site',
    });
  });
});

describe('activityForToolCall', () => {
  it('maps the file tools to steps and keeps the path', () => {
    expect(
      activityForToolCall('read_file', { path: 'src/pages/index.astro' }),
    ).toEqual({ kind: 'reading', path: 'src/pages/index.astro' });
    expect(
      activityForToolCall('edit_file', {
        path: 'src/components/Hero.astro',
        oldText: 'a',
        newText: 'b',
      }),
    ).toEqual({ kind: 'editing', path: 'src/components/Hero.astro' });
  });

  it('turns a library lookup into a chip', () => {
    expect(
      activityForToolCall('search_flowstarter_templates', {
        query: 'plumber local trade',
      }),
    ).toEqual({ kind: 'searching', chip: 'plumber local trade' });
    expect(
      activityForToolCall('get_flowstarter_template_details', {
        slug: 'local-trade',
      }),
    ).toEqual({ kind: 'searching', chip: 'local-trade' });
  });

  it('narrates nothing for a tool it does not know', () => {
    expect(activityForToolCall('run_shell', { cmd: 'rm -rf /' })).toBeNull();
  });

  it('never reads an argument that is the model text', () => {
    const match = activityForToolCall('write_file', {
      path: 'src/pages/index.astro',
      content: 'SECRET PROSE THE MODEL WROTE',
    });
    expect(JSON.stringify(match)).not.toContain('SECRET PROSE');
  });
});

describe('collapseActivity', () => {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 8, 14, 10, 0, seconds)).toISOString();

  it('turns many reads of one file into one step with a count', () => {
    const events = [0, 1, 2, 3, 4].map((second) =>
      event({ kind: 'reading', subject: 'section.services', at: at(second) }),
    );
    const steps = collapseActivity(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.count).toBe(5);
    expect(steps[0]?.endedAt).toBe(at(4));
  });

  it('turns a run of edits to one section into one step', () => {
    const steps = collapseActivity([
      event({ kind: 'editing', subject: 'section.services', at: at(0) }),
      event({ kind: 'editing', subject: 'section.services', at: at(1) }),
      event({ kind: 'editing', subject: 'section.services', at: at(2) }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: 'editing',
      subject: 'section.services',
      count: 3,
    });
  });

  it('keeps different work apart', () => {
    const steps = collapseActivity([
      event({ kind: 'reading', subject: 'section.hero', at: at(0) }),
      event({ kind: 'editing', subject: 'section.hero', at: at(1) }),
      event({ kind: 'reading', subject: 'section.hero', at: at(2) }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.count).toBe(2);
    expect(steps[1]?.kind).toBe('editing');
  });

  it('folds interleaved work back into the step it belongs to', () => {
    const steps = collapseActivity([
      event({ kind: 'reading', subject: 'section.hero', at: at(0) }),
      event({ kind: 'reading', subject: 'section.footer', at: at(1) }),
      event({ kind: 'reading', subject: 'section.hero', at: at(2) }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.count).toBe(2);
  });

  it('does not merge across a long pause', () => {
    const steps = collapseActivity(
      [
        event({ kind: 'reading', subject: 'section.hero', at: at(0) }),
        event({ kind: 'reading', subject: 'section.hero', at: at(600) }),
      ],
      { burstWindowMs: 60_000 },
    );
    expect(steps).toHaveLength(2);
  });

  it('never folds a terminal step into anything', () => {
    const steps = collapseActivity([
      event({ kind: 'done', subject: 'site', at: at(0) }),
      event({ kind: 'done', subject: 'site', at: at(1) }),
    ]);
    expect(steps).toHaveLength(2);
  });

  it('marks the newest step active while the run is going', () => {
    const steps = collapseActivity([
      event({ kind: 'reading', subject: 'section.hero', at: at(0) }),
      event({ kind: 'editing', subject: 'section.hero', at: at(1) }),
    ]);
    expect(steps[0]?.state).toBe('done');
    expect(steps[1]?.state).toBe('active');
  });

  it('marks no step active once the run is over', () => {
    const steps = collapseActivity([
      event({ kind: 'editing', subject: 'section.hero', at: at(0) }),
      event({ kind: 'done', subject: 'site', at: at(1) }),
    ]);
    expect(steps.every((step) => step.state !== 'active')).toBe(true);
  });

  it('marks a failed run failed at its last step', () => {
    const steps = collapseActivity([
      event({ kind: 'checking', subject: 'gate.copy', at: at(0) }),
      event({ kind: 'failed', subject: 'gate.copy', at: at(1) }),
    ]);
    expect(steps[1]?.state).toBe('failed');
  });

  it('hides the operator detail unless asked for it', () => {
    const events = [
      event({
        kind: 'reading',
        subject: 'section.hero',
        detail: 'src/components/Hero.astro',
      }),
    ];
    expect(collapseActivity(events)[0]?.detail).toBeUndefined();
    expect(collapseActivity(events, { keepDetail: true })[0]?.detail).toBe(
      'src/components/Hero.astro',
    );
  });

  it('gathers the chips of a burst, deduped and capped', () => {
    const steps = collapseActivity(
      [
        event({ kind: 'searching', subject: 'template.library', chips: ['a'] }),
        event({ kind: 'searching', subject: 'template.library', chips: ['b'] }),
        event({ kind: 'searching', subject: 'template.library', chips: ['a'] }),
      ],
      { maxChipsPerStep: 2 },
    );
    expect(steps[0]?.chips).toEqual(['a', 'b']);
  });

  it('keeps only the newest steps when a run is very long', () => {
    const events = Array.from({ length: 40 }, (_, index) =>
      event({
        kind: 'editing',
        subject: index % 2 === 0 ? 'page.home' : 'page.about',
        at: at(index * 1_000),
      }),
    );
    const steps = collapseActivity(events, { maxSteps: 5, lookback: 1 });
    expect(steps).toHaveLength(5);
  });

  it('lets a caller who knows the run is over say so', () => {
    const events = [
      event({ kind: 'reading', subject: 'section.hero', at: at(0) }),
      event({ kind: 'editing', subject: 'section.hero', at: at(1) }),
    ];
    // Read off the events, the newest step is the live one.
    expect(collapseActivity(events).at(-1)?.state).toBe('active');
    // Told otherwise, it is not: the funnel and the editor both learn a run
    // has stopped from somewhere other than the event list.
    expect(collapseActivity(events, { status: 'done' }).at(-1)?.state).toBe(
      'done',
    );
    expect(collapseActivity(events, { status: 'failed' }).at(-1)?.state).toBe(
      'done',
    );
  });

  it('gives every step a stable, distinct id', () => {
    const steps = collapseActivity([
      event({ kind: 'reading', subject: 'section.hero', at: at(0) }),
      event({ kind: 'editing', subject: 'section.hero', at: at(1) }),
    ]);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
  });
});

describe('activityStatus and summariseActivity', () => {
  it('reads the run status off the events', () => {
    expect(activityStatus([])).toBe('running');
    expect(activityStatus([event({ kind: 'editing' })])).toBe('running');
    expect(activityStatus([event({ kind: 'done' })])).toBe('done');
    expect(
      activityStatus([event({ kind: 'done' }), event({ kind: 'failed' })]),
    ).toBe('failed');
  });

  it('counts pages, checks and repairs for the one-line summary', () => {
    const summary = summariseActivity([
      event({ kind: 'editing', subject: 'page.home' }),
      event({ kind: 'editing', subject: 'page.about' }),
      event({ kind: 'editing', subject: 'page.home' }),
      event({ kind: 'checking', subject: 'gate.copy' }),
      event({ kind: 'checking', subject: 'gate.images' }),
      event({ kind: 'repairing', subject: 'gate.copy' }),
    ]);
    expect(summary).toEqual({ pages: 2, checks: 2, repairs: 1 });
  });

  it('names the gate a failed run stopped at', () => {
    expect(
      summariseActivity([event({ kind: 'failed', subject: 'gate.markup' })])
        .failedAt,
    ).toBe('gate.markup');
  });
});

describe('the event model', () => {
  it('refuses a kind or a subject it does not know', () => {
    expect(() =>
      assertSafeEvent({
        ...event({ kind: 'reading' }),
        kind: 'gossiping' as never,
      }),
    ).toThrow(UnsafeActivityEventError);
    expect(() =>
      assertSafeEvent({
        ...event({ kind: 'reading' }),
        subject: 'src/pages/index.astro' as never,
      }),
    ).toThrow(UnsafeActivityEventError);
  });

  it('refuses anything that looks like a credential', () => {
    expect(looksLikeSecret(mintedKey())).toBe(true);
    expect(
      looksLikeSecret(mintedAssignment(['api', 'key'].join('_'), ': ')),
    ).toBe(true);
    expect(looksLikeSecret('src/pages/index.astro')).toBe(false);
    expect(() =>
      assertSafeEvent(event({ kind: 'reading', detail: mintedKey() })),
    ).toThrow(UnsafeActivityEventError);
    expect(() =>
      assertSafeEvent(
        event({
          kind: 'searching',
          chips: [mintedAssignment('password', ' = ')],
        }),
      ),
    ).toThrow(UnsafeActivityEventError);
  });

  it('drops the operator detail on the way to a client', () => {
    const projected = projectForClient(
      event({ kind: 'reading', detail: 'src/components/Hero.astro' }),
    );
    expect(projected.detail).toBeUndefined();
    expect(projected.kind).toBe('reading');
  });

  it('recognises its own events and rejects everything else', () => {
    expect(isAgentActivityEvent(event({ kind: 'reading' }))).toBe(true);
    expect(isAgentActivityEvent({ kind: 'reading' })).toBe(false);
    expect(isAgentActivityEvent(null)).toBe(false);
    expect(
      isAgentActivityEvent({ ...event({ kind: 'reading' }), chips: [1] }),
    ).toBe(false);
  });

  it('parses a persisted list and drops the rows it cannot trust', () => {
    expect(
      parseActivityEvents([event({ kind: 'reading' }), { nope: true }, 7]),
    ).toHaveLength(1);
    expect(parseActivityEvents('not a list')).toEqual([]);
  });
});

describe('ActivityRecorder', () => {
  function recorder(
    options: { minIntervalMs?: number; maxEvents?: number } = {},
  ) {
    const events: AgentActivityEvent[] = [];
    let clock = Date.UTC(2026, 8, 14, 10, 0, 0);
    const instance = new ActivityRecorder({
      sink: (recorded) => events.push(recorded),
      now: () => clock,
      ...options,
    });
    return {
      events,
      instance,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('files a tool call under the phase it happened in', () => {
    const { instance, events } = recorder();
    instance.phase('Agents expanding the site');
    instance.tool('read_file', { path: 'src/pages/index.astro' });
    expect(events[1]).toMatchObject({
      phase: 'Agents expanding the site',
      kind: 'reading',
      subject: 'page.home',
      detail: 'src/pages/index.astro',
    });
  });

  it('rate-limits a repeated tool call and lets it through again later', () => {
    const { instance, events, advance } = recorder({ minIntervalMs: 1_000 });
    instance.phase('Agents expanding the site');
    instance.tool('read_file', { path: 'src/pages/index.astro' });
    instance.tool('read_file', { path: 'src/pages/index.astro' });
    expect(events).toHaveLength(2);
    advance(1_500);
    instance.tool('read_file', { path: 'src/pages/index.astro' });
    expect(events).toHaveLength(3);
  });

  it('never rate-limits a phase boundary', () => {
    const { instance, events } = recorder({ minIntervalMs: 60_000 });
    instance.phase('Checking the build');
    instance.phase('Checking the build');
    expect(events).toHaveLength(2);
  });

  it('stops emitting at the cap', () => {
    const { instance, events, advance } = recorder({
      minIntervalMs: 0,
      maxEvents: 3,
    });
    for (let index = 0; index < 20; index += 1) {
      advance(10);
      instance.tool('read_file', { path: 'src/pages/index.astro' });
    }
    expect(events).toHaveLength(3);
    expect(instance.eventCount).toBe(3);
  });

  it('narrates nothing for a tool outside the table', () => {
    const { instance, events } = recorder();
    instance.tool('run_shell', { cmd: 'ls' });
    expect(events).toHaveLength(0);
  });

  it('records a gate, a repair and the end of a run', () => {
    const { instance, events } = recorder();
    instance.gate('gate.copy', 'two sentinels left in the hero');
    instance.repair('gate.copy');
    instance.finish('site');
    expect(events.map((recorded) => recorded.kind)).toEqual([
      'checking',
      'repairing',
      'done',
    ]);
    expect(events[0]?.detail).toBe('two sentinels left in the hero');
  });

  it('drops an event it cannot vouch for rather than repairing it', () => {
    const { instance, events } = recorder();
    instance.gate('gate.copy', mintedAssignment('authorization', ': Bearer '));
    expect(events).toHaveLength(0);
    expect(instance.eventCount).toBe(0);
  });

  it('collapses into the steps a reader sees, end to end', () => {
    const { instance, events, advance } = recorder({ minIntervalMs: 0 });
    instance.phase('Agents expanding the site');
    for (let index = 0; index < 6; index += 1) {
      advance(100);
      instance.tool('read_file', { path: 'src/components/Services.astro' });
    }
    advance(100);
    instance.tool('edit_file', { path: 'src/components/Services.astro' });
    const steps = collapseActivity(events);
    expect(steps.map((step) => [step.kind, step.subject, step.count])).toEqual([
      ['editing', 'site', 1],
      ['reading', 'section.services', 6],
      ['editing', 'section.services', 1],
    ]);
  });
});
