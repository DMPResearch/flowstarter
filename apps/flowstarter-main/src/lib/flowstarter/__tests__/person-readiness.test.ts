/**
 * What the readiness rule says about seven briefs.
 *
 * The brief that started all of this reported completeness 0.4 with four
 * cheerful `degrades` notes and was declared ready to build. The one thing
 * these assertions have to protect is the opposite verdict: a portfolio with
 * neither a word from the person nor a picture of them is not a slightly
 * thinner site, it is a site about nobody, and it waits.
 *
 * Every case is a persona from `src/test/fixtures/personas.ts`, so the same
 * seven people are judged here, asked their questions in
 * `person-intake.test.ts`, and built in the codegen suite.
 */
import { describe, expect, it } from 'vitest';
import { PERSONAS, persona, type Persona } from '@/test/fixtures/personas';
import {
  BRIEF_MISSING_MESSAGES,
  evaluateBriefReadiness,
  type BriefInput,
} from '../brief-readiness';
import { briefSiteKind, type BriefView } from '../brief-data';
import { EMPTY_BRIEF } from '../brief-data';

/** The photo rows a persona's portrait implies, as the rule reads them. */
function photosFor(entry: Persona) {
  if (!entry.portraitPath) return [];
  return [
    {
      assetId: '0d1f3a21-5b6c-4d7e-8f90-1a2b3c4d5e6f',
      kind: 'portrait',
      width: 1600,
      height: 2000,
      rightsConfirmed: true,
    },
  ];
}

/** One persona's brief, as `evaluateBriefReadiness` takes it. */
function inputFor(entry: Persona): BriefInput {
  return {
    offer: entry.offer,
    siteKind: briefSiteKind({
      ...EMPTY_BRIEF,
      person: entry.person,
    } as BriefView),
    person: entry.person,
    projects: entry.projects.map((project) => ({
      name: project.name,
      line: project.line,
    })),
    noProjects: entry.noProjects,
    photos: photosFor(entry),
    designReferenceAssetIds: [],
  };
}

function blockingCodes(input: BriefInput): string[] {
  return evaluateBriefReadiness(input)
    .missing.filter((entry) => entry.severity === 'blocking')
    .map((entry) => entry.code);
}

describe('a brief is judged for the kind of site it is', () => {
  it.each(PERSONAS.map((entry) => [entry.id, entry] as const))(
    '%s gets the verdict their material earns',
    (_id, entry) => {
      const readiness = evaluateBriefReadiness(inputFor(entry));
      expect(readiness.ready).toBe(entry.expect.briefReady);
      expect(
        readiness.missing
          .filter((item) => item.severity === 'blocking')
          .map((item) => item.code)
      ).toEqual(entry.expect.blockingCodes);
    }
  );

  it('blocks a portfolio that has neither a story nor a portrait', () => {
    const nadia = persona('nadia-accountant');
    const readiness = evaluateBriefReadiness(inputFor(nadia));
    expect(readiness.ready).toBe(false);
    const item = readiness.missing.find(
      (entry) => entry.code === 'brief_person_missing'
    );
    expect(item?.severity).toBe('blocking');
    // The ask names both ways out. A client who reads "your brief is
    // incomplete" sends nothing; a client who reads this sends one of two
    // specific things.
    expect(item?.message).toBe(BRIEF_MISSING_MESSAGES.brief_person_missing);
    expect(item?.message).toContain('photograph');
    expect(item?.message).toContain('own words');
  });

  it('lets a story alone unblock a portfolio with no photograph', () => {
    const maria = persona('maria-avocat');
    expect(blockingCodes(inputFor(maria))).toEqual([]);
    // The photograph is still asked for. It is simply not worth stopping for.
    expect(
      evaluateBriefReadiness(inputFor(maria)).missing.map((item) => item.code)
    ).toContain('brief_portrait_missing');
  });

  it('lets a photograph alone unblock a portfolio with no story', () => {
    const tom = persona('tom-trainer');
    expect(blockingCodes(inputFor(tom))).toEqual([]);
  });

  it('never blocks a services business on a person', () => {
    const plumber = persona('orchard-plumbing');
    const readiness = evaluateBriefReadiness(inputFor(plumber));
    expect(readiness.ready).toBe(true);
    expect(readiness.missing.map((item) => item.code)).not.toContain(
      'brief_person_missing'
    );
  });

  it('stays silent about a brief nobody was ever asked', () => {
    // Every workspace taken before the person section existed. `person: null`
    // is the state, and a gate that guessed here would stop the backlog over
    // a form field nobody has seen.
    const nadia = persona('nadia-accountant');
    const neverAsked = evaluateBriefReadiness({
      ...inputFor(nadia),
      person: null,
    });
    expect(neverAsked.ready).toBe(true);
    expect(neverAsked.missing.map((item) => item.code)).not.toContain(
      'brief_person_missing'
    );
  });

  it('asks for the activity without stopping for it', () => {
    const tom = persona('tom-trainer');
    const readiness = evaluateBriefReadiness({
      ...inputFor(tom),
      person: {
        ...tom.person!,
        activity: { what: '', who: '', typical: '', knownFor: '', years: '' },
      },
    });
    const item = readiness.missing.find(
      (entry) => entry.code === 'brief_activity_missing'
    );
    expect(item?.severity).toBe('degrades');
    expect(readiness.ready).toBe(true);
  });
});

describe('the progress line counts the person', () => {
  it('counts a sixth part for a portfolio and five for everyone else', () => {
    const sam = persona('sam-ux');
    const plumber = persona('orchard-plumbing');
    // Sam has the offer, the projects answer, the portrait and the person,
    // and no second photo and no design reference: four of six.
    expect(evaluateBriefReadiness(inputFor(sam)).completeness).toBeCloseTo(
      4 / 6
    );
    // The plumber has the offer and the projects answer out of five.
    expect(evaluateBriefReadiness(inputFor(plumber)).completeness).toBeCloseTo(
      2 / 5
    );
  });

  it('does not make an old services brief look less finished than it was', () => {
    const plumber = persona('orchard-plumbing');
    const before = evaluateBriefReadiness({
      offer: plumber.offer,
      projects: [],
      noProjects: true,
      photos: [],
      designReferenceAssetIds: [],
    });
    const after = evaluateBriefReadiness(inputFor(plumber));
    expect(after.completeness).toBe(before.completeness);
  });
});

describe('every message is a concrete ask', () => {
  it('names a subject and a shape, with no em dash and no emoji', () => {
    for (const [code, message] of Object.entries(BRIEF_MISSING_MESSAGES)) {
      expect(message, code).not.toMatch(/[—–]/);
      // Any astral-plane character. Every emoji is a surrogate pair, and a
      // pair range needs no `u` flag, which this tsconfig target does not have.
      expect(message, code).not.toMatch(/[\uD800-\uDBFF][\uDC00-\uDFFF]/);
      expect(message.length, code).toBeGreaterThan(40);
    }
  });
});
