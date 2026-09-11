'use client';

import { Button } from '@flowstarter/flow-design-system';
import { useI18n } from '@/lib/i18n';
import { useBookingModal } from '@/app/(dynamic-pages)/(main-pages)/components/booking-modal-store';

/**
 * Final CTA band on /about. The button opens the booking modal via the
 * shared zustand store. Isolated as its own client component so the
 * surrounding page can stay a server component and export metadata.
 */
export function AboutCtaBand() {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;
  const openBookingModal = useBookingModal((s) => s.open);

  return (
    <section className="ls-section ls-cta-section">
      <div className="ls-cta-bg" aria-hidden />
      <div className="ls-cta-glow" aria-hidden />
      <div className="ls-container">
        <div className="ls-cta-card">
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              textAlign: 'center',
            }}
          >
            <div className="ls-eyebrow inline-flex items-center justify-center gap-3">
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: '28px',
                  height: '1px',
                  background: 'var(--ls-ink-faint)',
                }}
              />
              <span className="num">{t('about.cta.eyebrow')}</span>
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: '28px',
                  height: '1px',
                  background: 'var(--ls-ink-faint)',
                }}
              />
            </div>
            <h2
              className="ls-display ls-display--sm mt-6"
              style={{ textWrap: 'balance' }}
            >
              <span className="line">{t('about.cta.headlinePrefix')}</span>
              <span className="line flourish mt-2">
                {t('about.cta.headlineFlourish')}
              </span>
            </h2>
            <p className="ls-body ls-body--lead mx-auto mt-6">
              {t('about.cta.sub')}
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Button
                variant="primary"
                size="lg"
                onClick={openBookingModal}
                iconPosition="right"
                icon={
                  <svg
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
                }
              >
                {t('about.cta.button')}
              </Button>
            </div>
            <p
              className="mt-6"
              style={{
                fontFamily: 'var(--ls-mono)',
                fontSize: '10.5px',
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ls-ink-faint)',
              }}
            >
              {t('about.cta.note')}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
