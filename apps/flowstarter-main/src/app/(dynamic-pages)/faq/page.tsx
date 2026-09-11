'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { Button } from '@flowstarter/flow-design-system';
import { MarketingShell, PageHero } from '@/components/marketing';
import { useFAQAccordion } from '@/app/(dynamic-pages)/(main-pages)/components/hooks/useFAQAccordion';
import { useBookingModal } from '@/app/(dynamic-pages)/(main-pages)/components/booking-modal-store';
import { LANDING_COPY } from '@/app/(dynamic-pages)/(main-pages)/landing-copy';

export default function FAQPage() {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;
  const { openIndex, toggle } = useFAQAccordion(0);
  const openBookingModal = useBookingModal((s) => s.open);
  const items = LANDING_COPY.faq.items;

  return (
    <MarketingShell>
      <main id="main-content" className="flex-1">
        <PageHero
          eyebrow={t('faq.eyebrow')}
          headlinePrefix={t('faq.headlinePrefix')}
          headlineFlourish={t('faq.headlineFlourish')}
          sub={t('faq.sub')}
        />

        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <div className="ls-faq-list mx-auto max-w-3xl">
              {items.map((item, i) => {
                const isOpen = openIndex === i;
                return (
                  <div
                    key={item.question}
                    className={`ls-faq-item ${isOpen ? 'open' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(i)}
                      className="ls-faq-trigger"
                      aria-expanded={isOpen}
                    >
                      <span className="ls-faq-q">{item.question}</span>
                      <span className="ls-faq-chev" aria-hidden>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path
                            d="M6 9l6 6 6-6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    </button>
                    <div className="ls-faq-body">
                      <p>{item.answer}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div
              className="ls-callout mx-auto mt-12 max-w-3xl"
              style={{ textAlign: 'center' }}
            >
              <p
                style={{
                  fontFamily: 'var(--ls-mono)',
                  fontSize: '11px',
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  color: 'var(--ls-ink-faint)',
                  marginBottom: '0.6rem',
                }}
              >
                {t('faq.stillWondering')}
              </p>
              <p>{t('faq.stillWonderingBody')}</p>
              <div
                style={{
                  marginTop: '1.1rem',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.8rem 1.2rem',
                }}
              >
                <Button variant="primary" size="sm" onClick={openBookingModal}>
                  {t('faq.bookCall')}
                </Button>
                <Link
                  href="/contact"
                  className="ls-link"
                  style={{ color: 'var(--ls-ink)' }}
                >
                  {t('faq.sendMessage')}
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>
    </MarketingShell>
  );
}
