/**
 * Rules 7 and 8 of the page set: deriving the page set from the brief, and
 * whose page count wins.
 *
 * The case that forced these rules is the first test below. On 2026-09-12 a
 * four-page portfolio brief - a real one, Darius's own - was handed a
 * six-page budget and told to fill a services page and a blog. The chain was:
 * the four-question intake stopped asking a page count, `quick-defaults.ts`
 * wrote `'unsure'` on every quick intake, `'unsure'` bought six pages, and the
 * one place a brief's own answer could have won was gated on the intake's
 * being falsy, which it never is.
 */
import { describe, expect, it } from 'vitest';
import {
  briefAsksForBlog,
  derivePageSet,
  deriveBriefPages,
  offerDescribesDistinctServices,
  pageCountAnswerFor,
  resolvePageCountAnswer,
} from '../src/flowstarter/page-set';

describe('rule 7: the page set comes from the brief', () => {
  it('gives the 2026-09-12 portfolio brief four pages, not six', () => {
    const pageSet = derivePageSet({
      // Exactly what the funnel had: the default nobody was asked for.
      pageCount: 'unsure',
      businessType:
        'I build websites with AI agents, supervised by people. Founder of ' +
        'Flowstarter, an AI-driven website studio.',
      description:
        'I work with founders and small business owners who need a site ' +
        'that earns trust',
      offer: 'I build websites with AI agents, supervised by people.',
      hasBookingLink: false,
      projectCount: 3,
    });
    expect(pageSet.answer).toBe('lt-5');
    expect(pageSet.budget).toBe(4);
    expect([...pageSet.content].sort()).toEqual([
      'about',
      'contact',
      'home',
      'work',
    ]);
    // The two pages the run would have invented subject matter for.
    expect(pageSet.dropped).toContain('services');
    expect(pageSet.dropped).toContain('blog');
  });

  it('buys a services page instead of a work page when there is no work', () => {
    const pages = deriveBriefPages({
      businessType: 'Accounting practice',
      offer: 'Bookkeeping\nVAT returns\nPayroll',
      projectCount: 0,
    });
    expect(pages).toContain('services');
    expect(pages).not.toContain('work');
    expect([...pages].sort()).toEqual(['about', 'contact', 'home', 'services']);
  });

  it('buys both when the brief has real projects and a list of services', () => {
    const pages = deriveBriefPages({
      businessType: 'Accounting practice',
      offer: 'Bookkeeping\nVAT returns\nPayroll',
      projectCount: 2,
    });
    expect(pages).toContain('work');
    expect(pages).toContain('services');
    // Rule 6 still sets the order: real projects come before the about page.
    expect(pages.indexOf('work')).toBeLessThan(pages.indexOf('about'));
  });

  it('falls back on the site kind when the brief was never asked', () => {
    const portfolio = deriveBriefPages({
      businessType: 'Creative & design',
      projectCount: null,
    });
    expect(portfolio).toContain('work');
    expect(portfolio).not.toContain('services');

    const services = deriveBriefPages({
      businessType: 'Dental clinic',
      projectCount: null,
    });
    expect(services).toContain('services');
    expect(services).not.toContain('work');
  });

  it('never drops home, contact or about', () => {
    for (const projectCount of [null, 0, 1, 9]) {
      const pages = deriveBriefPages({
        businessType: 'Anything at all',
        offer: '',
        projectCount,
      });
      expect(pages).toContain('home');
      expect(pages).toContain('contact');
      expect(pages).toContain('about');
    }
  });
});

describe('rule 7: a services page is earned by a list, not by prose', () => {
  it('reads a sentence with a comma in it as one thing, not two services', () => {
    expect(
      offerDescribesDistinctServices(
        'I build websites with AI agents, supervised by people',
      ),
    ).toBe(false);
  });

  it('reads newlines, bullets, numbers and semicolons as a list', () => {
    expect(offerDescribesDistinctServices('Bookkeeping\nVAT returns')).toBe(
      true,
    );
    expect(
      offerDescribesDistinctServices('- Brand design\n- Web design\n- Print'),
    ).toBe(true);
    expect(offerDescribesDistinctServices('1. Strategy 2. Design')).toBe(true);
    expect(offerDescribesDistinctServices('Tax advice; audits; payroll')).toBe(
      true,
    );
  });

  it('ignores a list whose entries are paragraphs rather than offerings', () => {
    const paragraphs = [
      'I have spent the last eleven years helping small practices in the ' +
        'north of the county keep their books straight and their filings on ' +
        'time, which is mostly a matter of turning up',
      'Every client gets the same thing from me, which is somebody who reads ' +
        'the letters from HMRC before they become a problem and says so ' +
        'plainly when something needs doing',
    ].join('\n');
    expect(offerDescribesDistinctServices(paragraphs)).toBe(false);
  });

  it('says no to nothing at all', () => {
    expect(offerDescribesDistinctServices('')).toBe(false);
    expect(offerDescribesDistinctServices(null)).toBe(false);
    expect(offerDescribesDistinctServices(undefined)).toBe(false);
    expect(offerDescribesDistinctServices('Bookkeeping')).toBe(false);
  });
});

