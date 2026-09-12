/**
 * What the intake stopped asking, and how it is guessed instead.
 *
 * These rules are the price of cutting the pre-preview form to four questions:
 * the skeleton and the generation still need an industry, a goal and a page
 * budget, and nobody is being asked for them any more. A guess that is wrong
 * loudly is worse than one that declines, so most of what is tested here is
 * the declining.
 */
import { describe, expect, it } from 'vitest';

import { EMPTY_DISCOVERY, type DiscoveryData } from '../discovery.logic';
import {
  DEFAULT_COMMERCE_MODE,
  DEFAULT_GOAL,
  DEFAULT_PAGE_COUNT,
  deriveBusinessName,
  goalFromDescription,
  guessedFields,
  industryFromDescription,
  withQuickDefaults,
} from '../quick-defaults';

function withDescription(description: string): DiscoveryData {
  return { ...EMPTY_DISCOVERY, description };
}

describe('industryFromDescription', () => {
  it.each([
    ['We roast and serve single origin coffee in Cluj.', 'Hospitality & food'],
    ['Wedding photography across Transylvania.', 'Photography'],
    ['I am a brand designer for small studios.', 'Creative & design'],
    ['Talking therapy for adults, in person and online.', 'Therapy & wellness'],
    ['Personal training and strength coaching.', 'Fitness & training'],
    ['A barber shop with four chairs.', 'Beauty & salon'],
    ['Plumbing and heating across the county.', 'Professional services'],
  ])('reads %j as %j', (description, industry) => {
    expect(industryFromDescription(description)).toBe(industry);
  });

  it('does not let a size adjective outrank the actual trade', () => {
    // `boutique` reads as a fashion word and is used far more often to mean
    // "small": a boutique clinic, a boutique agency, a boutique hotel. It used
    // to sit in the fashion rule, which sent a dental clinic to Fashion &
    // style and reshaped the whole skeleton around it.
    expect(
      industryFromDescription(
        'A boutique dental clinic in Cluj doing cosmetic work.'
      )
    ).toBe('Therapy & wellness');
    expect(industryFromDescription('A boutique agency for founders.')).not.toBe(
      'Fashion & style'
    );
  });

  it('still reads a real fashion business as one', () => {
    expect(industryFromDescription('A menswear label out of Bucharest.')).toBe(
      'Fashion & style'
    );
  });

  it('declines rather than guessing when nothing is clear', () => {
    expect(industryFromDescription('We help people.')).toBe('');
    expect(industryFromDescription('')).toBe('');
    expect(industryFromDescription('   ')).toBe('');
  });

  it('is case insensitive', () => {
    expect(industryFromDescription('WEDDING PHOTOGRAPHY')).toBe('Photography');
  });
});

describe('goalFromDescription', () => {
  it('reads a booking business as wanting bookings', () => {
    expect(goalFromDescription('Fifty minute sessions, booked online.')).toBe(
      'Take bookings or appointments'
    );
  });

  it('reads a shop as wanting sales', () => {
    expect(goalFromDescription('We sell ceramics from our own studio.')).toBe(
      'Sell products or services'
    );
  });

  it('reads a portfolio as wanting a portfolio', () => {
    expect(goalFromDescription('A portfolio of my case studies.')).toBe(
      'Show a portfolio of work'
    );
  });

  it('falls back to enquiries, which is what most sites are for', () => {
    expect(goalFromDescription('We help people.')).toBe(DEFAULT_GOAL);
    expect(goalFromDescription('')).toBe(DEFAULT_GOAL);
  });
});

