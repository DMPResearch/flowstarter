import { describe, expect, it } from 'vitest';
import {
  applyPageSetToScaffold,
  CONTENT_PAGES,
  derivePageSet,
  describePageSet,
  dropYamlLinkEntries,
  findPageBudgetIssue,
  PAGE_BUDGET_EXCEEDED,
  pageBudget,
  pagePath,
  pageSlugForScaffoldPath,
  siteKindFor,
  topLevelSections,
} from '../src/flowstarter/page-set';
import type { TemplateScaffoldFile } from '../src/flowstarter/types';

const file = (path: string, content = ''): TemplateScaffoldFile => ({
  path,
  content,
  type: 'file',
});

/** The seven pages plus the case-study route every library template ships. */
const TEMPLATE_PAGES = [
  'src/pages/index.astro',
  'src/pages/work.astro',
  'src/pages/about.astro',
  'src/pages/services.astro',
  'src/pages/blog.astro',
  'src/pages/contact.astro',
  'src/pages/book.astro',
  'src/pages/case-studies/[slug].astro',
];

describe('pageBudget', () => {
  it('reads "Under 5" as four pages, which is what the visitor picked', () => {
    expect(pageBudget('lt-5')).toBe(4);
  });

  it('takes the top of the wider bands', () => {
    expect(pageBudget('5-7')).toBe(7);
    expect(pageBudget('8-15')).toBe(15);
    expect(pageBudget('15+')).toBe(24);
  });

  it('falls back to the library default when the question was skipped', () => {
    expect(pageBudget('unsure')).toBe(6);
    expect(pageBudget(null)).toBe(6);
    expect(pageBudget(undefined)).toBe(6);
    expect(pageBudget('four-ish')).toBe(6);
  });
});

describe('siteKindFor', () => {
  it('reads the creative chips and free text as a portfolio', () => {
    expect(siteKindFor('Creative & design')).toBe('portfolio');
    expect(siteKindFor('a product builder and designer')).toBe('portfolio');
    expect(siteKindFor('Photography')).toBe('portfolio');
  });

  it('defaults everything else to a service business', () => {
    expect(siteKindFor('Dental clinic')).toBe('services');
    expect(siteKindFor('Wellness and therapy')).toBe('services');
    expect(siteKindFor('Plumbing and heating')).toBe('services');
    expect(siteKindFor('')).toBe('services');
    expect(siteKindFor(null)).toBe('services');
  });
});

describe('derivePageSet', () => {
  it('gives the 2026-09-11 portfolio brief exactly the four pages it asked for', () => {
    const pageSet = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design — a product builder and designer',
      hasBookingLink: false,
    });
    expect(pageSet.kind).toBe('portfolio');
    expect(pageSet.budget).toBe(4);
    expect([...pageSet.content].sort()).toEqual([
      'about',
      'contact',
      'home',
      'work',
    ]);
    expect(pageSet.booking).toBe(false);
    expect(pageSet.dropped).toContain('book');
    expect(pageSet.dropped).toContain('blog');
    expect(pageSet.dropped).toContain('services');
  });

  it('keeps services before work for a service business on the same budget', () => {
    const pageSet = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Dental clinic',
      hasBookingLink: false,
    });
    expect(pageSet.content).toContain('services');
    expect(pageSet.content).not.toContain('work');
  });

  it('always keeps home and contact, whatever the budget', () => {
    for (const answer of ['lt-5', '5-7', '8-15', '15+', 'unsure', 'nonsense']) {
      const pageSet = derivePageSet({
        pageCount: answer,
        businessType: 'Anything',
        hasBookingLink: false,
      });
      expect(pageSet.content).toContain('home');
      expect(pageSet.content).toContain('contact');
    }
  });

  it('admits the booking page only with a validated link, and off budget', () => {
    const without = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design',
      hasBookingLink: false,
    });
    const with_ = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design',
      hasBookingLink: true,
    });

    expect(without.allowed).not.toContain('book');
    expect(with_.allowed).toContain('book');
    // The booking page costs no content page: the four the brief bought are
    // all still there.
    expect(with_.content).toEqual(without.content);
    expect(with_.dropped).not.toContain('book');
  });

  it('keeps every content page once the budget is wide enough', () => {
    const pageSet = derivePageSet({
      pageCount: '8-15',
      businessType: 'Dental clinic',
      hasBookingLink: true,
    });
    expect([...pageSet.content].sort()).toEqual([...CONTENT_PAGES].sort());
    expect(pageSet.dropped).toEqual([]);
  });
});

