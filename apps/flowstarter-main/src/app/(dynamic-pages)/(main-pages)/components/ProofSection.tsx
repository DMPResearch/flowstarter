import Image from 'next/image';
import { withAssetVersion } from '@/utils/asset-version';
import Link from 'next/link';

import { tServer } from '@/lib/i18n-server';
import { LANDING_COPY } from '../landing-copy';
import { SectionEyebrow } from './SectionEyebrow';

/**
 * The proof shelf — a small, considered grid of work and starter templates.
 *
 * Lives between Audience and Pricing on the landing page. Mirrors the
 * editorial language of `library.flowstarter.net` (Playfair italic accent,
 * hairline rules, mono indices, no decorative gradients) while staying
 * inside the existing `ls-*` design system so it doesn't look like a
 * foreign island.
 *
 * The data is in `LANDING_COPY.proof.items`. Each card is a link — items
 * with a `href` ending in `library.flowstarter.net` will eventually open
 * the live library; items pointing to real client URLs (e.g. ux-journey.com)
 * open the live site.
 */
export function ProofSection() {
  const t = tServer as (key: string) => string;
  const proof = LANDING_COPY.proof;

  return (
    <section
      id="proof"
      className="ls-scope ls-section ls-section--pad ls-fade-top"
    >
      <div className="ls-mesh" aria-hidden />
      <div className="ls-grain" aria-hidden />

      <div className="ls-container">
        <div className="text-center max-w-3xl mx-auto">
          <SectionEyebrow index="03" label={t('landing.proof.eyebrow')} />

          <h2 className="ls-display mt-7" style={{ textWrap: 'balance' }}>
            <span className="line">{t('landing.proof.headlinePrefix')}</span>
            <span className="line flourish mt-2">
              {t('landing.proof.headlineFlourish')}
            </span>
          </h2>

          <p className="ls-body ls-body--lead mt-7 mx-auto">
            {t('landing.proof.sub')}
          </p>
        </div>

        <ul
          className="ls-proof-grid mt-14"
          style={{ listStyle: 'none', padding: 0, margin: '3.5rem 0 0' }}
        >
          {proof.items.map((item, i) => (
            <li
              key={item.slug}
              style={{
                minWidth: 0,
                animation: `ls-reveal 800ms cubic-bezier(0.19,1,0.22,1) ${
                  i * 70
                }ms both`,
              }}
            >
              <Link
                href={item.href}
                {...(item.external
                  ? { target: '_blank', rel: 'noreferrer' }
                  : {})}
                className="ls-proof-card"
                aria-label={`${item.title}: ${item.kicker}`}
              >
                <div className="ls-proof-frame">
                  {item.thumbnail ? (
                    <>
                      <Image
                        src={withAssetVersion(item.thumbnail)}
                        alt={`${item.title} preview`}
                        width={1200}
                        height={750}
                        quality={75}
                        sizes="(min-width: 1080px) 380px, (min-width: 720px) 45vw, 92vw"
                        className="ls-proof-thumb ls-proof-thumb--light"
                      />
                      {item.thumbnailDark ? (
                        <Image
                          src={withAssetVersion(item.thumbnailDark)}
                          alt={`${item.title} preview dark`}
                          width={1200}
                          height={750}
                          quality={75}
                          sizes="(min-width: 1080px) 380px, (min-width: 720px) 45vw, 92vw"
                          className="ls-proof-thumb ls-proof-thumb--dark"
                        />
                      ) : null}
                    </>
                  ) : item.placeholder ? (
                    <div
                      className="ls-proof-frame--type"
                      style={{ position: 'absolute', inset: 0 }}
                    >
                      <div>
                        <div className="ls-proof-typeplate">
                          {item.placeholder}
                        </div>
                        <div className="ls-proof-typeplate-meta">
                          shipped · 2026
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="ls-proof-caption">
                  <h3 className="ls-proof-title">{item.title}</h3>
                  <span className="ls-proof-meta">{item.meta}</span>
                  <p className="ls-proof-kicker">{item.kicker}</p>
                  <span
                    className={`ls-proof-status ls-proof-status--${
                      item.status === 'live' ? 'live' : 'soon'
                    }`}
                    style={{ gridColumn: '1 / -1' }}
                  >
                    {item.status === 'live'
                      ? t('landing.proof.statusLive')
                      : t('landing.proof.statusSoon')}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>

        <div className="ls-proof-cta-row">
          <span className="ls-proof-foot">
            {proof.items.length} entries · the shelf grows as we ship
          </span>
          <Link
            href={proof.libraryUrl}
            target="_blank"
            rel="noreferrer"
            className="ls-proof-cta"
          >
            {t('landing.proof.cta')}
          </Link>
        </div>
      </div>
    </section>
  );
}
