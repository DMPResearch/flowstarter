/**
 * Which pages a brief is allowed to buy, decided by a rule rather than by a
 * model.
 *
 * Every template in the library ships the same seven pages — home, work,
 * about, services, blog, contact, book — plus a `case-studies/` detail route,
 * and until now nothing ever removed one. A client who answered "Under 5" on
 * the intake got all seven, and a client with no booking link got a `/book`
 * page promising a calendar that does not exist. Both defects have the same
 * shape: the scaffold decided the page set and nobody checked it against what
 * was asked for.
 *
 * This module is the rule. It is deterministic, it runs before the agent sees
 * the workspace, and it is also the gate the built output is measured against
 * afterwards.
 *
 * ## The rule, stated
 *
 * 1. **The brief's page-count answer sets a content-page budget.** "Under 5"
 *    is four pages, not four plus whatever the template happened to ship.
 * 2. **Home and contact always survive.** A site with no way to reach the
 *    business is not a smaller site, it is a broken one.
 * 3. **The business type sets the order the rest are kept in.** A portfolio
 *    keeps `work` before `services`; a service business keeps `services`
 *    before `work`. Blog is last in both: it is the page most often built and
 *    never written.
 * 4. **Case-study detail pages count as part of the work section, not as
 *    pages of their own.** `/work` plus twelve `/case-studies/<slug>` routes
 *    is one section against the budget. They exist only while `work` does.
 * 5. **The booking page exists if and only if a validated booking link is
 *    present**, and it does not consume the budget. It is a conversion
 *    endpoint the client configured on purpose, not editorial content. With
 *    no link the page is not emitted, nothing links to it, and every "book"
 *    call to action points at the contact page instead.
 */

import type { TemplateScaffoldFile } from './types';

/** The job fails with this when the built site outgrew its brief. */
export const PAGE_BUDGET_EXCEEDED = 'PAGE_BUDGET_EXCEEDED';

/** The wizard's own answers, as `intake-script.ts` stores them. */
export type PageCountAnswer = 'lt-5' | '5-7' | '8-15' | '15+' | 'unsure';

/**
 * Content pages each answer buys.
 *
 * "Under 5" means four: the visitor picked the smallest option on offer, and
 * reading it as "up to but not including five" is the only reading that
 * respects the answer. The wider bands take the top of the band, because a
 * client who said "8 - 15" is not surprised by fifteen.
 */
export const PAGE_BUDGETS: Readonly<Record<PageCountAnswer, number>> = {
  'lt-5': 4,
  '5-7': 7,
  '8-15': 15,
  '15+': 24,
  unsure: 6,
};

/** The answer when the question was skipped: the library's own default shape. */
export const DEFAULT_PAGE_BUDGET = PAGE_BUDGETS.unsure;

export type SiteKind = 'portfolio' | 'services';

/**
 * Niches whose site is a body of work first and an offer second. Matched on
 * the intake's own industry chip and free-text niche, so "Creative & design"
 * and "product builder and designer" both land here.
 */
const PORTFOLIO_SIGNALS =
  /\b(portfolio|creative|design|photograph|videograph|filmmak|illustrat|architect|artist|copywrit|writer|musician|maker)\w*/i;

/**
 * Priority order per site kind. Earlier survives a tighter budget.
 *
 * `home` and `contact` lead in both because rule 2 makes them unconditional;
 * listing them first means the budget arithmetic never has to special-case
 * them. `blog` is last in both: it is the page a small business builds and
 * then never writes.
 */
const CONTENT_PRIORITY: Readonly<Record<SiteKind, readonly string[]>> = {
  portfolio: ['home', 'contact', 'work', 'about', 'services', 'blog'],
  services: ['home', 'contact', 'services', 'about', 'work', 'blog'],
};

/** Every content page a library template can ship. */
export const CONTENT_PAGES: readonly string[] = [
  'home',
  'work',
  'about',
  'services',
  'blog',
  'contact',
];

/** The booking page, which rule 5 governs and the budget does not. */
export const BOOKING_PAGE = 'book';

/**
 * Detail routes that belong to a section rather than standing on their own.
 * `case-studies` is part of `work`: it ships with it and goes with it.
 */
export const SECTION_OWNERS: Readonly<Record<string, string>> = {
  'case-studies': 'work',
};

export interface PageSetInput {
  /** The intake's answer; anything unrecognised is treated as "unsure". */
  pageCount?: string | null;
  /** Industry chip and/or free-text niche, in either order. */
  businessType?: string | null;
  /** True only for a booking link that already passed its own validation. */
  hasBookingLink: boolean;
}

export interface PageSet {
  kind: SiteKind;
  /** Content pages this brief buys. Excludes the booking page by rule 5. */
  budget: number;
  /** Content pages kept, in priority order, `home` first. */
  content: readonly string[];
  /** Whether rule 5 admits a booking page. */
  booking: boolean;
  /** Everything the site may emit: content plus the booking page. */
  allowed: readonly string[];
  /** Library pages this brief does not buy. */
  dropped: readonly string[];
}

