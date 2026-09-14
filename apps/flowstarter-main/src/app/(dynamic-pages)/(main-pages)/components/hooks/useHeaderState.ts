import { useState, useEffect } from 'react';
import { LANDING_NAV_IDS } from '../landing-nav';

const HEADER_SCROLL_OFFSET = 96;

export function useHeaderState() {
  const [isLoaded] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('');

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    // Same ids the header lists, sorted by live document position so the
    // scroll-spy cannot disagree with the menu when the page is reordered.
    const getSections = () =>
      LANDING_NAV_IDS.map((id) => document.getElementById(id))
        .filter((el): el is HTMLElement => el !== null)
        .sort(
          (a, b) =>
            a.getBoundingClientRect().top +
            window.scrollY -
            (b.getBoundingClientRect().top + window.scrollY)
        );

    const onScroll = () => {
      const sections = getSections();
      if (sections.length === 0) return;

      const marker = window.scrollY + HEADER_SCROLL_OFFSET + 44;
      let current = '';

      for (const section of sections) {
        const top = section.getBoundingClientRect().top + window.scrollY;
        if (top <= marker) {
          current = section.id;
        }
      }

      setActiveSection(current);
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return {
    isLoaded,
    scrolled,
    mobileMenuOpen,
    setMobileMenuOpen,
    activeSection,
  };
}