describe('withQuickDefaults', () => {
  it('fills the four blanks the intake stopped asking about', () => {
    const filled = withQuickDefaults(
      withDescription('A dental clinic in Cluj doing cosmetic work.')
    );
    expect(filled.industry).toBe('Therapy & wellness');
    expect(filled.goal).toBe(DEFAULT_GOAL);
    expect(filled.pageCount).toBe(DEFAULT_PAGE_COUNT);
    expect(filled.commerceMode).toBe(DEFAULT_COMMERCE_MODE);
  });

  it('never overwrites an answer the visitor actually gave', () => {
    const answered: DiscoveryData = {
      ...withDescription('A dental clinic in Cluj.'),
      industry: 'Coaching',
      goal: 'Grow an email list',
      pageCount: '8-15',
      commerceMode: 'digital',
    };
    expect(withQuickDefaults(answered)).toMatchObject({
      industry: 'Coaching',
      goal: 'Grow an email list',
      pageCount: '8-15',
      commerceMode: 'digital',
    });
  });

  it('leaves the industry blank when it cannot tell, rather than inventing one', () => {
    expect(withQuickDefaults(withDescription('We help people.')).industry).toBe(
      ''
    );
  });

  it('defaults the page count to "unsure", which is the honest value', () => {
    // Nobody has been asked. Picking '5-7' would look like an answer and would
    // quietly stop the Brief's real answer from being needed.
    expect(DEFAULT_PAGE_COUNT).toBe('unsure');
  });

  it('defaults commerce to none rather than guessing from the words', () => {
    // A site that grows a product row because the description said "products",
    // with no catalogue behind it, is the failure the sufficiency gate exists
    // to prevent.
    expect(
      withQuickDefaults(withDescription('We sell ceramics.')).commerceMode
    ).toBe('none');
  });

  it('is pure: the same data in gives the same data out', () => {
    const data = withDescription('A barber shop with four chairs.');
    expect(withQuickDefaults(data)).toEqual(withQuickDefaults(data));
  });
});

describe('guessedFields', () => {
  it('names everything that was derived rather than answered', () => {
    expect(guessedFields(EMPTY_DISCOVERY)).toEqual([
      'industry',
      'goal',
      'pageCount',
      'commerceMode',
    ]);
  });

  it('names nothing once the Brief has answered them', () => {
    expect(
      guessedFields({
        ...EMPTY_DISCOVERY,
        industry: 'Coaching',
        goal: 'Grow an email list',
        pageCount: '8-15',
        commerceMode: 'digital',
      })
    ).toEqual([]);
  });
});

describe('deriveBusinessName', () => {
  it("uses the Brief's own answer once it has one, over anything derivable", () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        businessName: 'Sable Fig Studio',
        fullName: 'Ana Pop',
        websiteUrl: 'https://not-sable-fig.example',
      })
    ).toBe('Sable Fig Studio');
  });

  it('derives a name from the website link, stripped of www and the TLD, title-cased', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'https://www.flowstarter.net',
      })
    ).toBe('Flowstarter');
  });

  it('splits a hyphenated domain into separate title-cased words', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'https://sable-fig.ro',
      })
    ).toBe('Sable Fig');
  });

  it('drops a generic two-label ccTLD whole, rather than leaving it in the name', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'https://acmebakery.co.uk',
      })
    ).toBe('Acmebakery');
  });

  it('derives from the string alone: a domain that cannot resolve derives just as well as one that can', () => {
    // No network call is made here — a DNS lookup on this host would time
    // out or NXDOMAIN, and the derivation must not care either way.
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'https://this-domain-should-never-resolve-9432.example',
      })
    ).toBe('This Domain Should Never Resolve 9432');
  });

  it('accepts a bare domain typed without a scheme', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'flowstarter.net',
      })
    ).toBe('Flowstarter');
  });

  it('falls back to the visitor’s own name for an Instagram or LinkedIn profile', () => {
    // A handle names a person, not a business: "@sablefig.official" is not
    // "Sablefig Official", and for a personal portfolio the business is the
    // person anyway.
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        instagramUrl: 'https://instagram.com/sablefig.official',
      })
    ).toBe('Ana Pop');
  });

  it('falls back to the visitor’s own name when the link does not parse as a URL at all', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'not a url',
      })
    ).toBe('Ana Pop');
  });

  it('falls back to the visitor’s own name with no business name and no link', () => {
    expect(
      deriveBusinessName({ ...EMPTY_DISCOVERY, fullName: 'Ana Pop' })
    ).toBe('Ana Pop');
  });

  it('is never empty when the visitor has given a full name', () => {
    expect(
      deriveBusinessName({ ...EMPTY_DISCOVERY, fullName: 'Ana' }).length
    ).toBeGreaterThan(0);
  });

  it('is empty for a draft nobody has started', () => {
    expect(deriveBusinessName(EMPTY_DISCOVERY)).toBe('');
  });
});
