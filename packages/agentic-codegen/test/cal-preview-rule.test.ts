import { describe, expect, it } from 'vitest';
import {
  CAL_PREVIEW_COMMENT,
  CAL_PREVIEW_IN_PAID_BUILD,
  CAL_PREVIEW_MARKER_ATTRIBUTE,
  describeCalPreviewIssue,
  findCalPreviewReferences,
  hasCalPreviewMarker,
} from '../src/flowstarter/cal-preview-rule';
import { injectCalComPreviewDemo, type FileMap } from '../src/integrations';

/** The real, rendered shape `injectCalComPreviewDemo` writes into a page. */
function renderedPreviewDemo(): string {
  const files: FileMap = {
    'src/pages/book.astro':
      '<main><div class="book-page__calendar">placeholder</div></main>',
  };
  return injectCalComPreviewDemo(files)['src/pages/book.astro']!;
}

describe('hasCalPreviewMarker', () => {
  it('recognizes the real, rendered demo block', () => {
    expect(hasCalPreviewMarker(renderedPreviewDemo())).toBe(true);
  });

  it('recognizes the marker attribute on its own', () => {
    expect(
      hasCalPreviewMarker(`<div ${CAL_PREVIEW_MARKER_ATTRIBUTE}="true"></div>`),
    ).toBe(true);
  });

  it('recognizes the HTML comment even if the attribute were ever stripped', () => {
    expect(hasCalPreviewMarker(`<!-- ${CAL_PREVIEW_COMMENT} -->`)).toBe(true);
  });

  it('says nothing about an ordinary page', () => {
    expect(hasCalPreviewMarker('<h1>Calm Path Therapy</h1>')).toBe(false);
  });

  it('does not fire on the live embed, which carries a different marker', () => {
    expect(
      hasCalPreviewMarker('<div data-flowstarter-cal-embed="true"></div>'),
    ).toBe(false);
  });
});

describe('findCalPreviewReferences', () => {
  it('catches the demo on whichever built page it landed on', () => {
    expect(
      findCalPreviewReferences([
        { path: 'dist/contact/index.html', content: renderedPreviewDemo() },
        { path: 'dist/index.html', content: '<h1>Calm Path Therapy</h1>' },
      ]),
    ).toEqual(['dist/contact/index.html']);
  });

  it('says nothing about a clean paid build', () => {
    expect(
      findCalPreviewReferences([
        { path: 'dist/index.html', content: '<h1>Calm Path Therapy</h1>' },
        {
          path: 'dist/book/index.html',
          content:
            '<div data-flowstarter-cal-embed="true"><iframe></iframe></div>',
        },
      ]),
    ).toEqual([]);
  });
});

describe('describeCalPreviewIssue', () => {
  it('carries the code, the reason and the offending paths', () => {
    const message = describeCalPreviewIssue(['contact/index.html']);
    expect(message.startsWith(CAL_PREVIEW_IN_PAID_BUILD)).toBe(true);
    expect(message).toContain('contact/index.html');
    expect(message).toContain(CAL_PREVIEW_MARKER_ATTRIBUTE);
  });

  it('caps the list rather than printing a whole ten-page site', () => {
    const paths = Array.from(
      { length: 14 },
      (_, index) => `page-${index}.html`,
    );
    const message = describeCalPreviewIssue(paths);
    expect(message).toContain('and 4 more');
  });
});
