import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyIntegrationsToWorkspace,
  injectCalCom,
  injectCalComPreviewDemo,
  injectIntegrations,
  normalizeCalLink,
  removeCalComPreviewDemo,
  type FileMap,
} from '../src/integrations';

const TEMPLATES_DIR = join(__dirname, '../../../apps/flowstarter-templates');

function readTemplateFile(template: string, rel: string): string {
  return readFileSync(join(TEMPLATES_DIR, template, rel), 'utf8');
}

/** Every base template ships one of these — see workspace.ts's BASE_TEMPLATES. */
const ALL_TEMPLATES = [
  'wellness-therapy',
  'professional-services',
  'local-trade',
  'creative-portfolio',
  'dorin-portfolio',
];

describe('normalizeCalLink', () => {
  it('passes through a bare handle', () => {
    expect(normalizeCalLink('yourname')).toBe('yourname');
  });

  it('passes through a handle/event-type path', () => {
    expect(normalizeCalLink('yourname/30min')).toBe('yourname/30min');
  });

  it('strips the cal.com host', () => {
    expect(normalizeCalLink('cal.com/yourname')).toBe('yourname');
  });

  it('strips scheme + host for a full https URL', () => {
    expect(normalizeCalLink('https://cal.com/yourname/30min')).toBe(
      'yourname/30min',
    );
  });

  it('strips the app.cal.com host', () => {
    expect(normalizeCalLink('https://app.cal.com/yourname')).toBe('yourname');
  });

  it('drops query string, fragment and trailing slash', () => {
    expect(normalizeCalLink('https://cal.com/yourname/30min/?x=1#foo')).toBe(
      'yourname/30min',
    );
  });

  it('is null for empty / whitespace input', () => {
    expect(normalizeCalLink('')).toBeNull();
    expect(normalizeCalLink('   ')).toBeNull();
    expect(normalizeCalLink(undefined)).toBeNull();
    expect(normalizeCalLink(null)).toBeNull();
  });

  it('refuses a non-Cal.com host (this injector is Cal.com-only)', () => {
    expect(normalizeCalLink('https://calendly.com/yourname')).toBeNull();
    expect(normalizeCalLink('acme-studio.com/booking')).toBeNull();
  });
});

