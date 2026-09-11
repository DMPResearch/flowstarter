import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeSentinels,
  describePlaceholderFindings,
  findPlaceholderCopy,
  findPlaceholderCopyInFiles,
  findPlaceholderCopyInText,
  isEditableContentPath,
  isScannedPath,
  PLACEHOLDER_COPY_SHIPPED,
  PLACEHOLDER_SENTINELS,
} from '../src/flowstarter/placeholder-copy';

/** Where the live library actually lives, from this package's test dir. */
const TEMPLATES = join(
  __dirname,
  '..',
  '..',
  '..',
  'apps',
  'flowstarter-templates',
);
const TEMPLATE_SLUGS = [
  'creative-portfolio',
  'dorin-portfolio',
  'local-trade',
  'professional-services',
  'wellness-therapy',
];

describe('the sentinel list', () => {
  it('is non-empty, uniquely identified and lowercase', () => {
    expect(PLACEHOLDER_SENTINELS.length).toBeGreaterThan(0);
    const ids = PLACEHOLDER_SENTINELS.map((sentinel) => sentinel.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const sentinel of PLACEHOLDER_SENTINELS) {
      expect(sentinel.phrase).toBe(sentinel.phrase.toLowerCase());
      expect(sentinel.phrase.trim()).toBe(sentinel.phrase);
      expect(sentinel.why.length).toBeGreaterThan(10);
    }
  });

  it('relaxes only the booking-specific sentinel when a link exists', () => {
    const without = activeSentinels({ hasBookingLink: false });
    const with_ = activeSentinels({ hasBookingLink: true });
    expect(without).toEqual(PLACEHOLDER_SENTINELS);
    expect(with_.length).toBe(without.length - 1);
    expect(
      with_.some((sentinel) => sentinel.id === 'promised-cal-com-calendar'),
    ).toBe(false);
  });
});

describe('findPlaceholderCopyInText', () => {
  it('catches the contact-form confession that shipped on a paid site', () => {
    const findings = findPlaceholderCopyInText(
      'src/content/site-labels.md',
      'successMessage: "Thanks, your message is ready to send once you connect this form to your email or form endpoint."',
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((finding) => finding.sentinel.id)).toContain(
      'contact-form-connect-this-form',
    );
  });

  it('catches every wording of it the five templates ever used', () => {
    const wordings = [
      'your message is ready to send once you connect this form to your email or form endpoint.',
      'Your message is ready to send once this form is connected to your preferred email.',
      'This will reach the practice once the form is connected to your email or booking tool.',
    ];
    for (const wording of wordings) {
      expect(
        findPlaceholderCopyInText('src/content/site-labels.md', wording),
      ).not.toEqual([]);
    }
  });

  it('is insensitive to case, curly quotes and reflowed whitespace', () => {
    const findings = findPlaceholderCopyInText(
      'src/content/site-labels.md',
      'Thanks — your message is ready to send ONCE  YOU\n  CONNECT THIS FORM to your inbox.',
    );
    expect(findings).not.toEqual([]);
  });

  it('catches the booking placeholders the templates used to carry', () => {
    expect(
      findPlaceholderCopyInText(
        'src/pages/book.astro',
        '<!-- Replace the src below with your Calendly or Cal.com embed URL -->',
      ).map((finding) => finding.sentinel.id),
    ).toContain('replace-the-src-below');

    expect(
      findPlaceholderCopyInText(
        'src/pages/book.astro',
        '<iframe src="https://calendly.com/your-username/discovery-call"></iframe>',
      ).map((finding) => finding.sentinel.id),
    ).toContain('calendly-your-username');
  });

  it('only faults a named calendar when the workspace has no link', () => {
    const copy = 'Pick a time on my Cal.com calendar.';
    expect(findPlaceholderCopyInText('dist/book/index.html', copy)).not.toEqual(
      [],
    );
    expect(
      findPlaceholderCopyInText('dist/book/index.html', copy, {
        hasBookingLink: true,
      }),
    ).toEqual([]);
  });

  it('says nothing about honest copy', () => {
    expect(
      findPlaceholderCopyInText(
        'src/content/site-labels.md',
        'Thanks. Your email app should be open with your message ready to send.',
      ),
    ).toEqual([]);
  });
});

describe('path scoping', () => {
  it('reads the copy and the markup in a whole-tree scan', () => {
    expect(isScannedPath('src/content/site-labels.md')).toBe(true);
    expect(isScannedPath('src/pages/book.astro')).toBe(true);
    expect(isScannedPath('src/components/Header.astro')).toBe(true);
    expect(isScannedPath('astro.config.mjs')).toBe(false);
    expect(isScannedPath('public/images/hero.png')).toBe(false);
  });

  it('narrows to the files the preview agent may actually repair', () => {
    expect(isEditableContentPath('src/content/site-labels.md')).toBe(true);
    expect(isEditableContentPath('src/data/site.json')).toBe(true);
    // The preview agent is barred from src/pages, so failing a preview for it
    // would be failing for something it cannot fix.
    expect(isEditableContentPath('src/pages/book.astro')).toBe(false);
    expect(isEditableContentPath('src/components/Header.astro')).toBe(false);
  });
});

describe('findPlaceholderCopy and findPlaceholderCopyInFiles', () => {
  it('scans a source tree by scaffold path', () => {
    const findings = findPlaceholderCopy({
      'src/content/site-labels.md': 'note: "lorem ipsum dolor sit amet"',
      'astro.config.mjs': 'lorem ipsum',
      'public/hero.png': 'lorem ipsum',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('src/content/site-labels.md');
  });

  it('scans built output, where the caller has already chosen the files', () => {
    const findings = findPlaceholderCopyInFiles([
      {
        path: 'dist/contact/index.html',
        content: 'once you connect this form',
      },
      { path: 'dist/_astro/hero.css', content: 'once you connect this form' },
    ]);
    expect(findings.map((finding) => finding.path)).toEqual([
      'dist/contact/index.html',
    ]);
  });
});

describe('describePlaceholderFindings', () => {
  it('carries the code, the phrase, the file and the reason', () => {
    const message = describePlaceholderFindings(
      findPlaceholderCopyInFiles([
        {
          path: 'dist/contact/index.html',
          content: 'once you connect this form',
        },
      ]),
    );
    expect(message.startsWith(PLACEHOLDER_COPY_SHIPPED)).toBe(true);
    expect(message).toContain('dist/contact/index.html');
    expect(message).toContain('once you connect this form');
    expect(message).toContain('does not work yet');
  });
});

describe('the live template library', () => {
  it('ships no sentinel in any booking page', async () => {
    for (const slug of TEMPLATE_SLUGS) {
      const path = join(TEMPLATES, slug, 'src', 'pages', 'book.astro');
      const content = await readFile(path, 'utf8').catch(() => '');
      if (!content) continue;
      expect(
        findPlaceholderCopyInText(`${slug}/src/pages/book.astro`, content),
      ).toEqual([]);
    }
  });

  it('ships no sentinel in any content file', async () => {
    for (const slug of TEMPLATE_SLUGS) {
      const path = join(TEMPLATES, slug, 'src', 'content', 'site-labels.md');
      const content = await readFile(path, 'utf8').catch(() => '');
      if (!content) continue;
      expect(
        findPlaceholderCopyInText(
          `${slug}/src/content/site-labels.md`,
          content,
        ),
      ).toEqual([]);
    }
  });
});
