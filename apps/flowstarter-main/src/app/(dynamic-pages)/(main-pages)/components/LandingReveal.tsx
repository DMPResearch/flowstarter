'use client';

import { useEffect } from 'react';

/**
 * Reveal on scroll, for the whole landing page, from one observer.
 *
 * Every section on this page is a Server Component, and wrapping each of them
 * in its own client island to watch its own scroll position would ship a
 * dozen observers and a dozen hydration boundaries for one effect. This is
 * the effect instead: a single island, mounted once, that watches every
 * element carrying `.ls-rise` and adds `is-in` the first time it crosses the
 * viewport. It then stops watching that element -- the reveal happens once,
 * not every time the visitor scrolls back up.
 *
 * The resting state in CSS is *visible*. Hiding is opt-in, applied here by
 * `is-armed`, and only ever to elements that are already off screen. That
 * ordering matters: a page that hid its own content in CSS and relied on this
 * island to bring it back would show a visitor with no JS, slow JS or a
 * failed chunk a column of blank sections. Nothing above the fold is ever
 * armed either, so no element can flash out and back in during hydration.
 */
export function LandingReveal() {
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('.ls-rise')
    );
    // Asked for less motion: arm nothing, and there is nothing to reveal.
    if (reduced) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          observer.unobserve(entry.target);
        });
      },
      // Fires a little before the element's top edge arrives, so the rise is
      // finished by the time the visitor is actually looking at it.
      { threshold: 0.08, rootMargin: '0px 0px -8% 0px' }
    );

    nodes.forEach((node) => {
      // Anything already on screen was never scrolled to. Leaving it alone is
      // the whole safety property: it is visible, and it stays visible.
      const rect = node.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) return;
      node.classList.add('is-armed');
      observer.observe(node);
    });

    return () => observer.disconnect();
  }, []);

  return null;
}
