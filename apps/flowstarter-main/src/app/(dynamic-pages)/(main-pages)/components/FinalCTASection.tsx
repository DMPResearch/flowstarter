'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/unified-button';
import { useI18n } from '@/lib/i18n';
import { useBookingModal } from './booking-modal-store';

export function FinalCTASection() {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;
  const rootRef = useRef<HTMLElement | null>(null);
  const openBookingModal = useBookingModal((s) => s.open);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const mq = window.matchMedia('(hover: none), (pointer: coarse)');
    if (mq.matches) return;
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      el.style.setProperty(
        '--ls-mx',
        `${((e.clientX - rect.left) / rect.width) * 100}%`
      );
      el.style.setProperty(
        '--ls-my',
        `${((e.clientY - rect.top) / rect.height) * 100}%`
      );
    };
    el.addEventListener('mousemove', onMove);
    return () => el.removeEventListener('mousemove', onMove);
  }, []);

  return (
    <section ref={rootRef} className="ls-scope ls-section ls-cta-section">
      <div className="ls-cta-bg" aria-hidden />
      <div className="ls-cta-glow" aria-hidden />

      {/* Subtle top separator */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: '8%',
          right: '8%',
          height: '1px',
          background:
            'linear-gradient(90deg, transparent, var(--ls-rule) 20%, var(--ls-rule) 80%, transparent)',
          opacity: 0.6,
        }}
      />

      <div className="ls-container">
        {/* Glass card */}
        <div className="ls-cta-card">
          {/* Top shine line — 3D effect */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              top: 0,
              left: '15%',
              right: '15%',
              height: '1px',
              background:
                'linear-gradient(90deg, transparent, rgba(255,255,255,0.5) 40%, rgba(255,255,255,0.5) 60%, transparent)',
              borderRadius: '1px',
            }}
          />

          {/* Inner bloom — centered behind content */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              background:
                'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(88,106,240,0.14) 0%, transparent 70%)',
            }}
          />

          <div style={{ position: 'relative', zIndex: 1, textAlign: 'center' }}>
            {/* Eyebrow */}
            <div className="ls-eyebrow inline-flex items-center justify-center gap-3 mx-auto">
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 28,
                  height: 1,
                  background: 'var(--ls-ink-faint)',
                }}
              />
              <span className="num">{t('landing.finalCta.eyebrow')}</span>
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 28,
                  height: 1,
                  background: 'var(--ls-ink-faint)',
                }}
              />
            </div>

            {/* Headline */}
            <h2 className="ls-display mt-7" style={{ textWrap: 'balance' }}>
              <span className="line">
                {t('landing.finalCta.headlinePrefix')}
              </span>
              <span className="line flourish mt-2">
                {t('landing.finalCta.headlineFlourish')}
              </span>
            </h2>

            {/* Subhead */}
            <p className="ls-body ls-body--lead mt-7 mx-auto">
              {t('landing.finalCta.subhead')}
            </p>

            {/* CTA */}
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-5">
              <Button
                onClick={openBookingModal}
                className="ls-cta-hero h-14 px-8 text-[1.02rem] sm:text-[1.08rem]"
              >
                {t('landing.finalCta.primaryCta')}
                <svg
                  className="arrow ml-2 h-4 w-4"
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
            </div>

            {/* Micro note */}
            <p
              className="mt-6 text-[10.5px] uppercase tracking-[0.18em]"
              style={{
                color: 'var(--ls-ink-faint)',
                fontFamily: 'var(--ls-mono)',
              }}
            >
              {t('landing.finalCta.microNote')}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
