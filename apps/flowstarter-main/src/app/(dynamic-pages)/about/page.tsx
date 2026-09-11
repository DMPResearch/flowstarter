import Image from 'next/image';
import { MarketingShell, PageHero } from '@/components/marketing';
import { tServer } from '@/lib/i18n-server';
import { AboutCtaBand } from './AboutCtaBand';

export const metadata = {
  title: 'About',
  description:
    'Flowstarter is a two-person studio, Darius and Dorin, hand-building premium websites for service professionals across Europe.',
};

const founderCardStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '1rem',
  padding: '1.75rem 1.65rem 1.65rem',
} as const;

const founderAvatarStyle = {
  width: '72px',
  height: '72px',
  borderRadius: '999px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background:
    'linear-gradient(135deg, color-mix(in oklab, var(--ls-accent) 18%, var(--ls-glass-bg)), var(--ls-glass-bg) 70%)',
  border: '1px solid color-mix(in oklab, var(--ls-accent) 25%, var(--ls-rule))',
  fontFamily: 'var(--ls-sans)',
  fontWeight: 600,
  fontSize: '1.6rem',
  letterSpacing: '-0.02em',
  color: 'var(--ls-ink)',
} as const;

const founderNameRowStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '0.2rem',
} as const;

const founderNameStyle = {
  fontFamily: 'var(--ls-sans)',
  fontWeight: 600,
  fontSize: '1.25rem',
  letterSpacing: '-0.02em',
  color: 'var(--ls-ink)',
  lineHeight: 1.2,
} as const;

const founderRoleStyle = {
  fontFamily: 'var(--ls-mono)',
  fontSize: '10.5px',
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: 'var(--ls-accent)',
} as const;

const founderBioStyle = {
  fontFamily: 'var(--ls-sans)',
  fontSize: '0.95rem',
  lineHeight: 1.6,
  color: 'var(--ls-ink-dim)',
  margin: 0,
} as const;

const founderMetaStyle = {
  fontFamily: 'var(--ls-mono)',
  fontSize: '10.5px',
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: 'var(--ls-ink-faint)',
  marginTop: 'auto',
  paddingTop: '1.1rem',
  borderTop: '1px solid var(--ls-rule)',
} as const;

const principleTitleStyle = {
  fontFamily: 'var(--ls-sans)',
  fontWeight: 600,
  fontSize: '1.1rem',
  letterSpacing: '-0.02em',
  color: 'var(--ls-ink)',
  lineHeight: 1.2,
} as const;

const principleNumberStyle = {
  fontFamily: 'var(--ls-mono)',
  fontSize: '10.5px',
  letterSpacing: '0.22em',
  color: 'var(--ls-accent)',
} as const;

const principleBodyStyle = {
  fontFamily: 'var(--ls-sans)',
  fontSize: '0.92rem',
  lineHeight: 1.6,
  color: 'var(--ls-ink-dim)',
  margin: 0,
} as const;

const stepNumStyle = {
  fontFamily: 'var(--ls-mono)',
  fontSize: '0.78rem',
  letterSpacing: '0.22em',
  color: 'var(--ls-accent)',
  marginBottom: '0.85rem',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.55rem',
} as const;

const stepTitleStyle = {
  fontFamily: 'var(--ls-sans)',
  fontSize: '1.1rem',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  lineHeight: 1.2,
  color: 'var(--ls-ink)',
  marginBottom: '0.55rem',
} as const;

const stepBodyStyle = {
  fontFamily: 'var(--ls-sans)',
  fontSize: '0.92rem',
  lineHeight: 1.55,
  color: 'var(--ls-ink-dim)',
  maxWidth: '38ch',
  margin: 0,
} as const;

