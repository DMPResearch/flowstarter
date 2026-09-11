import Link from 'next/link';

import { tServer } from '@/lib/i18n-server';
import { LANDING_COPY } from '../landing-copy';

/**
 * Client testimonials — sits between Proof and Pricing so the social proof
 * lands right before the price. Server component, ls-* design system, mirrors
 * the editorial language of ProofSection (hairline rules, mono indices, no
 * decorative gradients). Data lives in `LANDING_COPY.testimonials.items`.
 */
export function TestimonialsSection() {
  const t = tServer as (key: string) => string;
  const testimonials = LANDING_COPY.testimonials;
  const isSingle = testimonials.items.length === 1;

  return (
    <section
      id="testimonials"
      className="ls-scope ls-section ls-section--pad ls-fade-top"
    >
      <div className="ls-mesh" aria-hidden />
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
            <span className="num">{t('landing.testimonials.eyebrow')}</span>
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
            <span className="line">
              {t('landing.testimonials.headlinePrefix')}
            </span>
            <span className="line flourish mt-2">
              {t('landing.testimonials.headlineFlourish')}
            </span>
          </h2>
        </div>

        <ul
          className={`mt-14 grid grid-cols-1 gap-4 lg:gap-5 ${
            isSingle ? 'mx-auto max-w-3xl' : 'md:grid-cols-2'
          }`}
          style={{
            listStyle: 'none',
            padding: 0,
            margin: isSingle ? '3.5rem auto 0' : '3.5rem 0 0',
          }}
        >
          {testimonials.items.map((item, i) => (
            <li
              key={item.slug}
              style={{
                minWidth: 0,
                animation: `ls-reveal 800ms cubic-bezier(0.19,1,0.22,1) ${
                  i * 90
                }ms both`,
              }}
            >
              <figure
                className="ls-card flex h-full flex-col justify-between"
                style={{ padding: '1.75rem 1.75rem 1.5rem', margin: 0 }}
              >
                <blockquote
                  className="ls-body"
                  style={{
                    margin: 0,
                    fontSize: '1.02rem',
                    lineHeight: 1.6,
                    color: 'var(--ls-ink)',
                  }}
                >
                  &ldquo;{item.quote}&rdquo;
                </blockquote>
                <figcaption
                  className="mt-6 flex items-baseline justify-between gap-3"
                  style={{
                    borderTop: '1px solid var(--ls-rule)',
                    paddingTop: '1rem',
                  }}
                >
                  <span>
                    <span
                      style={{
                        display: 'block',
                        fontWeight: 600,
                        color: 'var(--ls-ink)',
                      }}
                    >
                      {item.name}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: '0.85rem',
                        color: 'var(--ls-ink-faint)',
                      }}
                    >
                      {item.role}
                    </span>
                  </span>
                  <Link
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                    className="ls-link"
                    style={{ fontSize: '0.82rem', whiteSpace: 'nowrap' }}
                  >
                    {t('landing.testimonials.cta')} →
                  </Link>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
