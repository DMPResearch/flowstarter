'use client';

import { useState, useCallback } from 'react';
import { MarketingShell, PageHero } from '@/components/marketing';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { PreQualModal } from '../components/PreQualModalLazy';

const PAIN_COUNT = 4;
const INCLUDED_COUNT = 8;

const painCardStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '0.85rem',
  padding: '1.6rem 1.55rem',
} as const;

const painTitleStyle = {
  fontFamily: 'var(--ls-sans)',
  fontWeight: 600,
  fontSize: '1.05rem',
  letterSpacing: '-0.015em',
  color: 'var(--ls-ink)',
  lineHeight: 1.25,
} as const;

const painBodyStyle = {
  fontFamily: 'var(--ls-sans)',
  fontSize: '0.92rem',
  lineHeight: 1.55,
  color: 'var(--ls-ink-dim)',
  margin: 0,
} as const;

const painNumStyle = {
  fontFamily: 'var(--ls-mono)',
  fontSize: '10.5px',
  letterSpacing: '0.22em',
  color: 'var(--ls-accent-warm)',
} as const;

const labelStyle = {
  display: 'block',
  fontFamily: 'var(--ls-mono)',
  fontSize: '10.5px',
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: 'var(--ls-ink-faint)',
  marginBottom: '0.55rem',
};

const inputStyle = {
  width: '100%',
  fontFamily: 'var(--ls-sans)',
  fontSize: '0.95rem',
  padding: '0.85rem 1rem',
  borderRadius: '12px',
  border: '1px solid var(--ls-rule)',
  background: 'var(--ls-glass-bg)',
  color: 'var(--ls-ink)',
  outline: 'none',
};