export default function AboutPage() {
  const t = tServer as (key: string) => string;

  const principles = [
    { title: t('about.principle1.title'), body: t('about.principle1.body') },
    { title: t('about.principle2.title'), body: t('about.principle2.body') },
    { title: t('about.principle3.title'), body: t('about.principle3.body') },
  ];

  const steps = [
    { title: t('about.step1.title'), body: t('about.step1.body') },
    { title: t('about.step2.title'), body: t('about.step2.body') },
    { title: t('about.step3.title'), body: t('about.step3.body') },
  ];

  return (
    <MarketingShell>
      <main id="main-content" className="flex-1">
        <PageHero
          eyebrow={t('about.eyebrow')}
          headlinePrefix={t('about.headlinePrefix')}
          headlineFlourish={t('about.headlineFlourish')}
          sub={t('about.sub')}
        />

        {/* Zone 2 — Founders */}
        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <div className="grid gap-6 sm:gap-7 md:grid-cols-2">
              {/* Darius */}
              <div className="ls-card" style={founderCardStyle}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '1.1rem',
                  }}
                >
                  <Image
                    src="/images/team/darius.png"
                    alt="Darius"
                    width={72}
                    height={72}
                    style={{ borderRadius: '999px', objectFit: 'cover' }}
                  />
                  <div style={founderNameRowStyle}>
                    <span style={founderNameStyle}>
                      {t('about.darius.name')}
                    </span>
                    <span style={founderRoleStyle}>
                      {t('about.darius.role')}
                    </span>
                  </div>
                </div>
                <p style={founderBioStyle}>{t('about.darius.bio1')}</p>
                <p style={founderBioStyle}>{t('about.darius.bio2')}</p>
                <div style={founderMetaStyle}>{t('about.darius.meta')}</div>
              </div>

              {/* Dorin */}
              <div className="ls-card" style={founderCardStyle}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '1.1rem',
                  }}
                >
                  <Image
                    src="/images/team/dorin.jpeg"
                    alt="Dorin"
                    width={72}
                    height={72}
                    style={{ borderRadius: '999px', objectFit: 'cover' }}
                  />
                  <div style={founderNameRowStyle}>
                    <span style={founderNameStyle}>
                      {t('about.dorin.name')}
                    </span>
                    <span style={founderRoleStyle}>
                      {t('about.dorin.role')}
                    </span>
                  </div>
                </div>
                <p style={founderBioStyle}>{t('about.dorin.bio1')}</p>
                <p style={founderBioStyle}>{t('about.dorin.bio2')}</p>
                <div style={founderMetaStyle}>{t('about.dorin.meta')}</div>
              </div>
            </div>
          </div>
        </section>

        <hr
          className="ls-page-rule"
          aria-hidden="true"
          style={{ margin: '0 auto', maxWidth: '52rem' }}
        />

        {/* Zone 3 — Manifesto */}
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
                <span className="num">{t('about.manifesto.eyebrow')}</span>
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
                <span className="line">
                  {t('about.manifesto.headlinePrefix')}
                </span>
                <span className="line flourish mt-2">
                  {t('about.manifesto.headlineFlourish')}
                </span>
              </h2>

              <div
                style={{
                  marginTop: 'clamp(2rem, 4vh, 2.75rem)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1.3rem',
                }}
              >
                <p className="ls-body ls-body--lead mx-auto">
                  {t('about.manifesto.p1')}
                </p>
                <p className="ls-body ls-body--lead mx-auto">
                  {t('about.manifesto.p2')}
                </p>
              </div>

              <p
                className="mx-auto mt-10"
                style={{
                  fontFamily: 'var(--ls-mono)',
                  fontSize: '11px',
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'var(--ls-ink-faint)',
                  fontStyle: 'italic',
                }}
              >
                {t('about.manifesto.closing')}
              </p>
            </div>
          </div>
        </section>

        <hr
          className="ls-page-rule"
          aria-hidden="true"
          style={{ margin: '0 auto', maxWidth: '52rem' }}
        />

        {/* Zone 4 — Principles */}
        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <div className="mx-auto mb-10 max-w-3xl text-center">
              <div className="ls-eyebrow inline-flex items-center justify-center gap-2">
                <span>{t('about.principles.eyebrow')}</span>
              </div>
              <h2
                className="ls-display ls-display--sm mt-6"
                style={{ textWrap: 'balance' }}
              >
                <span className="line">
                  {t('about.principles.headlinePrefix')}
                </span>
                <span className="line flourish mt-2">
                  {t('about.principles.headlineFlourish')}
                </span>
              </h2>
            </div>

            <div className="grid gap-5 sm:gap-6 md:grid-cols-3">
              {principles.map((p, i) => (
                <div
                  key={p.title}
                  className="ls-card"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.65rem',
                    padding: '1.65rem 1.55rem',
                  }}
                >
                  <h3 style={principleTitleStyle}>{p.title}</h3>
                  <p style={principleBodyStyle}>{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Zone 5 — What to expect */}
        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <div className="mx-auto mb-10 max-w-3xl text-center">
              <div className="ls-eyebrow inline-flex items-center justify-center gap-2">
                <span>{t('about.steps.eyebrow')}</span>
              </div>
              <h2
                className="ls-display ls-display--sm mt-6"
                style={{ textWrap: 'balance' }}
              >
                <span className="line">{t('about.steps.headlinePrefix')}</span>
                <span className="line flourish mt-2">
                  {t('about.steps.headlineFlourish')}
                </span>
              </h2>
            </div>

            <div className="grid gap-5 sm:gap-6 md:grid-cols-3">
              {steps.map((step, i) => (
                <div
                  key={i}
                  className="ls-card"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '1.65rem 1.55rem 1.65rem',
                  }}
                >
                  <h3 style={stepTitleStyle}>{step.title}</h3>
                  <p style={stepBodyStyle}>{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Zone 6 — CTA band */}
        <AboutCtaBand />
      </main>
    </MarketingShell>
  );
}
