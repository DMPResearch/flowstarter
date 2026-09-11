'use client';

import Link from 'next/link';
import { Calendar, Mail, MessageCircle } from 'lucide-react';
import { Button } from '@flowstarter/flow-design-system';
import { MarketingShell, PageHero } from '@/components/marketing';
import { useI18n } from '@/lib/i18n';
import { useBookingModal } from '@/app/(dynamic-pages)/(main-pages)/components/booking-modal-store';
import { useFAQAccordion } from '@/app/(dynamic-pages)/(main-pages)/components/hooks/useFAQAccordion';

// FAQ items built from translation keys; link hrefs stay hardcoded (not translatable).
const FAQ_LINKS: Record<number, { href: string; labelKey: string }[]> = {
  1: [{ href: '/pricing', labelKey: 'help.faq2.linkLabel' }],
  3: [{ href: '/terms', labelKey: 'help.faq4.linkLabel' }],
  5: [{ href: '/pricing', labelKey: 'help.faq6.linkLabel' }],
  8: [{ href: '/terms', labelKey: 'help.faq9.linkLabel' }],
  9: [{ href: '/privacy', labelKey: 'help.faq10.linkLabel' }],
};

const quickActionCardStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'flex-start',
  gap: '0.85rem',
  height: '100%',
};

const quickActionIconStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '44px',
  height: '44px',
  borderRadius: '12px',
  background: 'color-mix(in oklab, var(--ls-accent) 14%, transparent)',
  color: 'var(--ls-accent)',
  border: '1px solid color-mix(in oklab, var(--ls-accent) 28%, transparent)',
};

export default function HelpPage() {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;
  const openBookingModal = useBookingModal((s) => s.open);
  const { openIndex, toggle } = useFAQAccordion(0);

  const faqItems = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return {
      question: t(`help.faq${n}.question`),
      answer: t(`help.faq${n}.answer`),
      links: FAQ_LINKS[i]?.map((l) => ({ href: l.href, label: t(l.labelKey) })),
    };
  });

  return (
    <MarketingShell>
      <main id="main-content" className="flex-1">
        <PageHero
          eyebrow={t('help.eyebrow')}
          headlinePrefix={t('help.headlinePrefix')}
          headlineFlourish={t('help.headlineFlourish')}
          sub={t('help.sub')}
        />

        {/* Zone 2 — Quick-action cards */}
        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <div className="grid gap-5 sm:gap-6 md:grid-cols-3">
              {/* Card 1 — Book a discovery call */}
              <div className="ls-card" style={quickActionCardStyle}>
                <span style={quickActionIconStyle} aria-hidden="true">
                  <Calendar className="h-5 w-5" />
                </span>
                <h3
                  style={{
                    fontFamily: 'var(--ls-sans)',
                    fontSize: '1.05rem',
                    fontWeight: 600,
                    letterSpacing: '-0.015em',
                    color: 'var(--ls-ink)',
                    lineHeight: 1.25,
                  }}
                >
                  {t('help.card1.title')}
                </h3>
                <p
                  className="ls-body"
                  style={{ fontSize: '0.9rem', margin: 0 }}
                >
                  {t('help.card1.body')}
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={openBookingModal}
                  className="mt-auto"
                  style={{ alignSelf: 'flex-start' }}
                  iconPosition="right"
                  icon={
                    <svg
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 12h14m-5-6l6 6-6 6"
                      />
                    </svg>
                  }
                >
                  {t('help.card1.cta')}
                </Button>
              </div>

              {/* Card 2 — Email us */}
              <div className="ls-card" style={quickActionCardStyle}>
                <span style={quickActionIconStyle} aria-hidden="true">
                  <Mail className="h-5 w-5" />
                </span>
                <h3
                  style={{
                    fontFamily: 'var(--ls-sans)',
                    fontSize: '1.05rem',
                    fontWeight: 600,
                    letterSpacing: '-0.015em',
                    color: 'var(--ls-ink)',
                    lineHeight: 1.25,
                  }}
                >
                  {t('help.card2.title')}
                </h3>
                <p
                  className="ls-body"
                  style={{ fontSize: '0.9rem', margin: 0 }}
                >
                  {t('help.card2.body')}
                </p>
                <a
                  href="mailto:hello@flowstarter.net?subject=Question%20about%20Flowstarter"
                  className="ls-link mt-auto"
                  style={{
                    alignSelf: 'flex-start',
                    fontFamily: 'var(--ls-mono)',
                    fontSize: '0.82rem',
                    letterSpacing: '0.08em',
                    color: 'var(--ls-ink)',
                  }}
                >
                  hello@flowstarter.net
                </a>
              </div>

              {/* Card 3 — Support bot */}
              <div className="ls-card" style={quickActionCardStyle}>
                <span style={quickActionIconStyle} aria-hidden="true">
                  <MessageCircle className="h-5 w-5" />
                </span>
                <h3
                  style={{
                    fontFamily: 'var(--ls-sans)',
                    fontSize: '1.05rem',
                    fontWeight: 600,
                    letterSpacing: '-0.015em',
                    color: 'var(--ls-ink)',
                    lineHeight: 1.25,
                  }}
                >
                  {t('help.card3.title')}
                </h3>
                <p
                  className="ls-body"
                  style={{ fontSize: '0.9rem', margin: 0 }}
                >
                  {t('help.card3.body')}
                </p>
                <span
                  className="ls-pill mt-auto"
                  style={{ alignSelf: 'flex-start' }}
                >
                  {t('help.card3.badge')}
                </span>
              </div>
            </div>
          </div>
        </section>

        <hr
          className="ls-page-rule"
          aria-hidden="true"
          style={{ margin: '0 auto', maxWidth: '52rem' }}
        />

        {/* Zone 3 — FAQ accordion */}
        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <div className="mx-auto max-w-3xl text-center">
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
                <span className="num">{t('help.faq.eyebrow')}</span>
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
                className="ls-display ls-display--sm mt-7"
                style={{ textWrap: 'balance' }}
              >
                <span className="line">{t('help.faq.headlinePrefix')}</span>
                <span className="line flourish mt-2">
                  {t('help.faq.headlineFlourish')}
                </span>
              </h2>
            </div>

            <div className="ls-faq-list mx-auto mt-12 max-w-3xl">
              {faqItems.map((item, i) => {
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
                      {item.links && item.links.length > 0 && (
                        <p style={{ marginTop: '0.6rem' }}>
                          {item.links.map((link, idx) => (
                            <span key={link.href}>
                              {idx > 0 && (
                                <span
                                  style={{
                                    color: 'var(--ls-ink-faint)',
                                    margin: '0 0.5em',
                                  }}
                                >
                                  ·
                                </span>
                              )}
                              <Link
                                href={link.href}
                                style={{
                                  color: 'var(--ls-accent)',
                                  fontWeight: 500,
                                  textDecoration: 'none',
                                  borderBottom:
                                    '1px solid color-mix(in oklab, var(--ls-accent) 30%, transparent)',
                                }}
                              >
                                {link.label} ↗
                              </Link>
                            </span>
                          ))}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Zone 4 — Still stuck? */}
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
                {t('help.stillStuck')}
              </p>
              <p>{t('help.stillStuckBody')}</p>
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
                  {t('help.bookCall')}
                </Button>
                <Link
                  href="/contact"
                  className="ls-link"
                  style={{ color: 'var(--ls-ink)' }}
                >
                  {t('help.sendMessage')}
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>
    </MarketingShell>
  );
}