describe('pageSlugForScaffoldPath', () => {
  it('maps the index to home and named pages to themselves', () => {
    expect(pageSlugForScaffoldPath('src/pages/index.astro')).toBe('home');
    expect(pageSlugForScaffoldPath('src/pages/about.astro')).toBe('about');
    expect(pagePath('home')).toBe('src/pages/index.astro');
    expect(pagePath('about')).toBe('src/pages/about.astro');
  });

  it('folds case-study detail routes into the work section', () => {
    expect(pageSlugForScaffoldPath('src/pages/case-studies/[slug].astro')).toBe(
      'work',
    );
    expect(pageSlugForScaffoldPath('src/pages/case-studies/index.astro')).toBe(
      'work',
    );
  });

  it('ignores everything that is not a page', () => {
    expect(pageSlugForScaffoldPath('src/content/site-labels.md')).toBeNull();
    expect(pageSlugForScaffoldPath('public/images/hero.png')).toBeNull();
  });
});

describe('applyPageSetToScaffold', () => {
  const scaffold = [
    ...TEMPLATE_PAGES.map((path) => file(path, '<html></html>')),
    file('src/content/site-labels.md', NAV_YAML()),
    file('src/components/Header.astro', "const ctaHref = '/book';"),
    file('public/images/hero.png', 'AAAA'),
  ];

  it('removes the pages a four-page portfolio brief does not buy', () => {
    const pageSet = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design',
      hasBookingLink: false,
    });
    const pruned = applyPageSetToScaffold(scaffold, pageSet);
    const paths = pruned.files.map((entry) => entry.path);

    expect(paths).not.toContain('src/pages/book.astro');
    expect(paths).not.toContain('src/pages/blog.astro');
    expect(paths).not.toContain('src/pages/services.astro');
    expect(paths).toContain('src/pages/index.astro');
    expect(paths).toContain('src/pages/work.astro');
    expect(paths).toContain('src/pages/about.astro');
    expect(paths).toContain('src/pages/contact.astro');
    // Rule 4: case studies belong to work, so they survive with it.
    expect(paths).toContain('src/pages/case-studies/[slug].astro');
    expect(pruned.removedPaths).toContain('src/pages/book.astro');
  });

  it('takes the case-study route away with the work page', () => {
    const pageSet = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Dental clinic',
      hasBookingLink: false,
    });
    const pruned = applyPageSetToScaffold(scaffold, pageSet);
    expect(pruned.files.map((entry) => entry.path)).not.toContain(
      'src/pages/case-studies/[slug].astro',
    );
  });

  it('points a surviving book call to action at the contact page', () => {
    const pageSet = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design',
      hasBookingLink: false,
    });
    const pruned = applyPageSetToScaffold(scaffold, pageSet);
    const header = pruned.files.find(
      (entry) => entry.path === 'src/components/Header.astro',
    );
    expect(header?.content).toBe("const ctaHref = '/contact';");
    expect(pruned.rewrittenPaths).toContain('src/components/Header.astro');
  });

  it('removes nav entries pointing at pages that no longer exist', () => {
    const pageSet = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design',
      hasBookingLink: false,
    });
    const pruned = applyPageSetToScaffold(scaffold, pageSet);
    const labels = pruned.files.find(
      (entry) => entry.path === 'src/content/site-labels.md',
    );
    expect(labels?.content).toContain('href: "/work"');
    expect(labels?.content).toContain('href: "/contact"');
    expect(labels?.content).not.toContain('href: "/blog"');
    expect(labels?.content).not.toContain('href: "/services"');
    expect(labels?.content).not.toContain('href: "/book"');
    expect(labels?.content).not.toContain('Journal');
  });

  it('leaves binary entries alone', () => {
    const pageSet = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design',
      hasBookingLink: false,
    });
    const withBinary = [
      ...scaffold,
      {
        path: 'public/hero.png',
        content: 'Ym9vay8=',
        encoding: 'base64',
        type: 'file',
      } as TemplateScaffoldFile,
    ];
    const pruned = applyPageSetToScaffold(withBinary, pageSet);
    expect(
      pruned.files.find((entry) => entry.path === 'public/hero.png')?.content,
    ).toBe('Ym9vay8=');
  });

  it('changes nothing when the brief buys everything', () => {
    const pageSet = derivePageSet({
      pageCount: '8-15',
      businessType: 'Dental clinic',
      hasBookingLink: true,
    });
    const pruned = applyPageSetToScaffold(scaffold, pageSet);
    expect(pruned.removedPaths).toEqual([]);
    expect(pruned.rewrittenPaths).toEqual([]);
    expect(pruned.files).toEqual(scaffold);
  });
});

