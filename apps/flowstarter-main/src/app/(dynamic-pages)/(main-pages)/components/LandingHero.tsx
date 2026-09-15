'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/unified-button';
import { useI18n } from '@/lib/i18n';
import { useBookingModal } from './booking-modal-store';

const PROGRESS_STEPS = 4;

type BriefField = { label: string; value: string };

export function LandingHero() {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;
  const openBookingModal = useBookingModal((s) => s.open);
  const [activeStep, setActiveStep] = useState(0);
  // Always revealed — entrance animation via CSS, not JS state.
  // JS-gated opacity caused hero flash/reflow on Android Chrome on first paint.
  const revealed = true;

  const briefFields = useMemo<BriefField[]>(() => {
    const label1 = t('landing.hero.brief.field1Label');
    const label2 = t('landing.hero.brief.field2Label');
    const label3 = t('landing.hero.brief.field3Label');
    const label4 = t('landing.hero.brief.field4Label');
    return [
      { label: label1, value: t('landing.hero.brief.field1Value') },
      { label: label2, value: t('landing.hero.brief.field2Value') },
      { label: label3, value: t('landing.hero.brief.field3Value') },
      { label: label4, value: t('landing.hero.brief.field4Value') },
    ];
  }, [t]);

  const reveal = (order: number): React.CSSProperties => ({
    opacity: revealed ? 1 : 0,
    transform: revealed ? 'translateY(0)' : 'translateY(22px)',
    transition: `opacity 900ms cubic-bezier(0.19,1,0.22,1) ${
      order * 110
    }ms, transform 900ms cubic-bezier(0.19,1,0.22,1) ${order * 110}ms`,
  });

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    if (reducedMotion) {
      setActiveStep(PROGRESS_STEPS - 1);
      return;
    }

    const timers = Array.from({ length: PROGRESS_STEPS - 1 }, (_, index) =>
      window.setTimeout(() => setActiveStep(index + 1), (index + 1) * 1900)
    );

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const progressLabels = useMemo(
    () => [
      t('landing.hero.brief.progressLearning'),
      t('landing.hero.brief.progressVoice'),
      t('landing.hero.brief.progressDesign'),
      t('landing.hero.brief.progressReady'),
    ],
    [t]
  );
  const filled = activeStep + 1;
  const isReady = activeStep === PROGRESS_STEPS - 1;

  return (
    <section className="ls-scope ls-section ls-hero-section ls-fade-bottom">
      {/* Cool indigo wash + the brand flow lines, scoped to the hero. No warm
          bloom: the page cream already carries warmth, and more of it reads as
          the yellow tint we are trying not to have. Paths match FlowBackground. */}
      <div className="ls-hero-atmosphere" aria-hidden="true">
        <div className="ls-hero-atmosphere__wash" />
        <div className="ls-hero-atmosphere__bloom" />
        <div className="ls-hero-atmosphere__secondary" />
        <svg
          className="ls-hero-atmosphere__lines"
          viewBox="0 0 1440 900"
          preserveAspectRatio="xMidYMid slice"
          fill="none"
        >
          <defs>
            <linearGradient id="ls-hero-lg-a" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="transparent" />
              <stop
                offset="20%"
                stopColor="hsl(233,65%,50%)"
                stopOpacity="0.6"
              />
              <stop
                offset="60%"
                stopColor="hsl(233,70%,58%)"
                stopOpacity="0.8"
              />
              <stop offset="100%" stopColor="transparent" />
            </linearGradient>
            <linearGradient id="ls-hero-lg-b" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="transparent" />
              <stop
                offset="30%"
                stopColor="hsl(233,60%,52%)"
                stopOpacity="0.55"
              />
              <stop
                offset="70%"
                stopColor="hsl(233,55%,62%)"
                stopOpacity="0.45"
              />
              <stop offset="100%" stopColor="transparent" />
            </linearGradient>
          </defs>
          <g stroke="url(#ls-hero-lg-a)" strokeWidth="1.0">
            <path d="M-60,180 C200,140 420,220 720,175 S1100,135 1500,195" />
            <path d="M-60,340 C180,300 400,380 720,330 S1060,295 1500,360" />
            <path d="M-60,520 C220,480 440,555 720,505 S1080,470 1500,530" />
            <path d="M-60,700 C200,665 440,730 720,685 S1100,650 1500,710" />
          </g>
          <g stroke="url(#ls-hero-lg-b)" strokeWidth="0.7">
            <path d="M-60,260 C240,220 460,300 720,255 S1080,215 1500,280" />
            <path d="M-60,430 C200,395 420,465 720,420 S1060,385 1500,445" />
            <path d="M-60,610 C210,575 440,645 720,600 S1080,565 1500,625" />
            <path d="M-60,800 C240,765 460,840 720,795 S1090,755 1500,815" />
          </g>
        </svg>
      </div>
      {/* Hairline grid on top of the wash — texture, not colour. */}
      <div className="ls-weave" aria-hidden="true" />
      <div className="ls-container relative z-[1]">
        <div className="grid items-center gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-20">
          <div className="ls-hero-content">
            <div
              style={reveal(0)}
              className="ls-eyebrow ls-eyebrow--hero flex flex-wrap items-start gap-x-2.5 gap-y-1"
            >
              <span className="ls-eyebrow-mark" aria-hidden="true" />
              <span>{t('landing.hero.eyebrowSerial')}</span>
              {t('landing.hero.eyebrowLabel') && (
                <>
                  <span className="dot">·</span>
                  <span>{t('landing.hero.eyebrowLabel')}</span>
                </>
              )}
              {t('landing.hero.eyebrowTagline') && (
                <>
                  <span className="dot">·</span>
                  <span>{t('landing.hero.eyebrowTagline')}</span>
                </>
              )}
            </div>

            {/* The break between each line's halves is set here rather than
                left to the measure: `.brk` is a block below 640px and an
                inline run above it, so the hand-set line holds on a desktop
                and collapses on a phone instead of stranding orphans. The
                drawn mark sits under the last phrase alone — underlining the
                whole blue sentence would read as a link, not as emphasis. */}
            <h1 className="ls-display ls-display--hero mt-9">
              <span className="line" style={reveal(1)}>
                {t('landing.hero.displayPrefix')}{' '}
                <span className="brk">
                  {t('landing.hero.displayPrefixTail')}
                </span>
              </span>
              <span className="line flourish mt-2" style={reveal(2)}>
                {t('landing.hero.displayFlourish')}{' '}
                <span className="brk">
                  <span className="ls-mark">
                    {t('landing.hero.displayFlourishTail')}
                  </span>
                </span>
              </span>
            </h1>

            <p style={reveal(3)} className="ls-hero-proof mt-5">
              {t('landing.hero.proofLine')}
            </p>

            <p style={reveal(4)} className="ls-body ls-body--lead mt-8">
              {t('landing.hero.subhead')}
            </p>

            <div
              style={reveal(5)}
              className="mt-10 flex w-full flex-wrap items-center gap-3 sm:gap-6"
            >
              <Button
                data-testid="open-discovery"
                onClick={openBookingModal}
                className="ls-cta-hero w-full sm:w-auto h-14 px-8 text-[1.02rem] sm:text-[1.08rem]"
              >
                {t('landing.hero.primaryCta')}
                <svg
                  className="arrow ml-2 h-4 w-4"
                  aria-hidden="true"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.4}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 12h14m-5-6l6 6-6 6"
                  />
                </svg>
              </Button>
              <a
                href="#process"
                onClick={(e) => {
                  e.preventDefault();
                  const el = document.getElementById('process');
                  if (!el) return;
                  const top =
                    el.getBoundingClientRect().top + window.scrollY - 96;
                  window.scrollTo({ top, behavior: 'smooth' });
                }}
                className="ls-link ls-link--hero w-full text-center sm:w-auto sm:text-left"
              >
                {t('landing.hero.secondaryCta')}
              </a>
            </div>
          </div>

          <aside
            style={{
              ...reveal(2),
              transform: revealed
                ? 'translateY(0) translateX(0)'
                : 'translateY(22px) translateX(16px)',
            }}
            className="ls-card ls-brief"
            data-hero-stage={activeStep + 1}
          >
            <div className="ls-brief-hdr">
              <span className="ls-brief-live">
                {isReady
                  ? t('landing.hero.brief.live')
                  : t('landing.hero.brief.liveWorking')}
              </span>
              <span className="ls-brief-serial">
                {t('landing.hero.brief.serial')}
              </span>
            </div>

            <div className="ls-brief-title">
              {t('landing.hero.brief.title')}
            </div>
            <div className="ls-brief-subtitle">
              {t('landing.hero.brief.subtitle')}
            </div>

            {briefFields.map((field, index) => {
              return (
                <div
                  key={field.label}
                  className={`ls-field ${
                    index === activeStep ? 'is-active' : ''
                  } ${index < activeStep ? 'is-complete' : ''} ${
                    index > activeStep ? 'is-pending' : ''
                  }`}
                >
                  <span className="lbl">{field.label}</span>
                  <span className="val">{field.value}</span>
                </div>
              );
            })}

            <div className="ls-brief-delivery">
              <div className="row">
                <span className="lbl">
                  {t('landing.hero.brief.progressLabel')}
                </span>
                <span className="val" aria-live="polite">
                  {progressLabels[activeStep]}
                </span>
              </div>
              <div className="ls-bar">
                {Array.from({ length: PROGRESS_STEPS }).map((_, i) => (
                  <div
                    key={i}
                    className={`ls-bar-cell ${i < filled ? 'on' : ''}`}
                    style={{ animationDelay: `${i * 90}ms` }}
                  />
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={openBookingModal}
              className={`ls-brief-finish ${isReady ? 'ready' : ''}`}
            >
              {isReady
                ? t('landing.hero.brief.ctaReady')
                : t('landing.hero.brief.ctaPending')}
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 12h14m-5-6l6 6-6 6"
                />
              </svg>
            </button>
          </aside>
        </div>
      </div>
    </section>
  );
}