export default function RelaunchPage() {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;

  const painPoints = Array.from({ length: PAIN_COUNT }, (_, i) => ({
    title: t(`relaunch.pain${i + 1}.title`),
    body: t(`relaunch.pain${i + 1}.body`),
  }));

  const whatYouGet = Array.from({ length: INCLUDED_COUNT }, (_, i) =>
    t(`relaunch.included.item${i + 1}`)
  );

  const [url, setUrl] = useState('');
  const [problems, setProblems] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!url.trim()) return;
      sessionStorage.setItem('relaunch_url', url.trim());
      sessionStorage.setItem('relaunch_problems', problems.trim());
      setSubmitted(true);
      setModalOpen(true);
    },
    [url, problems]
  );

  return (
    <MarketingShell withBookingModal={false} withBackground={false}>
      <main id="main-content" className="flex-1">
        <PageHero
          eyebrow={t('relaunch.eyebrow')}
          headlinePrefix={t('relaunch.headlinePrefix')}
          headlineFlourish={t('relaunch.headlineFlourish')}
          sub={t('relaunch.sub')}
        />

        {/* Pain points */}
        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <div className="mx-auto mb-10 max-w-3xl text-center">
              <div className="ls-eyebrow inline-flex items-center justify-center gap-2">
                <span>{t('relaunch.pain.eyebrow')}</span>
              </div>
              <h2
                className="ls-display ls-display--sm mt-6"
                style={{ textWrap: 'balance' }}
              >
                <span className="line">
                  {t('relaunch.pain.headlinePrefix')}
                </span>
                <span className="line flourish mt-2">
                  {t('relaunch.pain.headlineFlourish')}
                </span>
              </h2>
            </div>
            <div className="grid gap-5 sm:gap-6 md:grid-cols-2">
              {painPoints.map((p, i) => (
                <div key={i} className="ls-card" style={painCardStyle}>
                  <h3 style={painTitleStyle}>{p.title}</h3>
                  <p style={painBodyStyle}>{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <hr
          className="ls-page-rule"
          aria-hidden="true"
          style={{ margin: '0 auto', maxWidth: '52rem' }}
        />

        {/* What you get */}
        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <div className="mx-auto mb-10 max-w-3xl text-center">
              <div className="ls-eyebrow inline-flex items-center justify-center gap-2">
                <span>{t('relaunch.included.eyebrow')}</span>
              </div>
              <h2
                className="ls-display ls-display--sm mt-6"
                style={{ textWrap: 'balance' }}
              >
                <span className="line">
                  {t('relaunch.included.headlinePrefix')}
                </span>
                <span className="line flourish mt-2">
                  {t('relaunch.included.headlineFlourish')}
                </span>
              </h2>
              <p className="ls-body ls-body--lead mx-auto mt-6">
                {t('relaunch.included.sub')}
              </p>
            </div>

            <ul
              style={{
                maxWidth: '36rem',
                margin: '0 auto',
                listStyle: 'none',
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              }}
            >
              {whatYouGet.map((item, i) => (
                <li
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.7rem',
                    fontFamily: 'var(--ls-sans)',
                    fontSize: '0.95rem',
                    lineHeight: 1.5,
                    color: 'var(--ls-ink-dim)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      flexShrink: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '20px',
                      height: '20px',
                      borderRadius: '999px',
                      background:
                        'color-mix(in oklab, var(--ls-accent) 14%, transparent)',
                      color: 'var(--ls-accent)',
                      marginTop: '0.1rem',
                    }}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                    >
                      <path
                        d="M5 13l4 4L19 7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <hr
          className="ls-page-rule"
          aria-hidden="true"
          style={{ margin: '0 auto', maxWidth: '52rem' }}
        />

        {/* Intake form */}
        <section className="ls-section ls-section--pad" id="form">
          <div className="ls-container">
            <div
              className="ls-card mx-auto"
              style={{
                maxWidth: '32rem',
                padding: '2rem 1.85rem',
              }}
            >
              <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                <h2
                  className="ls-display ls-display--sm"
                  style={{ textWrap: 'balance' }}
                >
                  <span className="line">
                    {submitted
                      ? t('relaunch.form.titleDone')
                      : t('relaunch.form.titlePending')}
                  </span>
                </h2>
                <p
                  className="ls-body"
                  style={{
                    fontSize: '0.95rem',
                    margin: '0.7rem auto 0',
                    maxWidth: '28ch',
                  }}
                >
                  {submitted
                    ? t('relaunch.form.subDone')
                    : t('relaunch.form.subPending')}
                </p>
              </div>

              {!submitted ? (
                <form
                  onSubmit={handleSubmit}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1rem',
                  }}
                >
                  <div>
                    <label htmlFor="site-url" style={labelStyle}>
                      {t('relaunch.form.urlLabel')}
                    </label>
                    <input
                      id="site-url"
                      type="url"
                      required
                      placeholder="https://yoursite.com"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      style={inputStyle}
                    />
                  </div>

                  <div>
                    <label htmlFor="site-problems" style={labelStyle}>
                      {t('relaunch.form.problemsLabel')}
                    </label>
                    <textarea
                      id="site-problems"
                      rows={3}
                      placeholder={t('relaunch.form.problemsPlaceholder')}
                      value={problems}
                      onChange={(e) => setProblems(e.target.value)}
                      style={{
                        ...inputStyle,
                        resize: 'vertical' as const,
                        minHeight: '6rem',
                      }}
                    />
                  </div>

                  <Button
                    type="submit"
                    size="lg"
                    className="ls-cta-hero w-full rounded-2xl"
                  >
                    {t('relaunch.form.submit')}
                    <svg
                      className="ml-2 h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.4}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 12h14m-5-6l6 6-6 6"
                      />
                    </svg>
                  </Button>

                  <p
                    style={{
                      textAlign: 'center',
                      fontFamily: 'var(--ls-mono)',
                      fontSize: '10.5px',
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      color: 'var(--ls-ink-faint)',
                      marginTop: '0.2rem',
                    }}
                  >
                    {t('relaunch.form.note')}
                  </p>
                </form>
              ) : (
                <div style={{ textAlign: 'center' }}>
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '56px',
                      height: '56px',
                      borderRadius: '999px',
                      background:
                        'color-mix(in oklab, var(--ls-accent) 14%, transparent)',
                      color: 'var(--ls-accent)',
                      marginBottom: '1rem',
                    }}
                  >
                    <svg
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path
                        d="M5 13l4 4L19 7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <p
                    className="ls-body"
                    style={{ fontSize: '0.95rem', marginBottom: '1.4rem' }}
                  >
                    {t('relaunch.form.reviewPrefix')}{' '}
                    <span
                      style={{
                        fontFamily: 'var(--ls-mono)',
                        fontSize: '0.82rem',
                        color: 'var(--ls-ink)',
                      }}
                    >
                      {url}
                    </span>{' '}
                    {t('relaunch.form.reviewSuffix')}
                  </p>
                  <Button
                    size="lg"
                    className="ls-cta-hero w-full rounded-2xl"
                    onClick={() => setModalOpen(true)}
                  >
                    {t('relaunch.form.pickTime')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Guarantee */}
        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <p
              className="ls-body mx-auto"
              style={{
                maxWidth: '32rem',
                fontSize: '0.92rem',
                textAlign: 'center',
                color: 'var(--ls-ink-faint)',
              }}
            >
              {t('relaunch.guarantee')}
            </p>
          </div>
        </section>
      </main>

      <PreQualModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        source="relaunch-page"
        initialPlan="relaunch"
      />
    </MarketingShell>
  );
}