describe('injectCalCom — synthetic fixture (book-page__calendar placeholder shape)', () => {
  const placeholderFile = [
    '<main class="book-page">',
    '  <div class="book-page__calendar">',
    '    <!-- Replace the src below with your Calendly or Cal.com embed URL -->',
    '    <iframe',
    '      src="https://calendly.com/your-username/discovery-call"',
    '      width="100%"',
    '      height="700"',
    '      frameborder="0"',
    '      title="Book a discovery call"',
    '      loading="lazy"',
    '    ></iframe>',
    '  </div>',
    '</main>',
  ].join('\n');

  it('replaces the placeholder iframe src in place, keeping the container class', () => {
    const files: FileMap = { 'src/pages/book.astro': placeholderFile };
    const out = injectCalCom(files, 'acme/intro');
    const page = out['src/pages/book.astro']!;
    expect(page).toContain('class="book-page__calendar"');
    expect(page).toContain(
      'src="https://cal.com/acme/intro/embed?layout=month_view&theme=light"',
    );
    expect(page).not.toContain('calendly.com');
    expect(page).toContain('data-flowstarter-cal-embed="true"');
  });

  it('does not mutate the input map (pure function)', () => {
    const files: FileMap = { 'src/pages/book.astro': placeholderFile };
    const out = injectCalCom(files, 'acme/intro');
    expect(files['src/pages/book.astro']).toBe(placeholderFile);
    expect(out).not.toBe(files);
  });

  it('is a no-op for an unrecognized (non-Cal.com) URL', () => {
    const files: FileMap = { 'src/pages/book.astro': placeholderFile };
    const out = injectCalCom(
      files,
      'https://calendly.com/your-username/discovery-call',
    );
    expect(out).toEqual(files);
  });

  it('is a no-op for an empty or whitespace-only URL', () => {
    const files: FileMap = { 'src/pages/book.astro': placeholderFile };
    expect(injectCalCom(files, '')).toEqual(files);
    expect(injectCalCom(files, '   ')).toEqual(files);
    expect(injectCalCom(files, undefined)).toEqual(files);
  });

  it('is a no-op when neither book.astro nor contact.astro is present', () => {
    const files: FileMap = { 'src/pages/index.astro': '<main></main>' };
    const out = injectCalCom(files, 'acme/intro');
    expect(out).toEqual(files);
  });

  it('prefers book.astro over contact.astro when both exist', () => {
    const files: FileMap = {
      'src/pages/book.astro': placeholderFile,
      'src/pages/contact.astro': '<main class="contact"></main>',
    };
    const out = injectCalCom(files, 'acme/intro');
    expect(out['src/pages/book.astro']).toContain('cal.com/acme/intro');
    expect(out['src/pages/contact.astro']).toBe(
      files['src/pages/contact.astro'],
    );
  });

  it('falls back to contact.astro when there is no book.astro', () => {
    const files: FileMap = {
      'src/pages/contact.astro':
        '<main class="contact-page"><h1>Contact</h1></main>',
    };
    const out = injectCalCom(files, 'acme/intro');
    const page = out['src/pages/contact.astro']!;
    expect(page).toContain('<h1>Contact</h1>');
    expect(page).toContain('cal.com/acme/intro');
    expect(page).toContain('</main>');
  });

  it('is idempotent: re-running with a new URL updates the same block, not a second one', () => {
    const files: FileMap = { 'src/pages/book.astro': placeholderFile };
    const first = injectCalCom(files, 'acme/intro');
    const second = injectCalCom(first, 'acme/other-event');

    const page = second['src/pages/book.astro']!;
    expect(page.match(/<iframe/g)).toHaveLength(1);
    expect(page.match(/data-flowstarter-cal-embed="true"/g)).toHaveLength(1);
    expect(page).toContain('cal.com/acme/other-event/embed');
    expect(page).not.toContain('acme/intro/embed');
  });

  it('re-running with the same URL is a true no-op (stable content)', () => {
    const files: FileMap = { 'src/pages/book.astro': placeholderFile };
    const first = injectCalCom(files, 'acme/intro');
    const second = injectCalCom(first, 'acme/intro');
    expect(second['src/pages/book.astro']).toBe(first['src/pages/book.astro']);
  });
});

describe('injectCalCom — no existing calendar placeholder (wellness-therapy shape)', () => {
  it('appends a self-contained embed before </main> without touching existing content', () => {
    const before = [
      '<main class="book-page">',
      '  <div class="book-page__copy"><h1>Book a free intro call</h1></div>',
      '  <aside class="book-page__panel">',
      '    <a class="book-page__panel-btn" href="mailto:hello@example.com">Email to arrange a call</a>',
      '  </aside>',
      '</main>',
      '<Footer />',
    ].join('\n');
    const files: FileMap = { 'src/pages/book.astro': before };
    const out = injectCalCom(files, 'acme/intro');
    const page = out['src/pages/book.astro']!;

    // Nothing pre-existing was removed.
    expect(page).toContain('Book a free intro call');
    expect(page).toContain('mailto:hello@example.com');
    // New embed was added, and only once, before the closing </main>.
    expect(page).toContain('data-flowstarter-cal-embed="true"');
    expect(page).toContain('cal.com/acme/intro/embed');
    expect(page.indexOf('data-flowstarter-cal-embed')).toBeLessThan(
      page.indexOf('</main>'),
    );
    expect(page.indexOf('</main>')).toBeLessThan(page.indexOf('<Footer'));
  });

  it('is idempotent for the appended shape too', () => {
    const before = '<main class="book-page"><h1>Book</h1></main>';
    const first = injectCalCom(
      { 'src/pages/book.astro': before },
      'acme/intro',
    );
    const second = injectCalCom(first, 'acme/other');
    const page = second['src/pages/book.astro']!;
    expect(page.match(/<iframe/g)).toHaveLength(1);
    expect(page).toContain('cal.com/acme/other/embed');
  });
});

