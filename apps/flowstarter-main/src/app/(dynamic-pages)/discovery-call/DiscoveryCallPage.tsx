'use client';

/**
 * The visible half of `/discovery-call`.
 *
 * Two states, and which one renders is decided by the server component above
 * rather than here: a booking URL means the calendar, no booking URL means the
 * form. There is deliberately no third state where the page apologises for not
 * having a calendar -- from the visitor's side "pick a time" and "tell us and
 * we will write back" are both a way of getting the call, and only one of them
 * is a worse experience if it is dressed up as a fallback.
 *
 * The form files the same `custom_work_leads` row a booking offer does, through
 * `/api/discovery-call/lead`, so Darius's lane on the pipeline board is one
 * list however the lead arrived.
 */
import { useState } from 'react';
import { Button } from '@flowstarter/flow-design-system';
import { MarketingShell, PageHero } from '@/components/marketing';
import { useI18n } from '@/lib/i18n';

const EXPECT_KEYS = [
  'discoveryCall.expect.one',
  'discoveryCall.expect.two',
  'discoveryCall.expect.three',
] as const;

const inputClass =
  'w-full rounded-xl border border-[var(--ls-rule)] bg-[var(--ls-glass-bg)] px-4 py-3 text-[0.95rem] text-[var(--ls-ink)] outline-none';

const labelClass =
  'mb-2 block font-mono text-[10.5px] uppercase tracking-[0.2em] text-[var(--ls-ink-faint)]';

function EnquiryForm({ t }: { t: (key: string) => string }) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    linkUrl: '',
    description: '',
    // Honeypot. Never shown, always sent, same shape as `/contact`.
    website: '',
  });
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (status === 'sent') {
    return (
      <div className="ls-card p-7" role="status">
        <h2 className="text-xl font-semibold text-[var(--ls-ink)]">
          {t('discoveryCall.form.successTitle')}
        </h2>
        <p className="mt-2 text-sm text-[var(--ls-ink-faint)]">
          {t('discoveryCall.form.successBody')}
        </p>
      </div>
    );
  }

  return (
    <form
      className="ls-card flex flex-col gap-4 p-7"
      onSubmit={async (event) => {
        event.preventDefault();
        setStatus('sending');
        setError(null);
        try {
          const res = await fetch('/api/discovery-call/lead', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form),
          });
          if (!res.ok) throw new Error('request failed');
          setStatus('sent');
        } catch {
          setStatus('idle');
          setError(t('discoveryCall.form.error'));
        }
      }}
    >
      <div>
        <h2 className="text-xl font-semibold text-[var(--ls-ink)]">
          {t('discoveryCall.form.title')}
        </h2>
        <p className="mt-1 text-sm text-[var(--ls-ink-faint)]">
          {t('discoveryCall.form.body')}
        </p>
      </div>

      <div>
        <label className={labelClass} htmlFor="dc-name">
          {t('discoveryCall.form.name')}
        </label>
        <input
          id="dc-name"
          className={inputClass}
          value={form.name}
          required
          maxLength={200}
          placeholder={t('discoveryCall.form.namePlaceholder')}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="dc-email">
          {t('discoveryCall.form.email')}
        </label>
        <input
          id="dc-email"
          type="email"
          className={inputClass}
          value={form.email}
          required
          maxLength={320}
          placeholder={t('discoveryCall.form.emailPlaceholder')}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="dc-link">
          {t('discoveryCall.form.link')}
        </label>
        <input
          id="dc-link"
          className={inputClass}
          value={form.linkUrl}
          maxLength={300}
          placeholder={t('discoveryCall.form.linkPlaceholder')}
          onChange={(e) => setForm((f) => ({ ...f, linkUrl: e.target.value }))}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="dc-description">
          {t('discoveryCall.form.description')}
        </label>
        <textarea
          id="dc-description"
          className={inputClass}
          rows={5}
          value={form.description}
          required
          minLength={10}
          maxLength={5000}
          placeholder={t('discoveryCall.form.descriptionPlaceholder')}
          onChange={(e) =>
            setForm((f) => ({ ...f, description: e.target.value }))
          }
        />
      </div>

      {/* Honeypot: off-screen, not hidden, so a bot that reads `display:none`
          still fills it in. Same trick and same reasoning as `/contact`. */}
      <input
        className="absolute left-[-9999px] h-px w-px"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={form.website}
        onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
      />

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div>
        <Button type="submit" disabled={status === 'sending'}>
          {status === 'sending'
            ? t('discoveryCall.form.sending')
            : t('discoveryCall.form.submit')}
        </Button>
      </div>
    </form>
  );
}

export function DiscoveryCallPage({
  bookingUrl,
  embedSrc,
}: {
  bookingUrl: string | null;
  embedSrc: string | null;
}) {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;

  return (
    <MarketingShell>
      <main id="main-content" className="flex-1">
        <PageHero
          eyebrow={t('discoveryCall.eyebrow')}
          headlinePrefix={t('discoveryCall.headlinePrefix')}
          headlineFlourish={t('discoveryCall.headlineFlourish')}
          sub={t('discoveryCall.sub')}
        />

        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
              <div className="ls-card p-7">
                <h2 className="text-xl font-semibold text-[var(--ls-ink)]">
                  {t('discoveryCall.expect.title')}
                </h2>
                <ul className="mt-4 flex flex-col gap-3">
                  {EXPECT_KEYS.map((key) => (
                    <li
                      key={key}
                      className="text-sm leading-relaxed text-[var(--ls-ink-faint)]"
                    >
                      {t(key)}
                    </li>
                  ))}
                </ul>
              </div>

              {embedSrc && bookingUrl ? (
                <div className="ls-card p-7">
                  <h2 className="text-xl font-semibold text-[var(--ls-ink)]">
                    {t('discoveryCall.bookingTitle')}
                  </h2>
                  <iframe
                    title={t('discoveryCall.bookingTitle')}
                    src={embedSrc}
                    className="mt-4 h-[640px] w-full rounded-xl border border-[var(--ls-rule)]"
                    loading="lazy"
                  />
                  {/* The same page as a link, for anybody whose browser will
                      not load a third-party frame. Not a fallback we can
                      detect, so it is always there rather than conditional. */}
                  <p className="mt-3 text-xs text-[var(--ls-ink-faint)]">
                    {t('discoveryCall.bookingFallback')}{' '}
                    <a
                      className="underline"
                      href={bookingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('discoveryCall.bookingTitle')}
                    </a>
                  </p>
                </div>
              ) : (
                <EnquiryForm t={t} />
              )}
            </div>
          </div>
        </section>
      </main>
    </MarketingShell>
  );
}
