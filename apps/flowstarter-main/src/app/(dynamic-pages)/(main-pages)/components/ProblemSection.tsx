import { tServer } from '@/lib/i18n-server';
import { LandingIcon, type IconName } from './LandingIcons';
import { LANDING_COPY } from '../landing-copy';

export function ProblemSection() {
  const t = tServer as (key: string) => string;
  const problem = LANDING_COPY.problem;

  return (
    <section
      id="problem"
      className="ls-scope ls-section ls-section--pad ls-fade-top"
    >
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
            <span className="num">{t('landing.problem.eyebrow')}</span>
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
            <span className="line">{t('landing.problem.headlinePrefix')}</span>
            <span className="line flourish mt-2">
              {t('landing.problem.headlineFlourish')}
            </span>
          </h2>

          <p className="ls-body ls-body--lead mt-7 mx-auto">
            {t('landing.problem.sub')}
          </p>
        </div>

        <div className="ls-problem-grid mt-14 grid gap-5 md:grid-cols-3 md:gap-6">
          {problem.pains.map((pain, i) => (
            <div
              key={pain.title}
              className="ls-card ls-problem-card"
              style={{
                animation: `ls-reveal 900ms cubic-bezier(0.19,1,0.22,1) ${
                  i * 100
                }ms both`,
              }}
            >
              <div className="ls-problem-icon">
                <LandingIcon name={pain.icon as IconName} className="h-4 w-4" />
              </div>
              <h3 className="ls-problem-title">{pain.title}</h3>
              <p className="ls-problem-body">{pain.body}</p>
            </div>
          ))}
        </div>

        <p className="ls-problem-closing mx-auto mt-14 max-w-2xl text-center">
          {problem.closing}
        </p>
      </div>
    </section>
  );
}