describe('the booking block is located by scanning, not by pattern', () => {
  const page = (body: string): FileMap => ({ 'src/pages/book.astro': body });
  const embedded = (files: FileMap) => files['src/pages/book.astro']!;

  it('does not mistake another element whose name starts with "div"', () => {
    const before =
      '<main><divider data-flowstarter-cal-embed="true">x</divider></main>';
    const after = embedded(injectCalCom(page(before), 'acme/intro'));
    // The divider is untouched and the embed went before </main> instead.
    expect(after).toContain('<divider data-flowstarter-cal-embed="true">');
    expect(after.indexOf('<iframe')).toBeLessThan(after.indexOf('</main>'));
  });

  it('wants the marker on an attribute boundary, not glued to another word', () => {
    const before =
      '<main><div xdata-flowstarter-cal-embed="true">stale</div></main>';
    const after = embedded(injectCalCom(page(before), 'acme/intro'));
    // Not recognised as a managed block, so the stale div survives.
    expect(after).toContain('>stale</div>');
    expect(after.match(/<iframe/g)).toHaveLength(1);
  });

  it('finds a real marker further along the same tag', () => {
    const before = [
      '<main>',
      '<div xdata-flowstarter-cal-embed="true" data-flowstarter-cal-embed="true">old</div>',
      '</main>',
    ].join('\n');
    const after = embedded(injectCalCom(page(before), 'acme/intro'));
    expect(after).not.toContain('>old</div>');
    expect(after.match(/<iframe/g)).toHaveLength(1);
  });

  it('ignores an opening tag that never closes, rather than hanging on it', () => {
    const before = '<main><div class="book-page__calendar">no close</main>';
    const after = embedded(injectCalCom(page(before), 'acme/intro'));
    // Nothing to replace and no </main> left after the unclosed div's start,
    // so the block lands on the last </main>.
    expect(after).toContain('no close');
    expect(after.match(/<iframe/g)).toHaveLength(1);
    expect(after.indexOf('<iframe')).toBeLessThan(after.lastIndexOf('</main>'));
  });

  it('hangs the block off the last </main>, not the first', () => {
    const before = '<main>one</main>\n<main>two</main>';
    const after = embedded(injectCalCom(page(before), 'acme/intro'));
    expect(after.indexOf('one')).toBeLessThan(after.indexOf('<iframe'));
    expect(after.indexOf('two')).toBeLessThan(after.indexOf('<iframe'));
    expect(after.match(/<\/main>/g)).toHaveLength(2);
  });

  it('upgrades a preview tease to the live embed, and only that block', () => {
    const teased = injectCalComPreviewDemo(
      page('<main><div class="book-page__calendar">placeholder</div></main>'),
    );
    expect(embedded(teased)).toContain('data-flowstarter-cal-preview="true"');
    const live = injectCalCom(teased, 'acme/intro');
    expect(embedded(live)).not.toContain('data-flowstarter-cal-preview');
    expect(embedded(live)).toContain('data-flowstarter-cal-embed="true"');
    expect(embedded(live).match(/<iframe/g)).toHaveLength(1);
  });

  it('takes the replacement literally, so a $& in the block is not a backreference', () => {
    const after = embedded(
      injectCalCom(
        page('<main><div class="book-page__calendar">x</div></main>'),
        'acme/$&intro',
      ),
    );
    expect(after).toContain('cal.com/acme/$&intro/embed');
  });
});

describe('injectCalCom — real template fixtures under apps/flowstarter-templates', () => {
  for (const template of ALL_TEMPLATES) {
    it(`injects cleanly into ${template}'s book.astro`, () => {
      const before = readTemplateFile(template, 'src/pages/book.astro');
      const files: FileMap = { 'src/pages/book.astro': before };
      const out = injectCalCom(files, 'flowstarter-demo/intro-call');
      const page = out['src/pages/book.astro']!;

      expect(page).not.toBe(before);
      expect(page).toContain('cal.com/flowstarter-demo/intro-call/embed');
      expect(page.match(/<iframe/g)?.length).toBe(1);
      // The template's structural landmarks survive the injection.
      expect(page).toContain('<Layout');
      expect(page).toContain('<Footer />');

      // Re-running is idempotent for every real template shape.
      const again = injectCalCom(out, 'flowstarter-demo/intro-call');
      expect(again[targetKey(again)]).toBe(page);
    });
  }
});

