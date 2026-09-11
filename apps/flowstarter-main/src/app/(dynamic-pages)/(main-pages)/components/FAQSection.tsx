'use client';

import { useI18n } from '@/lib/i18n';
import { useFAQAccordion } from './hooks/useFAQAccordion';
import { LANDING_COPY } from '../landing-copy';

export function FAQSection() {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;
  const { openIndex, toggle } = useFAQAccordion(0);
  const faq = LANDING_COPY.faq;

  return (
    <section id="faq" className="ls-scope ls-section ls-section--pad">
      <div className="ls-mesh" aria-hidden />{' '}
      <div className="ls-grain" aria-hidden />
      <div className="ls-container">
        <div className="text-center max-w-3xl mx-auto">
          <div
            className="ls-eyebrow inline-flex items-center justify-center gap-3"
            style={{ justifyContent: 'center' }}
          >
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: '28px',
                height: '1px',
                background: 'var(--ls-ink-faint)',
              }}
            />
            <span className="num">{t('landing.faq.eyebrow')}</span>
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
          <h2 className="ls-display mt-7" style={{ textWrap: 'balance' }}>
            <span className="line">{t('landing.faq.headlinePrefix')}</span>
            <span className="line flourish mt-2">
              {t('landing.faq.headlineFlourish')}
            </span>
          </h2>
        </div>

        <div className="ls-faq-list mx-auto mt-14 max-w-3xl">
          {faq.items.map((item, i) => {
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
      </div>
    </section>
  );
}
