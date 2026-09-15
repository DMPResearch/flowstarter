/**
 * Which template each of the seven personas starts from.
 *
 * The delivered portfolio that prompted all of this was built from
 * `professional-services`. Nothing malfunctioned: the brief said "Founder of
 * Flowstarter", the business name said "Flowstarter", and a founder of a
 * named company is a professional-services site. The classification was wrong
 * one step earlier than anybody was looking, and every page followed honestly
 * from it.
 *
 * So the rule that decides who gets asked about themselves is now the same
 * rule that decides which templates they may be built from, and these
 * assertions are what keep the two readings from drifting apart. The control
 * matters as much as the cases: `orchard-plumbing` has to keep today's
 * behaviour exactly, or the fix is just a different wrong answer.
 */
import { describe, expect, it } from 'vitest';
import { PERSONAS, persona, type Persona } from '@/test/fixtures/personas';
import {
  candidatesForKind,
  isPersonalPortfolio,
  ruleMaySettleTemplate,
  templateKindFor,
} from '@flowstarter/agentic-codegen/src/flowstarter/template-kind';
import type {
  BusinessIntakePayload,
  TemplateCandidate,
} from '@flowstarter/agentic-codegen/src/flowstarter/types';

/**
 * The library as it actually ships, in the shape the search returns.
 *
 * Real slugs and real descriptions rather than invented ones: the rule reads
 * a candidate's own descriptors, so a fixture that made them up would be
 * testing the fixture.
 */
const LIBRARY: readonly TemplateCandidate[] = [
  {
    slug: 'creative-portfolio',
    displayName: 'Creative Portfolio',
    description:
      'An editorial portfolio for a designer or studio, built around selected work and a long about page.',
    category: 'Creative',
    useCase: ['portfolio', 'design studio', 'art direction'],
    fileCount: 0,
    totalLOC: 0,
  },
  {
    slug: 'dorin-portfolio',
    displayName: 'Dorin Portfolio',
    description:
      'A personal portfolio with a strong hero, a body of work and a first-person about page.',
    category: 'Creative',
    useCase: ['portfolio', 'personal site'],
    fileCount: 0,
    totalLOC: 0,
  },
  {
    slug: 'professional-services',
    displayName: 'Professional Services',
    description:
      'A services site for a consultancy or practice: offers, process and enquiries.',
    category: 'Services',
    useCase: ['consulting', 'accountancy', 'legal'],
    fileCount: 0,
    totalLOC: 0,
  },
  {
    slug: 'local-trade',
    displayName: 'Local Trade',
    description:
      'A site for a trade business with a catchment area: services, coverage and callouts.',
    category: 'Services',
    useCase: ['plumbing', 'electrical', 'callouts'],
    fileCount: 0,
    totalLOC: 0,
  },
  {
    slug: 'wellness-therapy',
    displayName: 'Wellness and Therapy',
    description:
      'A calm site for a therapy or wellness practice, built around sessions and booking.',
    category: 'Wellness',
    useCase: ['therapy', 'coaching', 'bookings'],
    fileCount: 0,
    totalLOC: 0,
  },
];

const PORTFOLIO_SLUGS = ['creative-portfolio', 'dorin-portfolio'];
const NEVER_FOR_A_PERSON = ['professional-services', 'local-trade'];

/** The intake payload each persona's funnel would have produced. */
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
    // The funnel only attaches a person section to a visitor it read as being
    // the business, which is precisely the signal this rule reads back.
    ...(entry.person ? { person: entry.person } : {}),
  };
}

describe('a template knows what it is for', () => {
  it.each(LIBRARY.map((entry) => [entry.slug, entry] as const))(
    '%s is classified by its own descriptors',
    (slug, candidate) => {
      expect(templateKindFor(candidate)).toBe(
        PORTFOLIO_SLUGS.includes(slug) ? 'portfolio' : 'services'
      );
    }
  );

  it('reads the slug when a description is thin', () => {
    // A template whose description has not been written yet is still named,
    // and the name is the one string it is guaranteed to have.
    expect(
      templateKindFor({
        slug: 'someone-portfolio',
        displayName: '',
        description: '',
        category: '',
        useCase: [],
        fileCount: 0,
        totalLOC: 0,
      })
    ).toBe('portfolio');
  });
});