function targetKey(files: FileMap): string {
  return 'src/pages/book.astro' in files
    ? 'src/pages/book.astro'
    : 'src/pages/contact.astro';
}

describe('injectCalComPreviewDemo — blurred funnel tease', () => {
  it('replaces the placeholder with a blurred demo that never loads cal.com', () => {
    const files: FileMap = {
      'src/pages/book.astro':
        '<main><div class="book-page__calendar"><iframe src="https://calendly.com/x"></iframe></div></main>',
    };
    const out = injectCalComPreviewDemo(files);
    const page = out['src/pages/book.astro']!;
    expect(page).toContain('data-flowstarter-cal-preview="true"');
    expect(page).toContain('filter:blur');
    expect(page).toContain('Unlocks on the full site');
    expect(page).not.toContain('https://cal.com/');
    expect(page).not.toContain('data-flowstarter-cal-embed');
  });

  it('is upgraded to a live embed by injectCalCom on the full site', () => {
    const preview = injectCalComPreviewDemo({
      'src/pages/book.astro':
        '<main><div class="book-page__calendar"><iframe src="https://calendly.com/x"></iframe></div></main>',
    });
    const live = injectCalCom(preview, 'acme/intro');
    const page = live['src/pages/book.astro']!;
    expect(page).toContain('data-flowstarter-cal-embed="true"');
    expect(page).toContain('cal.com/acme/intro/embed');
    expect(page).not.toContain('data-flowstarter-cal-preview');
  });
});

describe('removeCalComPreviewDemo / injectCalCom with no link', () => {
  it('removes a seeded preview demo outright rather than leaving it in a paid build', () => {
    const preview = injectCalComPreviewDemo({
      'src/pages/book.astro':
        '<main><div class="book-page__calendar"><iframe src="https://calendly.com/x"></iframe></div></main>',
    });
    expect(preview['src/pages/book.astro']).toContain(
      'data-flowstarter-cal-preview="true"',
    );

    const out = injectCalCom(preview, null);
    const page = out['src/pages/book.astro']!;
    expect(page).not.toContain('data-flowstarter-cal-preview');
    expect(page).not.toContain('flowstarter:cal-preview');
    expect(page).not.toContain('filter:blur');
    expect(page).not.toContain('data-flowstarter-cal-embed');
  });

  it('removes the demo wherever it actually landed, not only from book.astro', () => {
    // This is the shape the 2026-09-12 defect shipped in: book.astro was
    // already dropped (no booking link), so the preview demo's own
    // append-before-</main> fallback put it on contact.astro instead.
    const preview = injectCalComPreviewDemo({
      'src/pages/contact.astro':
        '<main class="contact-page"><h1>Contact</h1><p><a href="mailto:hello@example.com">Email us</a></p></main>',
    });
    expect(preview['src/pages/contact.astro']).toContain(
      'data-flowstarter-cal-preview="true"',
    );

    const cleaned = injectCalCom(preview, undefined);
    const page = cleaned['src/pages/contact.astro']!;
    expect(page).not.toContain('data-flowstarter-cal-preview');
    // The rest of the page — including the email call to action — survives.
    expect(page).toContain('<h1>Contact</h1>');
    expect(page).toContain('mailto:hello@example.com');
  });

  it('removes a stale live embed when a previously-set link is taken away', () => {
    const withLink = injectCalCom(
      {
        'src/pages/book.astro': '<main class="book-page"><h1>Book</h1></main>',
      },
      'acme/intro',
    );
    expect(withLink['src/pages/book.astro']).toContain(
      'data-flowstarter-cal-embed="true"',
    );

    const linkRemoved = injectCalCom(withLink, null);
    const page = linkRemoved['src/pages/book.astro']!;
    expect(page).not.toContain('data-flowstarter-cal-embed');
    expect(page).not.toContain('cal.com/acme/intro');
    expect(page).toContain('<h1>Book</h1>');
  });

  it('is a true no-op when there is nothing to remove', () => {
    const files: FileMap = {
      'src/pages/book.astro': '<main class="book-page"><h1>Book</h1></main>',
    };
    expect(removeCalComPreviewDemo(files)).toBe(files);
    expect(injectCalCom(files, null)).toEqual(files);
  });

  it('does not mutate the input map', () => {
    const preview = injectCalComPreviewDemo({
      'src/pages/book.astro':
        '<main><div class="book-page__calendar">placeholder</div></main>',
    });
    const before = preview['src/pages/book.astro'];
    const out = removeCalComPreviewDemo(preview);
    expect(preview['src/pages/book.astro']).toBe(before);
    expect(out).not.toBe(preview);
  });
});

