import { tServer } from '@/lib/i18n-server';
import { LANDING_COPY } from '../landing-copy';

export function ProcessSection() {
  const t = tServer as (key: string) => string;
  const process = LANDING_COPY.process;

  return (
    <section
      id="process"
      data-section="process"
      className="ls-scope ls-section ls-section--pad"
    >
      <div className="ls-mesh" aria-hidden />{' '}
      <div className="ls-grain" aria-hidden />
      <div className="ls-container">
        <div className="ls-section-intro">
          <h2 className="ls-display" style={{ textWrap: 'balance' }}>
            <span className="line">{t('landing.process.headlinePrefix')}</span>
            <span className="line flourish mt-2">
              {t('landing.process.headlineFlourish')}
            </span>
          </h2>
          <p className="ls-body ls-body--lead">{t('landing.process.sub')}</p>
        </div>

        <div className="ls-process-grid">
          {process.steps.map((step) => (
            <div key={step.title} className="ls-process-card">
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
