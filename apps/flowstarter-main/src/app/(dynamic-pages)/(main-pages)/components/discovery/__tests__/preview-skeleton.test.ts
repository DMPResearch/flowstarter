/**
 * The derived preview.
 *
 * The behaviour worth protecting is the mapping itself: which answers change
 * the skeleton's shape, and how. It is pure, so none of this needs a DOM --
 * which is the point of keeping the rules out of the component. A skeleton
 * that disagreed with itself between two renders, or that needed a model to
 * decide what a bakery's site has on it, would be the regression.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_DISCOVERY, type DiscoveryData } from '../discovery.logic';
import { derivePreviewSkeleton, sellsCatalogue } from '../preview-skeleton';

function data(overrides: Partial<DiscoveryData> = {}): DiscoveryData {
  return { ...EMPTY_DISCOVERY, ...overrides };
}

describe('derivePreviewSkeleton', () => {
  describe('with nothing answered', () => {
    const skeleton = derivePreviewSkeleton(data());

    it('is unnamed rather than inventing a business', () => {
      expect(skeleton.siteName).toBe('');
      expect(skeleton.named).toBe(false);
    });

    it('counts no facts as known', () => {
      expect(skeleton.answeredCount).toBe(0);
      expect(skeleton.facts.every((fact) => fact.value === '')).toBe(true);
    });

    it('still lists all four facts, so the list cannot jump as it fills', () => {
      expect(skeleton.facts.map((fact) => fact.id)).toEqual([
        'fullName',
        'businessName',
        'brandTone',
        'pageCount',
      ]);
    });

    it('falls back to the generic section set', () => {
      expect(skeleton.sections).toEqual([
        'hero',
        'services',
        'about',
        'testimonials',
        'contact',
      ]);
    });

    it('has no product row and a middling nav', () => {
      expect(skeleton.hasProductRow).toBe(false);
      expect(skeleton.navCount).toBe(4);
      expect(skeleton.cardCount).toBe(3);
    });

    it('uses the neutral type weight and radius', () => {
      expect(skeleton.weight).toBe('regular');
      expect(skeleton.radius).toBe('soft');
    });
  });

  describe('the business name', () => {
    it('lands on the skeleton as soon as it is given', () => {
      const skeleton = derivePreviewSkeleton(
        data({ businessName: 'Sable Fig' })
      );
      expect(skeleton.siteName).toBe('Sable Fig');
      expect(skeleton.named).toBe(true);
    });

    it('ignores a name that is only whitespace', () => {
      expect(derivePreviewSkeleton(data({ businessName: '   ' })).named).toBe(
        false
      );
    });
  });

  describe('the industry answer picks the section set', () => {
    it('gives a restaurant a menu instead of a services row', () => {
      const sections = derivePreviewSkeleton(
        data({ industry: 'Hospitality & food' })
      ).sections;
      expect(sections).toContain('menu');
      expect(sections).not.toContain('services');
    });

    it('gives a photographer a work band', () => {
      const sections = derivePreviewSkeleton(
        data({ industry: 'Photography' })
      ).sections;
      expect(sections).toContain('work');
      expect(sections).not.toContain('services');
    });

    it('gives a clinic a booking band', () => {
      const sections = derivePreviewSkeleton(
        data({ industry: 'Therapy & wellness' })
      ).sections;
      expect(sections).toContain('booking');
      expect(sections).toContain('services');
    });

    it('matches words the chips do not cover', () => {
      // Typed, not tapped: "none of them" is a first-class answer here.
      const sections = derivePreviewSkeleton(
        data({ industry: 'wine bar and small plates' })
      ).sections;
      expect(sections).toContain('menu');
    });

    it('falls back to the generic set for an industry it cannot place', () => {
      const sections = derivePreviewSkeleton(
        data({ industry: 'marine survey work' })
      ).sections;
      expect(sections).toEqual([
        'hero',
        'services',
        'about',
        'testimonials',
        'contact',
      ]);
    });
  });

  describe('the commerce answer adds a product row', () => {
    it.each(['digital', 'physical', 'mixed'] as const)(
      'adds one for %s',
      (commerceMode) => {
        const skeleton = derivePreviewSkeleton(data({ commerceMode }));
        expect(skeleton.hasProductRow).toBe(true);
        expect(skeleton.sections).toContain('products');
      }
    );

    it.each(['none', 'few-services'] as const)(
      'adds none for %s',
      (commerceMode) => {
        const skeleton = derivePreviewSkeleton(data({ commerceMode }));
        expect(skeleton.hasProductRow).toBe(false);
        expect(skeleton.sections).not.toContain('products');
      }
    );

    it('puts the products band directly under the opening', () => {
      const sections = derivePreviewSkeleton(
        data({ commerceMode: 'physical' })
      ).sections;
      expect(sections.slice(0, 2)).toEqual(['hero', 'products']);
    });

    it('does not double the band when the industry already had one', () => {
      const sections = derivePreviewSkeleton(
        data({ industry: 'Online store / ecommerce', commerceMode: 'physical' })
      ).sections;
      expect(sections.filter((id) => id === 'products')).toHaveLength(1);
    });
  });

  describe('the tone answer sets the type weight and radius', () => {
    it.each([
      ['Bold, Confident', 'bold', 'sharp'],
      ['Minimal', 'light', 'sharp'],
      ['Premium / elegant', 'light', 'soft'],
      ['Playful, Friendly', 'regular', 'round'],
    ] as const)('reads %s as %s / %s', (brandTone, weight, radius) => {
      const skeleton = derivePreviewSkeleton(data({ brandTone }));
      expect(skeleton.weight).toBe(weight);
      expect(skeleton.radius).toBe(radius);
    });

    it('takes the stronger signal when two rules could match', () => {
      // "Bold" is not a word anyone taps by accident; "Friendly" is.
      const skeleton = derivePreviewSkeleton(
        data({ brandTone: 'Friendly, Bold' })
      );
      expect(skeleton.weight).toBe('bold');
    });
  });

  describe('the page count sizes the nav and the card row', () => {
    it.each([
      ['lt-5', 3, 2],
      ['5-7', 5, 3],
      ['8-15', 6, 4],
      ['15+', 7, 6],
      ['unsure', 4, 3],
    ] as const)(
      'reads %s as %i nav items and %i cards',
      (pageCount, navCount, cardCount) => {
        const skeleton = derivePreviewSkeleton(data({ pageCount }));
        expect(skeleton.navCount).toBe(navCount);
        expect(skeleton.cardCount).toBe(cardCount);
      }
    );
  });

  describe('the fact list', () => {
    it('fills as the answers land', () => {
      const skeleton = derivePreviewSkeleton(
        data({
          fullName: 'Ana',
          businessName: 'Sable Fig',
          brandTone: 'Calm, Warm',
          pageCount: '5-7',
        })
      );
      expect(skeleton.answeredCount).toBe(4);
      expect(skeleton.facts.map((fact) => fact.value)).toEqual([
        'Ana',
        'Sable Fig',
        'Calm, Warm',
        '5-7',
      ]);
    });

    it('counts only the answers actually given', () => {
      const skeleton = derivePreviewSkeleton(
        data({ fullName: 'Ana', businessName: 'Sable Fig' })
      );
      expect(skeleton.answeredCount).toBe(2);
    });

    it('carries a question id the conversation can be sent back to', () => {
      const skeleton = derivePreviewSkeleton(data());
      expect(skeleton.facts.map((fact) => fact.id)).toEqual([
        'fullName',
        'businessName',
        'brandTone',
        'pageCount',
      ]);
    });
  });

  it('is pure: the same answers give the same skeleton', () => {
    const answers = data({
      businessName: 'Sable Fig',
      industry: 'Hospitality & food',
      brandTone: 'Warm',
      pageCount: '5-7',
      commerceMode: 'physical',
    });
    expect(derivePreviewSkeleton(answers)).toEqual(
      derivePreviewSkeleton(answers)
    );
  });
});

describe('sellsCatalogue', () => {
  it('is true only for the modes that mean a real catalogue', () => {
    expect(sellsCatalogue('physical')).toBe(true);
    expect(sellsCatalogue('digital')).toBe(true);
    expect(sellsCatalogue('mixed')).toBe(true);
    expect(sellsCatalogue('few-services')).toBe(false);
    expect(sellsCatalogue('none')).toBe(false);
    expect(sellsCatalogue('')).toBe(false);
  });
});