describe('a personal site is built from a portfolio template', () => {
  it.each(PERSONAS.map((entry) => [entry.id, entry] as const))(
    '%s is classified the same way the intake classified them',
    (_id, entry) => {
      expect(isPersonalPortfolio(intakeFor(entry))).toBe(
        entry.expect.asksPersonQuestions
      );
    }
  );

  it.each(
    ['sam-ux', 'maria-avocat', 'elena-ceramica'].map(
      (id) => [id, persona(id)] as const
    )
  )('%s can only be built from a portfolio template', (_id, entry) => {
    const personal = isPersonalPortfolio(intakeFor(entry));
    expect(personal).toBe(true);

    const allowed = candidatesForKind(LIBRARY, personal).map((c) => c.slug);
    expect(allowed.sort()).toEqual([...PORTFOLIO_SLUGS].sort());
    for (const slug of NEVER_FOR_A_PERSON) {
      expect(allowed).not.toContain(slug);
    }

    // And the rule settles it rather than handing a narrowed, unambiguous
    // choice back to a model.
    expect(ruleMaySettleTemplate(LIBRARY, personal)).toBe(true);
  });

  it('leaves a plumbing company exactly as it was', () => {
    const plumber = persona('orchard-plumbing');
    const personal = isPersonalPortfolio(intakeFor(plumber));
    expect(personal).toBe(false);
    // The whole library, in the order it arrived, and the model path still
    // decides. Nothing about a company brief changed.
    expect(candidatesForKind(LIBRARY, personal).map((c) => c.slug)).toEqual(
      LIBRARY.map((c) => c.slug)
    );
    expect(ruleMaySettleTemplate(LIBRARY, personal)).toBe(false);
  });

  it('catches the exact brief that shipped from the wrong template', () => {
    // "Founder of Flowstarter", business name "Flowstarter", no portfolio
    // word anywhere in the niche. Under the old reading this is a
    // professional-services site; under the new one the person section makes
    // it a portfolio, because the funnel asked him about himself.
    const asShipped: BusinessIntakePayload = {
      ...intakeFor(persona('sam-ux')),
      business: {
        name: 'Flowstarter',
        niche: 'Professional services',
        location: 'Not provided',
        description: 'Founder of Flowstarter, building websites with agents.',
      },
    };
    expect(isPersonalPortfolio(asShipped)).toBe(true);
    expect(candidatesForKind(LIBRARY, true).map((c) => c.slug)).not.toContain(
      'professional-services'
    );
  });

  it('never leaves the pipeline with nothing to build from', () => {
    // A library with no portfolio template is a deployment problem, not a
    // reason to fail a preview. The content gates still hold the site to the
    // person either way.
    const servicesOnly = LIBRARY.filter(
      (candidate) => templateKindFor(candidate) === 'services'
    );
    expect(candidatesForKind(servicesOnly, true)).toEqual(servicesOnly);
    expect(ruleMaySettleTemplate(servicesOnly, true)).toBe(false);
    expect(candidatesForKind([], true)).toEqual([]);
  });

  it('has no opinion about a brief taken before the person section existed', () => {
    // `person` absent and a niche with no portfolio word in it: the old
    // behaviour, unchanged, for every workspace already in the backlog.
    const legacy: BusinessIntakePayload = {
      ...intakeFor(persona('orchard-plumbing')),
      business: {
        name: 'Calm Path Therapy',
        niche: 'Therapy and wellness',
        location: 'Cluj',
        description: 'A small therapy practice.',
      },
    };
    expect(isPersonalPortfolio(legacy)).toBe(false);
  });
});
