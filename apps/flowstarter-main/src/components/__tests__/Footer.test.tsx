/**
 * MVP readiness review, "Accessibility": the footer's nav links measured
 * 20px tall on a phone viewport against a 24px WCAG 2.2 AA minimum target
 * size, ten links in a row.
 *
 * The real component (`packages/flow-design-system/src/components/layout/Footer.tsx`)
 * has no test runner of its own — see `design-system-glass.test.tsx` — so it
 * is exercised here, from the app that renders it on every marketing page.
 *
 * jsdom does not lay out real pixels, so this asserts on the Tailwind class
 * tokens that grow the tap area (`py-1`, padding) rather than a measured
 * height, and confirms the font-size classes are untouched — the fix must
 * not solve this by making the text bigger. A Playwright measurement of the
 * rendered height lives alongside the cookie-banner mobile spec at
 * `e2e/cookie-consent-mobile.spec.ts`'s sibling check in
 * `e2e/footer-tap-targets.spec.ts`.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n', () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import Footer from '../Footer';

describe('Footer nav links — tap target', () => {
  it('pads every nav link to at least a 24px hit area without raising the font size', () => {
    render(<Footer />);

    const nav = screen.getByRole('navigation');
    const links = nav.querySelectorAll('a');
    expect(links.length).toBeGreaterThan(0);

    links.forEach((link) => {
      // Padding (not a font-size bump) supplies the extra hit area.
      expect(link.className).toMatch(/\bpy-1\b/);
      // The negative margin cancels the padding's effect on the row's own
      // height, so the desktop footer's spacing is unchanged.
      expect(link.className).toMatch(/-my-1\b/);
      // No text-* utility beyond the shared `text-sm` the nav already sets —
      // the link itself must not carry its own font-size class.
      expect(link.className).not.toMatch(/\btext-(xs|base|lg|xl)\b/);
    });
  });
});