/** The answer, normalized; anything unrecognised is "unsure". */
export function normalizePageCount(
  answer: string | null | undefined,
): PageCountAnswer {
  const value = (answer ?? '').trim().toLowerCase();
  return value in PAGE_BUDGETS ? (value as PageCountAnswer) : 'unsure';
}

/** Content pages the brief's answer buys. */
export function pageBudget(answer: string | null | undefined): number {
  return PAGE_BUDGETS[normalizePageCount(answer)];
}

/** Rule 3: which order the optional pages are kept in. */
export function siteKindFor(businessType: string | null | undefined): SiteKind {
  return PORTFOLIO_SIGNALS.test(businessType ?? '') ? 'portfolio' : 'services';
}

/** The whole rule, applied. */
export function derivePageSet(input: PageSetInput): PageSet {
  const kind = siteKindFor(input.businessType);
  const budget = pageBudget(input.pageCount);
  const priority = CONTENT_PRIORITY[kind];

  const content = priority.slice(0, Math.max(2, budget));
  const booking = input.hasBookingLink;
  const allowed = booking ? [...content, BOOKING_PAGE] : [...content];
  const dropped = [...CONTENT_PAGES, BOOKING_PAGE].filter(
    (page) => !allowed.includes(page),
  );

  return { kind, budget, content, booking, allowed, dropped };
}

/** Scaffold path for a page slug. `home` is the index, the rest are named. */
export function pagePath(slug: string): string {
  return slug === 'home' ? 'src/pages/index.astro' : `src/pages/${slug}.astro`;
}

/**
 * The page slug a scaffold path belongs to, or null when the path is not a
 * page at all. A `case-studies/[slug].astro` route resolves to `work`, which
 * is rule 4 expressed once so both the pruner and the gate agree.
 */
export function pageSlugForScaffoldPath(path: string): string | null {
  const match = /^src\/pages\/(.+)$/.exec(path);
  if (!match) return null;
  const rest = match[1] as string;
  const segments = rest.split('/');
  if (segments.length > 1) {
    const section = segments[0] as string;
    return SECTION_OWNERS[section] ?? section;
  }
  const file = segments[0] as string;
  const name = file.replace(/\.(astro|md|mdx|html)$/i, '');
  return name === 'index' ? 'home' : name;
}

/**
 * A `- label: ... / href: ...` YAML entry, removed wholesale when its href
 * points at a page this brief does not buy.
 *
 * Nav, footer columns and hero call-to-action lists all use this one shape in
 * every library template, so one transform keeps all of them honest. Anything
 * that is not that shape is left exactly as it was.
 */
export function dropYamlLinkEntries(
  content: string,
  hrefs: ReadonlySet<string>,
): string {
  if (hrefs.size === 0) return content;
  const lines = content.split('\n');
  const kept: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const start = /^(\s*)-\s+\S/.exec(line);
    if (!start) {
      kept.push(line);
      continue;
    }
    const indent = (start[1] as string).length;
    // The entry runs until the next list item at the same indent or the next
    // line that dedents out of the list.
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end] as string;
      if (next.trim() === '') {
        end += 1;
        continue;
      }
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      end += 1;
    }
    const block = lines.slice(index, end);
    const href = block
      .map((entry) => /href:\s*"?([^"\s]+)"?\s*$/.exec(entry)?.[1])
      .find((value): value is string => typeof value === 'string');
    if (href && hrefs.has(href)) {
      index = end - 1;
      continue;
    }
    kept.push(...block);
    index = end - 1;
  }

  return kept.join('\n');
}

/** Files a link rewrite is allowed to touch. Never a binary, never a lockfile. */
const REWRITABLE = /\.(astro|md|mdx|html|ts|tsx|js|mjs|json|yaml|yml)$/i;

export interface PrunedScaffold {
  files: TemplateScaffoldFile[];
  /** Scaffold paths removed because the brief does not buy that page. */
  removedPaths: string[];
  /** Files whose links were rewritten away from a page that no longer exists. */
  rewrittenPaths: string[];
}

/**
 * Applies the page set to a template scaffold, before it is ever materialized.
 *
 * This is where rule 5 actually bites: with no booking link `src/pages/book.astro`
 * never reaches the workspace, so the agent cannot personalize a page that
 * should not exist and the build cannot emit one. Every `/book` link left
 * behind is rewritten to `/contact`, and every nav or footer entry pointing at
 * a dropped page is removed rather than left to 404.
 */
