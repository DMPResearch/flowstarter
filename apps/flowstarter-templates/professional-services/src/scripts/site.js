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
  const aboutStage = document.querySelector('[data-about-stage]');
  const aboutCircles = aboutStage
    ? Array.from(aboutStage.querySelectorAll('[data-venn-circle]'))
    : [];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobileViewport = window.matchMedia('(max-width: 768px)');
  let aboutFrameId = 0;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const lerp = (start, end, amount) => start + (end - start) * amount;
  const easeOutCubic = (value) => 1 - Math.pow(1 - value, 3);

  const setCircleReveal = (value) => {
    aboutCircles.forEach((circle) => {
      const y = lerp(-96, 0, value);
      const scale = lerp(0.94, 1, value);
      circle.style.setProperty('--circle-opacity', `${value}`);
      circle.style.setProperty('--circle-y', `${y}px`);
      circle.style.setProperty('--circle-scale-x', `${scale}`);
      circle.style.setProperty('--circle-scale-y', `${scale}`);
    });
  };

  const updateAboutScrollAnimation = () => {
    aboutFrameId = 0;

    if (!aboutStage || aboutCircles.length === 0) return;

    if (reduceMotion.matches || mobileViewport.matches) {
      setCircleReveal(1);
      return;
    }

    const stageRect = aboutStage.getBoundingClientRect();
    const totalScrollable = Math.max(
      aboutStage.offsetHeight - window.innerHeight,
      1,
    );
    const travelled = clamp(-stageRect.top, 0, totalScrollable);
    const progress = travelled / totalScrollable;
    const segments = [
      { start: 0.12, end: 0.28 },
      { start: 0.38, end: 0.54 },
      { start: 0.64, end: 0.8 },
    ];

    aboutCircles.forEach((circle, index) => {
      const segment = segments[index] ?? segments[segments.length - 1];
      const reveal = clamp(
        (progress - segment.start) / (segment.end - segment.start),
        0,
        1,
      );
      let opacity = reveal;
      let y = -96;
      let scaleX = 0.94;
      let scaleY = 0.94;

      if (reveal <= 0) {
        opacity = 0;
      } else if (reveal < 0.78) {
        const fall = easeOutCubic(reveal / 0.78);
        opacity = clamp(reveal * 1.5, 0, 1);
        y = lerp(-96, 0, fall);
        scaleX = lerp(0.94, 1, fall);
        scaleY = lerp(0.94, 1, fall);
      } else {
        const bounce = clamp((reveal - 0.78) / 0.22, 0, 1);
        const arc = Math.sin(bounce * Math.PI);
        const lift = arc * (1 - bounce * 0.78) * 42;
        opacity = 1;
        y = -lift;
        scaleX = 1 + arc * 0.065;
        scaleY = 1 - arc * 0.11;
      }

      circle.style.setProperty('--circle-opacity', opacity.toFixed(3));
      circle.style.setProperty('--circle-y', `${y.toFixed(2)}px`);
      circle.style.setProperty('--circle-scale-x', `${scaleX.toFixed(3)}`);
      circle.style.setProperty('--circle-scale-y', `${scaleY.toFixed(3)}`);
    });
  };

  const queueAboutScrollAnimation = () => {
    if (aboutFrameId) return;
    aboutFrameId = window.requestAnimationFrame(updateAboutScrollAnimation);
  };

  if (aboutStage && aboutCircles.length > 0) {
    queueAboutScrollAnimation();
    window.addEventListener('scroll', queueAboutScrollAnimation, {
      passive: true,
    });
    window.addEventListener('resize', queueAboutScrollAnimation);
    window.addEventListener('pageshow', queueAboutScrollAnimation);
  }
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
  const servicesStage = document.querySelector('[data-services-stage]');
  const serviceCards = servicesStage
    ? Array.from(servicesStage.querySelectorAll('[data-service-card]'))
    : [];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobileViewport = window.matchMedia('(max-width: 768px)');
  let servicesFrameId = 0;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const setServiceReveal = (value) => {
    serviceCards.forEach((card) => {
      card.style.setProperty('--service-reveal-progress', `${value}`);
    });
  };

  const updateServicesScrollAnimation = () => {
    servicesFrameId = 0;

    if (!servicesStage || serviceCards.length === 0) return;

    if (reduceMotion.matches || mobileViewport.matches) {
      setServiceReveal(1);
      return;
    }

    const stageRect = servicesStage.getBoundingClientRect();
    const totalScrollable = Math.max(
      servicesStage.offsetHeight - window.innerHeight,
      1,
    );
    const travelled = clamp(-stageRect.top, 0, totalScrollable);
    const progress = travelled / totalScrollable;
    const step = 0.095;
    const revealWindow = 0.08;
    const firstStart = 0.08;

    serviceCards.forEach((card, index) => {
      const start = firstStart + index * step;
      const end = start + revealWindow;
      const reveal = clamp((progress - start) / (end - start), 0, 1);
      card.style.setProperty('--service-reveal-progress', reveal.toFixed(3));
    });
  };

  const queueServicesScrollAnimation = () => {
    if (servicesFrameId) return;
    servicesFrameId = window.requestAnimationFrame(
      updateServicesScrollAnimation,
    );
  };

  if (servicesStage && serviceCards.length > 0) {
    queueServicesScrollAnimation();
    window.addEventListener('scroll', queueServicesScrollAnimation, {
      passive: true,
    });
    window.addEventListener('resize', queueServicesScrollAnimation);
    window.addEventListener('pageshow', queueServicesScrollAnimation);
  }
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
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) return;

          statNumbers.forEach((element, index) => animateStat(element, index));
          observer.disconnect();
        },
        {
          threshold: 0.35,
        },
      );

      observer.observe(statsSection);
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
