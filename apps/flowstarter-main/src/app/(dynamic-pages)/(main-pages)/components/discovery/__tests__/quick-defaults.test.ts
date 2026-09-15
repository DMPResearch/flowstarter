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

import {
  EMPTY_DISCOVERY,
  recommendTier,
  type DiscoveryData,
} from '../discovery.logic';
import {
  DEFAULT_COMMERCE_MODE,
  DEFAULT_GOAL,
  DEFAULT_PAGE_COUNT,
  MAX_DESCRIPTION_NAME_WORDS,
  businessNameFromDescription,
  deriveBusinessName,
  isUnderivableBusinessName,
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

  describe('selectedTier', () => {
    // Regression (R2/R3 of the PR #108 fallout): step 6, the tier
    // confirmation, comes after the preview, so every quick-intake visitor
    // reaches the claim/checkout buttons with `selectedTier: ''`. A required
    // tier enum 400'd the guest deposit checkout; an absent one left the
    // signed-in claim's quote -- and `/unlock`'s Pay button -- null. Both are
    // fixed by never letting `selectedTier` leave this function blank.
    it('fills it from the recommendation when the visitor never confirmed one', () => {
      // No commerce/page-count signal at all -> the rule's own default.
      expect(withQuickDefaults(EMPTY_DISCOVERY).selectedTier).toBe(
        recommendTier(withQuickDefaults(EMPTY_DISCOVERY)).tier
      );
      expect(withQuickDefaults(EMPTY_DISCOVERY).selectedTier).toBe('starter');
    });

    it('recommends from the OTHER derived fields, not the blank originals', () => {
      // A large physical catalogue recommends Commerce -- but only once
      // `commerceMode`/`catalogSize` have real values, which for a
      // quick-intake visitor only `withQuickDefaults` itself has just
      // supplied. Recommending off the pre-fill blanks would silently
      // undersell a business that plainly sells things.
      const sellsALot: DiscoveryData = {
        ...EMPTY_DISCOVERY,
        commerceMode: 'physical',
        catalogSize: '26-100',
      };
      expect(withQuickDefaults(sellsALot).selectedTier).toBe('commerce');
    });

    it('never overwrites a tier the visitor actually confirmed', () => {
      const confirmed: DiscoveryData = {
        ...EMPTY_DISCOVERY,
        selectedTier: 'custom',
      };
      expect(withQuickDefaults(confirmed).selectedTier).toBe('custom');
    });
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

describe('businessNameFromDescription', () => {
  it('reads the leading name before a comma', () => {
    expect(
      businessNameFromDescription('Arome Coffee, a specialty roastery in Cluj')
    ).toBe('Arome Coffee');
  });

  it('reads the leading name before " is "', () => {
    expect(
      businessNameFromDescription('Sable Fig is a design studio in Iasi')
    ).toBe('Sable Fig');
  });

  it('reads the leading name before the Romanian "este"', () => {
    expect(
      businessNameFromDescription(
        'Cafeneaua Arome este o cafenea de specialitate din Cluj'
      )
    ).toBe('Cafeneaua Arome');
  });

  it('reads the leading name before a spaced hyphen', () => {
    expect(
      businessNameFromDescription('Arome Coffee - specialty roastery')
    ).toBe('Arome Coffee');
  });

  it('reads the leading name before an em dash', () => {
    expect(
      businessNameFromDescription('Arome Coffee — specialty roastery')
    ).toBe('Arome Coffee');
  });

  it('does not split a hyphenated word that is not a separator', () => {
    expect(
      businessNameFromDescription('Well-Fed Kitchen is our family restaurant')
    ).toBe('Well-Fed Kitchen');
  });

  it('refuses "I am", which describes the speaker, not the business', () => {
    expect(businessNameFromDescription('I am a brand designer')).toBe('');
  });

  it('refuses "We are"', () => {
    expect(businessNameFromDescription('We are a two-person bakery')).toBe('');
  });

  it('refuses a leading bare "A", without catching a real name that starts with the same letter', () => {
    expect(businessNameFromDescription('A cozy neighbourhood cafe')).toBe('');
    expect(
      businessNameFromDescription('Arome Coffee, a specialty roastery')
    ).toBe('Arome Coffee');
  });

  it('refuses the Romanian "Sunt" and "Suntem"', () => {
    expect(
      businessNameFromDescription('Sunt un antrenor personal, ajut oameni')
    ).toBe('');
    expect(
      businessNameFromDescription(
        'Suntem o brutarie de cartier, deschisa zilnic'
      )
    ).toBe('');
  });

  it('declines a leading phrase longer than the cap, rather than truncating it into a fake name', () => {
    expect(MAX_DESCRIPTION_NAME_WORDS).toBe(5);
    expect(
      businessNameFromDescription(
        'A boutique dental clinic in Cluj doing cosmetic work'
      )
    ).toBe('');
    // No delimiter at all: the whole sentence is the leading phrase, and it
    // is not a name either.
    expect(
      businessNameFromDescription(
        'We help small businesses grow their online presence'
      )
    ).toBe('');
  });

  it('declines when there is nothing to read', () => {
    expect(businessNameFromDescription('')).toBe('');
    expect(businessNameFromDescription('   ')).toBe('');
  });

  it('is case insensitive about the openers it refuses', () => {
    expect(businessNameFromDescription('WE ARE a bakery')).toBe('');
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
        websiteIsOwnSite: 'yes',
      })
    ).toBe('Sable Fig Studio');
  });

  // The real incident this rule was rewritten to close: a visitor named
  // their business in the "what you do" answer and pasted a competitor's
  // site as a reference, not their own. The old rule trusted every pasted
  // website as "theirs" and named the workspace, and the generated site,
  // after that competitor's trademark instead.
  it('the Onyx case: derives the stated name over an unconfirmed reference website', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Andrei Ionescu',
        description: 'Arome Coffee, a specialty roastery in Cluj',
        websiteUrl: 'https://onyxcoffeelab.com',
        // No `websiteIsOwnSite` answer: the reference was never confirmed as
        // theirs, which on its own is already enough to keep the hostname
        // out of the name.
      })
    ).toBe('Arome Coffee');
  });

  it('prefers a name stated in the description over the website hostname, even when the site is confirmed as their own', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        description: 'Sable Fig, a design studio in Iasi',
        websiteUrl: 'https://totally-different-domain.example',
        websiteIsOwnSite: 'yes',
      })
    ).toBe('Sable Fig');
  });

  it('derives a name from the website link once it is confirmed as their own, stripped of www and the TLD, title-cased', () => {
    // Deliberately not `flowstarter.net`, which this rule now refuses to
    // derive from at all. See the platform-name test below.
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'https://www.sablefig.net',
        websiteIsOwnSite: 'yes',
      })
    ).toBe('Sablefig');
  });

  it("refuses to derive this platform's own name, however the string arrives", () => {
    // The incident. A portfolio shipped under the name "Flowstarter", which
    // is us: the visitor had described their work by mentioning the tool they
    // build with, the description extractor read a business name out of it,
    // and nothing asked whether the name a rule had just produced was our
    // own. It is refused from both derivations, and the fallback is the
    // client's own name, which is always safer than our brand on their site.
    expect(isUnderivableBusinessName('Flowstarter')).toBe(true);
    expect(isUnderivableBusinessName('  flowstarter  ')).toBe(true);
    expect(isUnderivableBusinessName('Flowstarter Studio')).toBe(false);

    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        description: 'Flowstarter, the thing I build client sites with',
      })
    ).toBe('Ana Pop');

    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'https://www.flowstarter.net',
        websiteIsOwnSite: 'yes',
      })
    ).toBe('Ana Pop');

    // A client who actually trades under it may still say so on the brief,
    // and that answer is honoured: this list rejects derived names only.
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        businessName: 'Flowstarter',
      })
    ).toBe('Flowstarter');
  });

  it('never reads the hostname when ownership was not confirmed, even with no name stated', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'https://www.flowstarter.net',
        websiteIsOwnSite: 'no',
      })
    ).toBe('Ana Pop');
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'https://www.flowstarter.net',
        // Unanswered — the default, and the default is "no".
      })
    ).toBe('Ana Pop');
  });

  it('splits a hyphenated domain into separate title-cased words', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'https://sable-fig.ro',
        websiteIsOwnSite: 'yes',
      })
    ).toBe('Sable Fig');
  });

  it('drops a generic two-label ccTLD whole, rather than leaving it in the name', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'https://acmebakery.co.uk',
        websiteIsOwnSite: 'yes',
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
        websiteIsOwnSite: 'yes',
      })
    ).toBe('This Domain Should Never Resolve 9432');
  });

  it('accepts a bare domain typed without a scheme', () => {
    expect(
      deriveBusinessName({
        ...EMPTY_DISCOVERY,
        fullName: 'Ana Pop',
        websiteUrl: 'sablefig.net',
        websiteIsOwnSite: 'yes',
      })
    ).toBe('Sablefig');
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
        websiteIsOwnSite: 'yes',
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