describe('injectIntegrations', () => {
  it('delegates to injectCalCom for a cal.com booking config', () => {
    const files: FileMap = {
      'src/pages/book.astro': '<main class="book-page"><h1>Book</h1></main>',
    };
    const out = injectIntegrations(files, {
      booking: { provider: 'cal.com', url: 'acme/intro' },
    });
    expect(out['src/pages/book.astro']).toContain('cal.com/acme/intro/embed');
  });

  it('is a no-op with no booking config', () => {
    const files: FileMap = {
      'src/pages/book.astro': '<main class="book-page"><h1>Book</h1></main>',
    };
    expect(injectIntegrations(files, {})).toEqual(files);
  });

  it('is a no-op with an empty booking url when there is nothing to remove', () => {
    const files: FileMap = {
      'src/pages/book.astro': '<main class="book-page"><h1>Book</h1></main>',
    };
    expect(
      injectIntegrations(files, { booking: { provider: 'cal.com', url: '' } }),
    ).toEqual(files);
  });

  it('removes a seeded preview demo when the booking config has no url', () => {
    const preview = injectCalComPreviewDemo({
      'src/pages/book.astro':
        '<main><div class="book-page__calendar">placeholder</div></main>',
    });
    const out = injectIntegrations(preview, {
      booking: { provider: 'cal.com', url: null },
    });
    expect(out['src/pages/book.astro']).not.toContain(
      'data-flowstarter-cal-preview',
    );
  });
});

describe('built HTML output', () => {
  it('upgrades a built booking page, so packaging a dist/ still wires the live embed', () => {
    const files: FileMap = {
      'index.html': '<main><h1>Home</h1></main>',
      'book/index.html':
        '<main><div class="book-page__calendar"><iframe src="https://calendly.com/x"></iframe></div></main>',
    };
    const out = injectCalCom(files, 'https://cal.com/acme/intro');

    expect(out['book/index.html']).toContain('cal.com/acme/intro/embed');
    // Only the booking page is touched; the home page is left alone.
    expect(out['index.html']).toBe(files['index.html']);
  });

  it('replaces the blurred preview demo in built output rather than stacking a second calendar', () => {
    const previewed = injectCalComPreviewDemo({
      'contact/index.html':
        '<main><div class="book-page__calendar">placeholder</div></main>',
    });
    expect(previewed['contact/index.html']).toContain(
      'data-flowstarter-cal-preview="true"',
    );

    const live = injectCalCom(previewed, 'acme/intro');
    expect(live['contact/index.html']).toContain(
      'data-flowstarter-cal-embed="true"',
    );
    expect(live['contact/index.html']).not.toContain(
      'data-flowstarter-cal-preview',
    );
    expect((live['contact/index.html']!.match(/<iframe/g) ?? []).length).toBe(
      1,
    );
  });

  it('prefers the Astro source over built HTML when both are present', () => {
    const out = injectCalCom(
      {
        'src/pages/book.astro': '<main><h1>Book</h1></main>',
        'book/index.html': '<main><h1>Book</h1></main>',
      },
      'acme/intro',
    );
    expect(out['src/pages/book.astro']).toContain('cal.com/acme/intro/embed');
    expect(out['book/index.html']).not.toContain('cal.com');
  });
});
