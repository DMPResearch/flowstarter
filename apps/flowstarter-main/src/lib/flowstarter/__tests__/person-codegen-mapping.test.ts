/**
 * What the agent is actually handed, for each of the seven personas.
 *
 * The gap this closes is the one the whole change is about. Everything the
 * client wrote used to stop at the dashboard: the brief held it, the payload
 * did not carry it, and the site was written from four intake answers and a
 * template. So these assertions are about the crossing, not about the
 * storage: for every persona, their own sentences have to be in the
 * paragraph the build task carries, in their own language, with the
 * instruction that their phrasing wins.
 *
 * No model runs here. `describeBriefInput` is deterministic by construction
 * and that is exactly why it can be asserted word for word.
 */
import { describe, expect, it } from 'vitest';
import { PERSONAS, persona, type Persona } from '@/test/fixtures/personas';
import {
  BRIEF_INPUT_VERSION,
  describeBriefInput,
  mergeBriefIntoIntake,
  type BriefInput,
} from '@flowstarter/agentic-codegen/src/flowstarter/brief-input';
import type { BusinessIntakePayload } from '@flowstarter/agentic-codegen/src/flowstarter/types';

function briefInputFor(entry: Persona): BriefInput {
  return {
    version: BRIEF_INPUT_VERSION,
    composedAt: '2026-09-15T11:00:00.000Z',
    reason: 'brief_ready',
    offer: entry.offer,
    projects: entry.projects.map((project) => ({
      name: project.name,
      line: project.line,
      link: '',
      screenshotAssetIds: [],
      screenshots: [],
    })),
    noProjects: entry.noProjects,
    designReferences: [],
    photos: [],
    portrait: entry.portraitPath
      ? {
          assetId: '0d1f3a21-5b6c-4d7e-8f90-1a2b3c4d5e6f',
          publicPath: entry.portraitPath,
          manifestPath: `public${entry.portraitPath}`,
          role: 'portrait',
          caption: `${entry.person?.name ?? ''}, portrait`,
          mime: 'image/jpeg',
          width: 1600,
          height: 2000,
        }
      : null,
    person: entry.person,
  };
}

function intakeFor(entry: Persona): BusinessIntakePayload {
  return {
    projectId: '0f4e1088-8d8f-4f18-83b1-406cc292b23c',
    business: {
      name: entry.expect.businessName,
      niche: entry.discovery.industry || 'Service business',
      location: 'Not provided',
      description: entry.discovery.description,
    },
    socialMedia: [],
    locale: entry.locale,
    submittedAt: '2026-09-15T10:00:00.000Z',
    consent: { publicProfileAnalysis: false, acceptedAt: '' },
  };
}

describe('the person reaches the agent', () => {
  it.each(
    PERSONAS.filter((entry) => entry.person !== null).map(
      (entry) => [entry.id, entry] as const
    )
  )('%s is described in their own words', (_id, entry) => {
    const described = describeBriefInput(briefInputFor(entry));
    const person = entry.person!;

    if (person.story) {
      expect(described).toContain(person.story);
      expect(described).toContain("client's phrasing wins");
      expect(described).toContain('Never invent biography');
    }
    if (person.howIWork) {
      // The process section, and the instruction that it comes from this and
      // from nothing else.
      expect(described).toContain(person.howIWork);
      expect(described).toContain('process section');
    }
    if (person.toneWords.length > 0) {
      expect(described).toContain(person.toneWords.join(', '));
    }
    if (person.activity.what) {
      expect(described).toContain(person.activity.what);
      // The sentence that stops the services page widening into nothing.
      expect(described).toContain('bespoke solutions');
    }
  });

  it('carries Romanian prose through untouched', () => {
    const ioana = persona('ioana-fotograf');
    const described = describeBriefInput(briefInputFor(ioana));
    expect(described).toContain(ioana.person!.story);
    expect(described).toContain(ioana.person!.activity.typical);
    expect(described).toContain('cald, linistit, sincer');
  });

  it('says nothing about a person nobody was asked about', () => {
    const plumber = persona('orchard-plumbing');
    const described = describeBriefInput(briefInputFor(plumber));
    expect(described).not.toContain('THE PERSON');
    // The rest of the brief still crosses. Only the person is absent.
    expect(described).toContain(plumber.offer);
  });

  it('says nothing about a person who was asked and skipped', () => {
    const nadia = persona('nadia-accountant');
    const described = describeBriefInput(briefInputFor(nadia));
    expect(described).not.toContain('THE PERSON');
  });

  it('warns the agent off a bio the client has not approved', () => {
    const sam = persona('sam-ux');
    const described = describeBriefInput({
      ...briefInputFor(sam),
      person: {
        ...sam.person!,
        sourcedBio: {
          excerpt: 'Designs software. Eleven years at it.',
          source: 'github-bio',
          sourceUrl: 'https://github.com/samokafor',
          fetchedAt: '2026-09-15T09:00:00.000Z',
          adoptedAt: null,
        },
      },
    });
    expect(described).toContain('Do not use it anywhere');
  });
});

describe('the merge onto the intake', () => {
  it('sets the key when the brief has a section, including an empty one', () => {
    // "Asked and skipped" is a real answer and the gate reads it. A merge
    // that omitted the key would make it indistinguishable from "never
    // asked", which is the one distinction the whole rule turns on.
    const nadia = persona('nadia-accountant');
    const merged = mergeBriefIntoIntake(intakeFor(nadia), briefInputFor(nadia));
    expect(merged.person).toBeDefined();
    expect(merged.person?.story).toBe('');
  });

  it('leaves the key absent when the brief never asked', () => {
    const plumber = persona('orchard-plumbing');
    const merged = mergeBriefIntoIntake(
      intakeFor(plumber),
      briefInputFor(plumber)
    );
    expect(merged.person).toBeUndefined();
  });

  it('carries the story and the activity onto the payload', () => {
    const sam = persona('sam-ux');
    const merged = mergeBriefIntoIntake(intakeFor(sam), briefInputFor(sam));
    expect(merged.person?.story).toBe(sam.person!.story);
    expect(merged.person?.activity.knownFor).toBe(
      sam.person!.activity.knownFor
    );
    expect(merged.person?.toneWords).toEqual(['plain', 'direct', 'warm']);
  });

  it('does nothing at all without a brief', () => {
    const sam = persona('sam-ux');
    expect(mergeBriefIntoIntake(intakeFor(sam), null).person).toBeUndefined();
  });
});
