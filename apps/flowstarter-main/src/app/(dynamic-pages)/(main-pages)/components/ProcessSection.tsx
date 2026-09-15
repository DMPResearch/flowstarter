import { tServer } from '@/lib/i18n-server';
import { LANDING_COPY } from '../landing-copy';
import { landingNavIndex } from '../landing-nav';
import { SectionEyebrow } from './SectionEyebrow';

export function ProcessSection() {
  const t = tServer as (key: string) => string;
  const process = LANDING_COPY.process;

  return (
    <section
      id="process"
      data-section="process"
      className="ls-scope ls-section ls-section--pad scroll-mt-24"
    >
      <div className="ls-mesh" aria-hidden />{' '}
      <div className="ls-grain" aria-hidden />
      <div className="ls-container">
        <div className="ls-section-intro">
          <SectionEyebrow
            index={landingNavIndex('process')}
            label={t('landing.process.eyebrow')}
            align="left"
          />
          <h2 className="ls-display mt-7" style={{ textWrap: 'balance' }}>
            <span className="line">{t('landing.process.headlinePrefix')}</span>
            <span className="line flourish mt-2">
              {t('landing.process.headlineFlourish')}
            </span>
          </h2>
          <p className="ls-body ls-body--lead">{t('landing.process.sub')}</p>
        </div>

        <div className="ls-process-grid">
          {process.steps.map((step, i) => (
            // The steps arrive in order, eight pixels and a beat apart, which
            // is the one place on this page where motion carries meaning:
            // this is a sequence, and it reads as one.
            <div
              key={step.title}
              className="ls-process-card ls-rise"
              style={
                { '--ls-rise-delay': `${i * 80}ms` } as React.CSSProperties
              }
            >
              <div className="ls-process-num">{step.number}</div>
              <h3 className="ls-process-title">{step.title}</h3>
              <p className="ls-process-body">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