export function applyPageSetToScaffold(
  files: readonly TemplateScaffoldFile[],
  pageSet: PageSet,
): PrunedScaffold {
  const removedPaths: string[] = [];
  const rewrittenPaths: string[] = [];

  const kept = files.filter((file) => {
    const slug = pageSlugForScaffoldPath(file.path);
    if (slug === null) return true;
    if (pageSet.allowed.includes(slug)) return true;
    removedPaths.push(file.path);
    return false;
  });

  const droppedHrefs = new Set<string>();
  const addHref = (slug: string): void => {
    droppedHrefs.add(`/${slug}`);
    droppedHrefs.add(`/${slug}/`);
  };
  for (const slug of pageSet.dropped) addHref(slug);
  // A section route goes when the page that owns it goes: with no /work there
  // is nothing for a /case-studies link to be a detail of.
  for (const [section, owner] of Object.entries(SECTION_OWNERS)) {
    if (!pageSet.allowed.includes(owner)) addHref(section);
  }

  if (droppedHrefs.size === 0) {
    return { files: kept, removedPaths, rewrittenPaths };
  }

  const rewritten = kept.map((file) => {
    if (file.encoding === 'base64') return file;
    if (!REWRITABLE.test(file.path)) return file;

    let content = dropYamlLinkEntries(file.content, droppedHrefs);
    // A "book" call to action that survived in component source points at the
    // contact page: the visitor still lands somewhere they can reach a person.
    if (!pageSet.booking) {
      content = content.replace(/(['"])\/book(\/?)\1/g, '$1/contact$1');
      content = content.replace(/href="\/book\/?"/g, 'href="/contact"');
    }
    if (content === file.content) return file;
    rewrittenPaths.push(file.path);
    return { ...file, content };
  });

  return { files: rewritten, removedPaths, rewrittenPaths };
}

/**
 * The top-level sections a built site actually serves, from the relative paths
 * of its output directory.
 *
 * Rule 4 is applied here: `case-studies/anything/index.html` reports as the
 * `work` section it belongs to, so a portfolio with twelve case studies reads
 * as one section and not as thirteen pages.
 */
export function topLevelSections(paths: readonly string[]): string[] {
  const sections = new Set<string>();
  for (const path of paths) {
    const clean = path.replace(/^\.?\//, '');
    if (!/\.html?$/i.test(clean)) continue;
    const segments = clean.split('/');
    if (segments.length === 1) {
      const name = (segments[0] as string).replace(/\.html?$/i, '');
      sections.add(name === 'index' ? 'home' : name);
      continue;
    }
    const head = segments[0] as string;
    sections.add(SECTION_OWNERS[head] ?? head);
  }
  return Array.from(sections).sort();
}

/**
 * The gate. Returns undefined when the built site matches the brief, and an
 * operator- and agent-readable sentence naming the offending sections when it
 * does not.
 *
 * A site that is *smaller* than its budget is not a failure: a four-page brief
 * answered with three good pages is a judgement call the agent is allowed to
 * make. Only overshooting is a defect, because overshooting is what the client
 * did not ask for and did not pay for.
 */
export function findPageBudgetIssue(
  builtPaths: readonly string[],
  pageSet: PageSet,
): string | undefined {
  const sections = topLevelSections(builtPaths);
  const extra = sections.filter(
    (section) => !pageSet.allowed.includes(section),
  );
  if (extra.length === 0) return undefined;

  const bookingExtra = extra.includes(BOOKING_PAGE) && !pageSet.booking;
  const reason = bookingExtra
    ? 'The workspace has no validated booking link, so there must be no booking page and every "book" call to action must point at /contact. '
    : '';

  return (
    `${PAGE_BUDGET_EXCEEDED}: the brief buys ${pageSet.budget} content ` +
    `page${pageSet.budget === 1 ? '' : 's'} (${pageSet.allowed.join(', ')}) and ` +
    `the build emitted ${sections.length} top-level section${sections.length === 1 ? '' : 's'} ` +
    `(${sections.join(', ')}). ${reason}Remove: ${extra.join(', ')}. ` +
    'Case-study detail pages under /work count as part of the work section, not as pages of their own.'
  );
}

/** The page set, phrased for a coding prompt. Rules decide; this only says so. */
export function describePageSet(pageSet: PageSet): string {
  const lines = [
    `Allowed top-level pages, and no others: ${pageSet.allowed.join(', ')}.`,
    `Do not create a page that is not on that list. The brief buys ${pageSet.budget} content pages.`,
    'Case-study detail pages under the work section belong to that section and are not extra pages.',
  ];
  if (!pageSet.booking) {
    lines.push(
      'This workspace has no booking link. Do not create a booking page, do not link to /book, and point every "book a call" action at /contact.',
    );
  }
  if (pageSet.dropped.length > 0) {
    lines.push(
      `These pages were deliberately removed from the scaffold and must not come back: ${pageSet.dropped.join(', ')}.`,
    );
  }
  return lines.join(' ');
}
