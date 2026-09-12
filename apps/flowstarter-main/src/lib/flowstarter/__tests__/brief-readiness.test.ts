import { describe, expect, it } from 'vitest';

import {
  BRIEF_MISSING_CODES,
  BRIEF_MISSING_MESSAGES,
  BRIEF_REMINDER_AFTER_MS,
  MIN_OFFER_CHARS,
  MIN_PHOTO_LONG_EDGE,
  briefAllowsBuild,
  briefReminderDue,
  evaluateBriefReadiness,
  isUndersizedPhoto,
  isUsablePhoto,
  offerLength,
  type BriefInput,
} from '../brief-readiness';

const GOOD_OFFER =
  'Cosmetic dentistry for people who have avoided a dentist for years, including whitening, veneers and a gentle first visit.';

/** A brief with nothing blocking outstanding. */
const COMPLETE: BriefInput = {
  offer: GOOD_OFFER,
  projects: [
    { name: 'Ereno', line: 'A calm inbox.', screenshotAssetIds: ['a'] },
  ],
  noProjects: false,
  photos: [
    { assetId: 'p1', kind: 'portrait', width: 2000, height: 1500 },
    { assetId: 'p2', kind: 'workplace', width: 1800, height: 1200 },
  ],
  designReferenceAssetIds: ['d1'],
};

function codes(input: BriefInput): string[] {
  return evaluateBriefReadiness(input).missing.map((entry) => entry.code);
}

function blocking(input: BriefInput): string[] {
  return evaluateBriefReadiness(input)
    .missing.filter((entry) => entry.severity === 'blocking')
    .map((entry) => entry.code);
}

describe('the message catalogue', () => {
  it('has one concrete ask per code', () => {
    for (const code of BRIEF_MISSING_CODES) {
      const message = BRIEF_MISSING_MESSAGES[code];
      expect(message.length).toBeGreaterThan(40);
    }
  });

  it('uses no em dashes and no emoji, like the rest of the copy', () => {
    for (const code of BRIEF_MISSING_CODES) {
      expect(BRIEF_MISSING_MESSAGES[code]).not.toMatch(/[—–]/);
      // Surrogate range plus the dingbats block: enough to catch anything a
      // copy edit would smuggle in, without a unicode-property escape the
      // package's TypeScript target does not allow.
      expect(BRIEF_MISSING_MESSAGES[code]).not.toMatch(
        /[\uD800-\uDBFF\u2700-\u27BF\u2190-\u21FF]/
      );
    }
  });
});

describe('reading the input', () => {
  it('collapses whitespace before counting the offer', () => {
    expect(offerLength('  a   b  ')).toBe(3);
    expect(offerLength('\n\n\n')).toBe(0);
    expect(offerLength(null)).toBe(0);
    expect(offerLength(undefined)).toBe(0);
  });

  it('calls a photograph usable only when it is big enough', () => {
    expect(isUsablePhoto({ assetId: 'a', width: 2000, height: 1000 })).toBe(
      true
    );
    expect(isUsablePhoto({ assetId: 'a', width: 1000, height: 2000 })).toBe(
      true
    );
    expect(isUsablePhoto({ assetId: 'a', width: 800, height: 600 })).toBe(
      false
    );
    expect(isUsablePhoto({ assetId: 'a' })).toBe(false);
  });

  it('refuses a photograph whose rights are not confirmed', () => {
    expect(
      isUsablePhoto({
        assetId: 'a',
        width: 3000,
        height: 2000,
        rightsConfirmed: false,
      })
    ).toBe(false);
  });

  it('warns about a small picture without refusing it', () => {
    expect(isUndersizedPhoto({ width: 900, height: 600 })).toBe(true);
    expect(isUndersizedPhoto({ width: MIN_PHOTO_LONG_EDGE, height: 10 })).toBe(
      false
    );
    // Unknown dimensions are not a warning: we have nothing to warn about.
    expect(isUndersizedPhoto({})).toBe(false);
  });
});

