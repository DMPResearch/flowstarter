// One module per template, loaded once from the layout on every
// page. Each block below used to be its own hoisted <script> in the
// component or page that needed it; a brace scope keeps one block's
// locals (`clamp`, `reduceMotion`, ...) from colliding with another's
// now that they share a module. Every block already guards on the
// selector it targets being present, so running all of them on every
// page is the same behaviour as before, not a broader one.

import { useVisibilityClass } from './hooks/useVisibilityClass.js';
import { useJourneyTimeline } from './hooks/useJourneyTimeline.js';
import { useCountryPicker } from './hooks/useCountryPicker.js';
import { useFormSuccess } from './hooks/useFormSuccess.js';

// src/components/About.astro
{
  /* Venn statement now reveals via CSS on load — no scroll choreography. */
  document
    .querySelectorAll('[data-venn-circle]')
    .forEach((circle) => circle.removeAttribute('style'));
}

// src/components/CaseStudies.astro
{
  useVisibilityClass({
    selector: '[data-case-reveal]',
    threshold: 0.05,
    rootMargin: '0px',
    once: true,
    revealIfAlreadyVisible: false,
  });
}

// src/components/Expertise.astro
{
  const expertiseList = document.querySelector('[data-expertise-list]');

  if (expertiseList) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let introPlayed = false;

    const clearIntroState = () => {
      expertiseList.classList.remove('is-intro-state');
    };

    if (reduceMotion.matches) {
      clearIntroState();
    } else {
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting || introPlayed) return;

          introPlayed = true;
          expertiseList.classList.add('is-intro-state');

          window.setTimeout(() => {
            clearIntroState();
          }, 1400);

          observer.disconnect();
        },
        {
          threshold: 0.35,
        },
      );

      observer.observe(expertiseList);
    }
  }
}

// src/components/Header.astro
{
  const menuBtn = /** @type {HTMLButtonElement | null} */ (
    document.querySelector('.header__menu-btn')
  );
  const mobileNav = document.getElementById('mobile-nav');
  const header = document.querySelector('.header');

  menuBtn?.addEventListener('click', () => {
    const isOpen = menuBtn.classList.toggle('is-open');
    mobileNav?.classList.toggle('is-open', isOpen);
    menuBtn.setAttribute(
      'aria-label',
      isOpen ? 'Close navigation menu' : 'Open navigation menu',
    );
    mobileNav?.setAttribute('aria-hidden', String(!isOpen));
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });

  mobileNav?.querySelectorAll('.mobile-nav__link').forEach((link) => {
    link.addEventListener('click', () => {
      menuBtn?.classList.remove('is-open');
      mobileNav.classList.remove('is-open');
      mobileNav.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    });
  });
}

// src/components/Services.astro
{
  /* Service cards now reveal via CSS on load — no scroll choreography. */
  document
    .querySelectorAll('[data-service-card]')
    .forEach((card) => card.style.removeProperty('--service-reveal-progress'));
}

// src/components/Stats.astro
{
  const statsSection = document.querySelector('[data-stats-section]');
  const statNumbers = Array.from(
    document.querySelectorAll('[data-stat-number]'),
  );
  const prefersReducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  );

  const parseStatTarget = (value) => {
    const numeric = Number.parseFloat(value.replace(/[^0-9.]/g, ''));
    const suffix = value.replace(/[0-9.]/g, '');
    const decimals = value.includes('.')
      ? (value.split('.')[1]?.replace(/[^0-9]/g, '').length ?? 0)
      : 0;

    return {
      numeric: Number.isFinite(numeric) ? numeric : 0,
      suffix,
      decimals,
    };
  };

  const formatStatValue = (value, decimals, suffix) => {
    const rounded =
      decimals > 0 ? value.toFixed(decimals) : Math.round(value).toString();
    return `${rounded}${suffix}`;
  };

  const animateStat = (element, index) => {
    const targetValue = element.dataset.target ?? element.textContent ?? '0';
    const { numeric, suffix, decimals } = parseStatTarget(targetValue);
    const duration = 1000 + index * 90;
    const start = performance.now();

    element.classList.add('is-visible');

    const tick = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const currentValue = numeric * eased;
      element.textContent = formatStatValue(currentValue, decimals, suffix);

      if (progress < 1) {
        window.requestAnimationFrame(tick);
      } else {
        element.textContent = targetValue;
      }
    };

    window.requestAnimationFrame(tick);
  };

  if (statsSection && statNumbers.length > 0) {
    if (prefersReducedMotion.matches) {
      statNumbers.forEach((element) => {
        element.classList.add('is-visible');
        element.textContent =
          element.dataset.target ?? element.textContent ?? '';
      });
    } else {
      let played = false;
      const play = () => {
        if (played) return;
        played = true;
        statNumbers.forEach((element, index) => animateStat(element, index));
      };

      const observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) return;
          play();
          observer.disconnect();
        },
        {
          threshold: 0.35,
        },
      );

      observer.observe(statsSection);

      /* Safety net for non-scrolling viewers / far-below-fold placement. */
      window.setTimeout(() => {
        play();
        observer.disconnect();
      }, 1100);
    }
  }
}

// src/components/Testimonial.astro
{
  useVisibilityClass({
    selector: '[data-testimonial-reveal]',
    threshold: 0.05,
    rootMargin: '0px',
    once: true,
    revealIfAlreadyVisible: false,
  });
}

// src/components/about/AboutJourneySection.astro
{
  // The loader half of the step timeline. This template's own
  // AboutJourneySection is still the flat row layout and renders no
  // `data-journey-*` markup, so the hook finds no `[data-journey-section]`
  // and returns — the same guard every block in this file relies on. It is
  // here because a hook module nothing imports can never run whatever the
  // markup does, and the other three templates that ship this component wire
  // it exactly this way.
  useJourneyTimeline();
}

// src/pages/about.astro
{
  useVisibilityClass({
    selector: '[data-zigzag-section]',
    threshold: 0.45,
    rootMargin: '0px 0px -14% 0px',
    once: true,
    revealIfAlreadyVisible: false,
  });
  useVisibilityClass({
    selector: '[data-about-reveal]',
    threshold: 0.16,
    rootMargin: '0px 0px -8% 0px',
    once: true,
  });
}

// src/pages/blog.astro
{
  useVisibilityClass({
    selector: '[data-blog-reveal]',
    threshold: 0.08,
    once: true,
    revealIfAlreadyVisible: false,
  });
}

// src/pages/contact.astro
{
  const picker = useCountryPicker('[data-country-picker]');
  const contactForm = document.querySelector('[data-contact-form]');

  useFormSuccess({
    formSelector: '[data-contact-form]',
    successSelector: '[data-contact-success]',
    mailto:
      contactForm instanceof HTMLElement
        ? contactForm.dataset.contactEmail
        : undefined,
    onSuccess: () => picker?.reset(),
  });
}
