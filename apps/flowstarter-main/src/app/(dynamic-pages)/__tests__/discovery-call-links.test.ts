/**
 * The marketing pages must not promise a call the site cannot take.
 *
 * `/contact`, `/help` and `/faq` each carried a "book a call" button that
 * opened a modal with nowhere to send anybody. This reads the three pages off
 * disk and fails if any of them goes back to that, or if a fourth page grows a
 * booking CTA of its own that points at the modal instead of the route.
 *
 * A source-level check rather than a render, deliberately. Rendering these
 * pages needs the i18n provider, the marketing shell and Clerk, none of which
 * has anything to do with the fact under test, and a test that needs three
 * providers to assert one href is a test nobody will keep passing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISCOVERY_CALL_PATH } from '@/lib/flowstarter/discovery-call';

const PAGES_DIR = path.resolve(__dirname, '..');

const BOOKING_PAGES = ['contact', 'help', 'faq'] as const;

function source(page: string): string {
  return readFileSync(path.join(PAGES_DIR, page, 'page.tsx'), 'utf8');
}

describe('the pages that promise a call', () => {
  for (const page of BOOKING_PAGES) {
    describe(`/${page}`, () => {
      it('links its booking CTA at the discovery call route', () => {
        const code = source(page);
        expect(code).toContain('DISCOVERY_CALL_PATH');
        expect(code).toContain("from '@/lib/flowstarter/discovery-call'");
      });

      it('no longer opens a booking modal that goes nowhere', () => {
        const code = source(page);
        expect(code).not.toContain('useBookingModal');
        expect(code).not.toContain('openBookingModal');
      });
    });
  }

  it('points them all at the one route', () => {
    expect(DISCOVERY_CALL_PATH).toBe('/discovery-call');
  });

  it('has a page behind that route', () => {
    const page = path.join(PAGES_DIR, 'discovery-call', 'page.tsx');
    expect(readFileSync(page, 'utf8')).toContain('DiscoveryCallPage');
  });
});
