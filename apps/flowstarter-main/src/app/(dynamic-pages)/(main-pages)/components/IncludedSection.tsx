import { tServer } from '@/lib/i18n-server';
import { LandingIcon, type IconName } from './LandingIcons';
import { LANDING_COPY } from '../landing-copy';

export function IncludedSection() {
  const t = tServer as (key: string) => string;
  const included = LANDING_COPY.included;

  return (
    <section id="included" className="ls-scope ls-section ls-section--pad">
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
            <span className="num">{t('landing.included.eyebrow')}</span>
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
            <span className="line">{t('landing.included.headlinePrefix')}</span>
            <span className="line flourish mt-2">
              {t('landing.included.headlineFlourish')}
            </span>
          </h2>

          <p className="ls-body ls-body--lead mt-7 mx-auto">
            {t('landing.included.sub')}
          </p>
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
          {included.cards.map((c, i) => (
            <div
              key={c.title}
              className="ls-card ls-included-card"
              style={{
                animation: `ls-reveal 900ms cubic-bezier(0.19,1,0.22,1) ${
                  i * 70
                }ms both`,
              }}
            >
              <div className="ls-included-icon" aria-hidden="true">
                <LandingIcon name={c.icon as IconName} className="h-4 w-4" />
              </div>
              <h3 className="ls-included-title">{c.title}</h3>
              <p className="ls-included-body">{c.description}</p>
            </div>
          ))}

          {/* Ownership promise — featured line item */}
          <div
            className="ls-card ls-included-card ls-included-card--featured"
            style={{
              animation: `ls-reveal 900ms cubic-bezier(0.19,1,0.22,1) ${
                included.cards.length * 70
              }ms both`,
            }}
          >
            <div className="ls-included-icon ls-included-icon--accent">
              <LandingIcon name={'layers' as IconName} className="h-4 w-4" />
            </div>
            <h3 className="ls-included-title">
              {t('landing.included.ownership.title')}
            </h3>
            <p className="ls-included-body">
              {t('landing.included.ownership.body')}
            </p>
            <div className="ls-included-chips">
              <span className="ls-included-chip">
                {t('landing.included.ownership.chip1Label')}{' '}
                <b>{t('landing.included.ownership.chip1Value')}</b>
              </span>
              <span className="ls-included-chip">
                {t('landing.included.ownership.chip2Label')}{' '}
                <b>{t('landing.included.ownership.chip2Value')}</b>
              </span>
              <span className="ls-included-chip">
                {t('landing.included.ownership.chip3Label')}{' '}
                <b>{t('landing.included.ownership.chip3Value')}</b>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
