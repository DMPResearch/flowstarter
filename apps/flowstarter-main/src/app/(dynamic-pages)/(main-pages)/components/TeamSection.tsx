import { tServer } from '@/lib/i18n-server';
import { LANDING_COPY } from '../landing-copy';

/**
 * Names the agents that build the site and the two people who sign it off.
 *
 * Each card carries what the agent does *and* what it may not do: for a
 * visitor nervous about AI writing their business's words, the boundary is
 * the reassuring half, so it is given equal weight rather than buried.
 */
export function TeamSection() {
  const t = tServer as (key: string) => string;
  const { agents, humans } = LANDING_COPY.team;

  return (
    <section id="team" className="ls-scope ls-section ls-section--pad">
      <div className="ls-mesh" aria-hidden />
      <div className="ls-grain" aria-hidden />
      <div className="ls-container">
        <div className="ls-section-intro">
          <h2 className="ls-display" style={{ textWrap: 'balance' }}>
            <span className="line">{t('landing.team.headlinePrefix')}</span>
            <span className="line flourish mt-2">
              {t('landing.team.headlineFlourish')}
            </span>
          </h2>
          <p className="ls-body ls-body--lead">{t('landing.team.sub')}</p>
        </div>

        <h3 className="ls-eyebrow ls-team-label">
          {t('landing.team.agentsLabel')}
        </h3>
        <ul className="ls-team-grid">
          {agents.map((agent, index) => (
            <li key={agent.role} className="ls-card ls-team-card">
              <span className="ls-team-card__index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h4 className="ls-team-card__role">{agent.role}</h4>
              <p className="ls-team-card__does">{agent.does}</p>
              <p className="ls-team-card__limit">{agent.limit}</p>
            </li>
          ))}
        </ul>

        <h3 className="ls-eyebrow ls-team-label ls-team-label--humans">
          {t('landing.team.humansLabel')}
        </h3>
        <ul className="ls-team-grid ls-team-grid--humans">
          {humans.map((person) => (
            <li
              key={person.name}
              className="ls-card ls-team-card ls-team-card--human"
            >
              <h4 className="ls-team-card__role">
                {person.name}
                <span className="ls-team-card__title"> · {person.role}</span>
              </h4>
              <p className="ls-team-card__does">{person.does}</p>
            </li>
          ))}
        </ul>
        <p className="ls-body ls-team-note">{t('landing.team.humansNote')}</p>
      </div>
    </section>
  );
}