describe('dropYamlLinkEntries', () => {
  it('removes a whole multi-line entry, not just its href line', () => {
    const result = dropYamlLinkEntries(NAV_YAML(), new Set(['/blog']));
    expect(result).not.toContain('Journal');
    expect(result).not.toContain('href: "/blog"');
    expect(result).toContain('href: "/work"');
  });

  it('returns the text untouched when nothing is dropped', () => {
    const yaml = NAV_YAML();
    expect(dropYamlLinkEntries(yaml, new Set())).toBe(yaml);
    expect(dropYamlLinkEntries(yaml, new Set(['/nowhere']))).toBe(yaml);
  });
});

describe('topLevelSections', () => {
  it('counts a whole case-study section as the work page it belongs to', () => {
    expect(
      topLevelSections([
        'index.html',
        'work/index.html',
        'about/index.html',
        'contact/index.html',
        'case-studies/ionescu-dental/index.html',
        'case-studies/riverside-vet/index.html',
        '_astro/hero.css',
      ]),
    ).toEqual(['about', 'contact', 'home', 'work']);
  });

  it('reads a flat .html build the same way', () => {
    expect(topLevelSections(['index.html', 'about.html'])).toEqual([
      'about',
      'home',
    ]);
  });
});

describe('findPageBudgetIssue', () => {
  const pageSet = derivePageSet({
    pageCount: 'lt-5',
    businessType: 'Creative & design',
    hasBookingLink: false,
  });

  it('passes a build that matches the brief', () => {
    expect(
      findPageBudgetIssue(
        [
          'index.html',
          'work/index.html',
          'about/index.html',
          'contact/index.html',
          'case-studies/one/index.html',
        ],
        pageSet,
      ),
    ).toBeUndefined();
  });

  it('passes a build that came in under the budget', () => {
    expect(
      findPageBudgetIssue(['index.html', 'contact/index.html'], pageSet),
    ).toBeUndefined();
  });

  it('fails the seven-page build the four-page brief actually got', () => {
    const issue = findPageBudgetIssue(
      [
        'index.html',
        'work/index.html',
        'about/index.html',
        'services/index.html',
        'blog/index.html',
        'contact/index.html',
        'book/index.html',
        'case-studies/one/index.html',
      ],
      pageSet,
    );
    expect(issue).toBeDefined();
    expect(issue).toContain(PAGE_BUDGET_EXCEEDED);
    expect(issue).toContain('services');
    expect(issue).toContain('blog');
    expect(issue).toContain('book');
    expect(issue).toContain('no validated booking link');
  });

  it('does not blame the booking page when the workspace has a link', () => {
    const withLink = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design',
      hasBookingLink: true,
    });
    expect(
      findPageBudgetIssue(
        [
          'index.html',
          'work/index.html',
          'about/index.html',
          'contact/index.html',
          'book/index.html',
        ],
        withLink,
      ),
    ).toBeUndefined();
  });
});

describe('describePageSet', () => {
  it('states the rule the agent has to obey, including the booking clause', () => {
    const text = describePageSet(
      derivePageSet({
        pageCount: 'lt-5',
        businessType: 'Creative & design',
        hasBookingLink: false,
      }),
    );
    expect(text).toContain('Allowed top-level pages');
    expect(text).toContain('/contact');
    expect(text).toContain('no booking link');
    expect(text).toContain('Case-study detail pages');
  });

  it('says nothing about booking when the workspace has a link', () => {
    const text = describePageSet(
      derivePageSet({
        pageCount: '8-15',
        businessType: 'Dental clinic',
        hasBookingLink: true,
      }),
    );
    expect(text).not.toContain('no booking link');
  });
});

/** The nav shape every library template writes into site-labels.md. */
function NAV_YAML(): string {
  return [
    'header:',
    '  logo: "ATELIER VERSO"',
    '  navLinks:',
    '    - label: "Home"',
    '      href: "/"',
    '    - label: "Work"',
    '      href: "/work"',
    '    - label: "Studio"',
    '      href: "/about"',
    '    - label: "Services"',
    '      href: "/services"',
    '    - label: "Journal"',
    '      href: "/blog"',
    '    - label: "Contact"',
    '      href: "/contact"',
    '    - label: "Book a call"',
    '      href: "/book"',
    '',
  ].join('\n');
}
