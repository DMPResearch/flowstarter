import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPageSetToScaffold,
  derivePageSet,
} from '../src/flowstarter/page-set';
import { findPlaceholderCopyInFiles } from '../src/flowstarter/placeholder-copy';
import { injectCalCom, normalizeCalLink } from '../src/integrations';
import type { TemplateScaffoldFile } from '../src/flowstarter/types';

/**
 * Rule 5 of the page set, end to end against the real library.
 *
 * The defect this covers: a client who skipped the booking question got a
 * `/book` page promising a calendar, and the workspace had no link to put in
 * it. The rule is now mechanical and this asserts both halves of it — the
 * page exists with a link, and does not exist without one — on the files the
 * generator actually ships rather than on a fixture.
 */

const TEMPLATES = join(
  __dirname,
  '..',
  '..',
  '..',
  'apps',
  'flowstarter-templates',
);
const SLUGS = [
  'creative-portfolio',
  'dorin-portfolio',
  'local-trade',
  'professional-services',
  'wellness-therapy',
];

/** The real template, read off disk as the scaffold the pipeline would get. */
async function scaffoldFor(slug: string): Promise<TemplateScaffoldFile[]> {
  const paths = [
    'src/pages/index.astro',
    'src/pages/work.astro',
    'src/pages/about.astro',
    'src/pages/services.astro',
    'src/pages/blog.astro',
    'src/pages/contact.astro',
    'src/pages/book.astro',
    'src/content/site-labels.md',
    'src/components/Header.astro',
  ];
  const files: TemplateScaffoldFile[] = [];
  for (const path of paths) {
    const content = await readFile(join(TEMPLATES, slug, path), 'utf8').catch(
      () => null,
    );
    if (content !== null) files.push({ path, content, type: 'file' });
  }
  return files;
}

/** Anything that would render a booking affordance to a visitor. */
function bookingMarkup(files: readonly TemplateScaffoldFile[]): string[] {
  return files
    .filter((file) =>
      /\/book["'\s]|href="\/book|data-flowstarter-cal|cal\.com\/|calendly\.com\//i.test(
        file.content,
      ),
    )
    .map((file) => file.path);
}

describe('a workspace with a validated Cal.com link', () => {
  it('keeps the booking page and renders the tenant embed in it', async () => {
    const link = 'https://cal.com/darius/intro';
    // The same gate the worker's job store applies before it adds the
    // integration to the job.
    expect(normalizeCalLink(link)).toBe('darius/intro');

    for (const slug of SLUGS) {
      const scaffold = await scaffoldFor(slug);
      if (scaffold.length === 0) continue;

      const pageSet = derivePageSet({
        pageCount: 'lt-5',
        businessType: 'Creative & design',
        hasBookingLink: true,
      });
      const pruned = applyPageSetToScaffold(scaffold, pageSet);
      const paths = pruned.files.map((file) => file.path);
      expect(paths, `${slug} keeps its booking page`).toContain(
        'src/pages/book.astro',
      );

      const map = Object.fromEntries(
        pruned.files.map((file) => [file.path, file.content]),
      );
      const injected = injectCalCom(map, link);
      const booking = injected['src/pages/book.astro'] as string;
      expect(booking, `${slug} renders the embed`).toContain(
        'data-flowstarter-cal-embed="true"',
      );
      expect(booking).toContain('https://cal.com/darius/intro/embed');
      // The tenant's own calendar, never the blurred funnel demo.
      expect(booking).not.toContain('data-flowstarter-cal-preview');
    }
  });

  it('is idempotent, so a rebuild does not stack a second calendar', async () => {
    const scaffold = await scaffoldFor('creative-portfolio');
    const map = Object.fromEntries(
      scaffold.map((file) => [file.path, file.content]),
    );
    const once = injectCalCom(map, 'https://cal.com/darius/intro');
    const twice = injectCalCom(once, 'https://cal.com/darius/intro');
    expect(twice['src/pages/book.astro']).toBe(once['src/pages/book.astro']);
    expect(
      (twice['src/pages/book.astro'] as string).match(
        /data-flowstarter-cal-embed/g,
      ),
    ).toHaveLength(1);
  });
});

describe('a workspace with no booking link', () => {
  it('emits no booking page, no booking link and no booking markup', async () => {
    for (const slug of SLUGS) {
      const scaffold = await scaffoldFor(slug);
      if (scaffold.length === 0) continue;

      const pageSet = derivePageSet({
        pageCount: 'lt-5',
        businessType: 'Creative & design',
        hasBookingLink: false,
      });
      const pruned = applyPageSetToScaffold(scaffold, pageSet);

      expect(
        pruned.files.map((file) => file.path),
        `${slug} drops its booking page`,
      ).not.toContain('src/pages/book.astro');
      expect(pruned.removedPaths).toContain('src/pages/book.astro');
      expect(
        bookingMarkup(pruned.files),
        `${slug} has no booking markup`,
      ).toEqual([]);
    }
  });

  it('sends a surviving book call to action to the contact page', async () => {
    const scaffold = await scaffoldFor('dorin-portfolio');
    const pageSet = derivePageSet({
      pageCount: 'lt-5',
      businessType: 'Creative & design',
      hasBookingLink: false,
    });
    const pruned = applyPageSetToScaffold(scaffold, pageSet);
    const header = pruned.files.find(
      (file) => file.path === 'src/components/Header.astro',
    );
    // dorin-portfolio's header CTA defaults to /book; with no booking page it
    // has to point somewhere a visitor can still reach a person.
    expect(header?.content).toContain("ctaHref = '/contact'");
    expect(header?.content).not.toContain("ctaHref = '/book'");
  });

  it('injects nothing when the link is missing or not a Cal.com host', async () => {
    const scaffold = await scaffoldFor('creative-portfolio');
    const map = Object.fromEntries(
      scaffold.map((file) => [file.path, file.content]),
    );
    for (const bad of [
      null,
      '',
      '   ',
      'https://cal.com.attacker.example/x',
      'https://calendly.com/x',
    ]) {
      expect(normalizeCalLink(bad)).toBeNull();
      expect(injectCalCom(map, bad)).toEqual(map);
    }
  });
});

describe('the booking page the library ships', () => {
  it('carries no third-party placeholder URL and no build note', async () => {
    for (const slug of SLUGS) {
      const content = await readFile(
        join(TEMPLATES, slug, 'src/pages/book.astro'),
        'utf8',
      ).catch(() => '');
      if (!content) continue;
      expect(content, `${slug} book page`).not.toContain(
        'calendly.com/your-username',
      );
      expect(content).not.toContain('Replace the src below');
      expect(
        findPlaceholderCopyInFiles([
          { path: `${slug}/src/pages/book.astro`, content },
        ]),
      ).toEqual([]);
    }
  });
});