describe('rule 7: a blog is bought only when it is asked for', () => {
  it('buys one when the brief says so', () => {
    expect(briefAsksForBlog('I want a blog for case notes')).toBe(true);
    expect(briefAsksForBlog(null, 'and a monthly newsletter')).toBe(true);
    expect(briefAsksForBlog('somewhere to publish articles')).toBe(true);
    expect(
      deriveBriefPages({
        businessType: 'Dental clinic',
        offer: 'Cleanings\nWhitening',
        description: 'We would like a blog as well',
        projectCount: 0,
      }),
    ).toContain('blog');
  });

  it('does not buy one otherwise', () => {
    expect(briefAsksForBlog('I build websites for founders')).toBe(false);
    expect(briefAsksForBlog()).toBe(false);
    expect(
      deriveBriefPages({
        businessType: 'Dental clinic',
        offer: 'Cleanings\nWhitening',
        projectCount: 0,
      }),
    ).not.toContain('blog');
  });
});

describe('rule 7: the derived count', () => {
  it('picks the narrowest answer that still buys every derived page', () => {
    expect(pageCountAnswerFor(1)).toBe('lt-5');
    expect(pageCountAnswerFor(4)).toBe('lt-5');
    expect(pageCountAnswerFor(5)).toBe('5-7');
    expect(pageCountAnswerFor(7)).toBe('5-7');
    expect(pageCountAnswerFor(8)).toBe('8-15');
    expect(pageCountAnswerFor(16)).toBe('15+');
    expect(pageCountAnswerFor(999)).toBe('15+');
  });
});

describe('rule 8: whose page count wins', () => {
  it("takes the brief's answer over everything", () => {
    expect(
      resolvePageCountAnswer({
        briefPageCount: '8-15',
        derivedPageCount: 'lt-5',
        intakePageCount: '5-7',
      }),
    ).toBe('8-15');
  });

  it("takes the intake's real answer over a derivation", () => {
    expect(
      resolvePageCountAnswer({
        derivedPageCount: 'lt-5',
        intakePageCount: '5-7',
      }),
    ).toBe('5-7');
  });

  it("takes the derivation over the quick intake's 'unsure' default", () => {
    expect(
      resolvePageCountAnswer({
        briefPageCount: 'unsure',
        derivedPageCount: 'lt-5',
        intakePageCount: 'unsure',
      }),
    ).toBe('lt-5');
  });

  it("falls back to 'unsure' when nobody has an opinion", () => {
    expect(resolvePageCountAnswer({})).toBe('unsure');
    expect(
      resolvePageCountAnswer({
        briefPageCount: 'nonsense',
        intakePageCount: '   ',
      }),
    ).toBe('unsure');
  });

  it('lets the client widen a brief that derived four pages', () => {
    const narrow = derivePageSet({
      pageCount: 'unsure',
      businessType: 'Creative & design',
      offer: 'I design brands.',
      hasBookingLink: false,
      projectCount: 2,
    });
    const widened = derivePageSet({
      pageCount: 'unsure',
      briefPageCount: '5-7',
      businessType: 'Creative & design',
      offer: 'I design brands.',
      hasBookingLink: false,
      projectCount: 2,
    });
    expect(narrow.content).toHaveLength(4);
    expect(widened.budget).toBe(7);
    // Everything the derivation earned is still there, and the pages the
    // client paid extra for are appended in priority order.
    for (const page of narrow.content) expect(widened.content).toContain(page);
    expect(widened.content.length).toBeGreaterThan(narrow.content.length);
  });

  it('reports the derived set alongside the budget it was measured against', () => {
    const pageSet = derivePageSet({
      pageCount: 'unsure',
      businessType: 'Creative & design',
      offer: 'I design brands.',
      hasBookingLink: false,
      projectCount: 2,
    });
    expect(pageSet.derived).toEqual(pageSet.content);
    expect(pageSet.answer).toBe('lt-5');
  });
});
