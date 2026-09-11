import Link from 'next/link';

import { tServer } from '@/lib/i18n-server';
import { LANDING_COPY } from '../landing-copy';
import { SectionEyebrow } from './SectionEyebrow';

/**
 * The first letter of the first two words of a name. Latin-1 friendly, which
 * is what the client list actually contains; a name that yields nothing
 * (initials of "" is "") leaves an empty disc rather than a placeholder
 * glyph, which is the honest failure here.
 */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('');
}

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
          <SectionEyebrow
            index="04"
            label={t('landing.testimonials.eyebrow')}
          />

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
              className="ls-rise"
              style={
                {
                  minWidth: 0,
                  '--ls-rise-delay': `${i * 90}ms`,
                } as React.CSSProperties
              }
            >
              <figure
                className="ls-card flex h-full flex-col justify-between"
                style={{ padding: '1.75rem 1.75rem 1.5rem', margin: 0 }}
              >
                {/* A real opening quotation mark, hung into the margin at
                    display size, rather than a pair of straight ASCII ticks
                    inline with the first word. The closing mark is dropped:
                    one hung mark reads as a pull quote, two read as speech. */}
                <blockquote
                  className="ls-body ls-quote"
                  style={{
                    margin: 0,
                    fontSize: '1.02rem',
                    lineHeight: 1.6,
                    color: 'var(--ls-ink)',
                  }}
                >
                  {item.quote}
                </blockquote>
                <figcaption
                  className="mt-6 flex items-center justify-between gap-3"
                  style={{
                    borderTop: '1px solid var(--ls-rule)',
                    paddingTop: '1rem',
                  }}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    {/* Initials, not a stock face and not a silhouette icon:
                        the name is the only thing about this person we
                        actually have, so it is the only thing the disc
                        claims. */}
                    <span className="ls-avatar" aria-hidden="true">
                      {initials(item.name)}
                    </span>
                    <span className="min-w-0">
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