describe('evaluateBriefReadiness', () => {
  it('passes a complete brief', () => {
    const readiness = evaluateBriefReadiness(COMPLETE);
    expect(readiness.ready).toBe(true);
    expect(readiness.missing).toEqual([]);
    expect(readiness.completeness).toBe(1);
  });

  it('blocks an empty brief on the offer and the projects, and nothing else', () => {
    expect(blocking({})).toEqual([
      'brief_offer_missing',
      'brief_projects_unanswered',
    ]);
  });

  it('tells a thin offer apart from a missing one', () => {
    expect(blocking({ offer: 'Whitening.' })).toContain('brief_offer_thin');
    expect(blocking({ offer: 'Whitening.' })).not.toContain(
      'brief_offer_missing'
    );
    expect(offerLength('Whitening.')).toBeLessThan(MIN_OFFER_CHARS);
  });

  it('accepts "I have no past work" as an answer to the projects question', () => {
    const noWork: BriefInput = {
      ...COMPLETE,
      projects: [],
      noProjects: true,
    };
    expect(evaluateBriefReadiness(noWork).ready).toBe(true);
    expect(codes(noWork)).not.toContain('brief_projects_unanswered');
  });

  it('does not accept an empty list as the same thing as saying so', () => {
    // The whole reason `noProjects` exists: "not filled in yet" and "asked,
    // and the answer is none" must not look the same to a build.
    expect(blocking({ ...COMPLETE, projects: [], noProjects: false })).toEqual([
      'brief_projects_unanswered',
    ]);
  });

  it('blocks a project row that has no name', () => {
    expect(
      blocking({
        ...COMPLETE,
        projects: [
          { name: 'Ereno', screenshotAssetIds: ['a'] },
          { name: '   ', line: 'Something.' },
        ],
      })
    ).toEqual(['brief_project_unnamed']);
  });

  it('asks for screenshots without stopping for them', () => {
    const readiness = evaluateBriefReadiness({
      ...COMPLETE,
      projects: [{ name: 'Ereno', screenshotAssetIds: [] }],
    });
    expect(readiness.ready).toBe(true);
    expect(
      readiness.missing.find(
        (entry) => entry.code === 'brief_project_screenshots_missing'
      )?.severity
    ).toBe('degrades');
  });

  it('treats every photograph ask as worth having and not worth stopping for', () => {
    const readiness = evaluateBriefReadiness({ ...COMPLETE, photos: [] });
    expect(readiness.ready).toBe(true);
    expect(codes({ ...COMPLETE, photos: [] })).toEqual([
      'brief_photos_missing',
      'brief_portrait_missing',
    ]);
  });

  it('does not count a photograph that is too small towards the quota', () => {
    expect(
      codes({
        ...COMPLETE,
        photos: [
          { assetId: 'p1', kind: 'portrait', width: 800, height: 600 },
          { assetId: 'p2', kind: 'workplace', width: 2000, height: 1500 },
        ],
      })
    ).toEqual(['brief_photos_missing', 'brief_portrait_missing']);
  });

  it('asks for a design reference and does not stop for it', () => {
    const readiness = evaluateBriefReadiness({
      ...COMPLETE,
      designReferenceAssetIds: [],
    });
    expect(readiness.ready).toBe(true);
    expect(codes({ ...COMPLETE, designReferenceAssetIds: [] })).toEqual([
      'brief_design_reference_missing',
    ]);
  });

  it('reports completeness over the five things a whole brief has', () => {
    expect(evaluateBriefReadiness({}).completeness).toBe(0);
    expect(
      evaluateBriefReadiness({ offer: GOOD_OFFER, noProjects: true })
        .completeness
    ).toBeCloseTo(0.4, 5);
    expect(evaluateBriefReadiness(COMPLETE).completeness).toBe(1);
  });

  it('is stable: the same brief gives byte-identical codes every time', () => {
    const once = evaluateBriefReadiness({ offer: 'A.' });
    const twice = evaluateBriefReadiness({ offer: 'A.' });
    expect(once).toEqual(twice);
  });

  it('reads null and undefined the way a legacy row would carry them', () => {
    expect(() =>
      evaluateBriefReadiness({
        offer: null,
        projects: null,
        noProjects: null,
        photos: null,
        designReferenceAssetIds: null,
      })
    ).not.toThrow();
  });
});

describe('briefAllowsBuild', () => {
  it('lets a ready brief through', () => {
    expect(briefAllowsBuild({ readyAt: '2026-09-12T00:00:00Z' })).toBe(true);
  });

  it('lets an operator override through', () => {
    expect(briefAllowsBuild({ overrideAt: '2026-09-12T00:00:00Z' })).toBe(true);
  });

  it('holds everything else, including an old deposit', () => {
    expect(briefAllowsBuild({})).toBe(false);
    expect(briefAllowsBuild({ readyAt: null, overrideAt: null })).toBe(false);
  });
});

describe('briefReminderDue', () => {
  const incomplete = evaluateBriefReadiness({});
  const complete = evaluateBriefReadiness(COMPLETE);
  const paid = new Date('2026-09-10T09:00:00Z');
  const later = new Date(paid.getTime() + BRIEF_REMINDER_AFTER_MS + 1000);

  it('says nothing when the brief is already ready', () => {
    expect(
      briefReminderDue({
        readiness: complete,
        depositPaidAt: paid,
        now: later,
      })
    ).toEqual({ send: false, reason: 'brief_ready' });
  });

  it('says nothing when an operator has already overridden', () => {
    expect(
      briefReminderDue({
        readiness: incomplete,
        depositPaidAt: paid,
        overrideAt: paid,
        now: later,
      })
    ).toEqual({ send: false, reason: 'overridden' });
  });

  it('waits a day before nagging somebody who is mid-form', () => {
    expect(
      briefReminderDue({
        readiness: incomplete,
        depositPaidAt: paid,
        now: new Date(paid.getTime() + 60_000),
      })
    ).toEqual({ send: false, reason: 'too_soon' });
  });

  it('says nothing when there is no deposit to count from', () => {
    expect(
      briefReminderDue({
        readiness: incomplete,
        depositPaidAt: null,
        now: later,
      })
    ).toEqual({ send: false, reason: 'too_soon' });
    expect(
      briefReminderDue({
        readiness: incomplete,
        depositPaidAt: 'not a date',
        now: later,
      })
    ).toEqual({ send: false, reason: 'too_soon' });
  });

  it('sends once the wait is over, naming only what is blocking', () => {
    const verdict = briefReminderDue({
      readiness: evaluateBriefReadiness({ offer: GOOD_OFFER }),
      depositPaidAt: paid.toISOString(),
      now: later,
    });
    expect(verdict.send).toBe(true);
    if (!verdict.send) throw new Error('expected a send');
    // The photographs are worth asking for and are not worth an email that
    // says "we are waiting on you".
    expect(verdict.missing.map((entry) => entry.code)).toEqual([
      'brief_projects_unanswered',
    ]);
  });

  it('takes its clock from the caller, never from the machine', () => {
    const custom = briefReminderDue({
      readiness: incomplete,
      depositPaidAt: paid,
      now: new Date(paid.getTime() + 2000),
      afterMs: 1000,
    });
    expect(custom.send).toBe(true);
  });
});
