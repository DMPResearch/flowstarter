'use client';

import { useState } from 'react';
import {
  Calendar,
  Check,
  Loader2,
  Mail,
  Send,
  Twitter,
  Linkedin,
} from 'lucide-react';
import { Button } from '@flowstarter/flow-design-system';
import { MarketingShell, PageHero } from '@/components/marketing';
import { useI18n } from '@/lib/i18n';
import { useBookingModal } from '@/app/(dynamic-pages)/(main-pages)/components/booking-modal-store';
import { useContactForm } from '@/hooks/useContactForm';
import { buildContactPayload } from '@/lib/contact-payload';

const cardPadding = '1.75rem 1.65rem 1.65rem';

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
  transition: 'border-color 200ms ease, box-shadow 200ms ease',
};

const cardTitleStyle = {
  fontFamily: 'var(--ls-sans)',
  fontWeight: 600,
  fontSize: '1.15rem',
  letterSpacing: '-0.015em',
  color: 'var(--ls-ink)',
  lineHeight: 1.2,
} as const;

const cardKickerStyle = {
  fontFamily: 'var(--ls-mono)',
  fontSize: '10.5px',
  letterSpacing: '0.22em',
  textTransform: 'uppercase' as const,
  color: 'var(--ls-accent)',
} as const;

export default function ContactPage() {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;
  const openBookingModal = useBookingModal((s) => s.open);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    subject: '',
    message: '',
    // Honeypot — kept in state like every other field so a filled-in value
    // travels through the same payload builder the route validates against,
    // but real visitors never see this field (see the input below).
    website: '',
  });

  const contactMutation = useContactForm();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    contactMutation.mutate(
      buildContactPayload({
        name: formData.name,
        email: formData.email,
        subject: formData.subject,
        message: formData.message,
        website: formData.website,
      }),
      {
        onSuccess: () => {
          setFormData({
            name: '',
            email: '',
            subject: '',
            message: '',
            website: '',
          });
        },
      }
    );
  };

  const status = contactMutation.isPending
    ? 'loading'
    : contactMutation.isSuccess
    ? 'success'
    : contactMutation.isError
    ? 'error'
    : 'idle';

  const errorMessage =
    contactMutation.error?.message ?? t('contact.form.defaultError');

  return (
    <MarketingShell>
      <main id="main-content" className="flex-1">
        <PageHero
          eyebrow={t('contact.eyebrow')}
          headlinePrefix={t('contact.headlinePrefix')}
          headlineFlourish={t('contact.headlineFlourish')}
          sub={t('contact.sub')}
        />

        <section className="ls-section ls-section--pad">
          <div className="ls-container">
            <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
              {/* Contact form */}
              <div
                className="ls-card"
                style={{
                  padding: cardPadding,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1.25rem',
                }}
              >
                <div>
                  <span style={cardKickerStyle}>
                    {t('contact.form.kicker')}
                  </span>
                  <h2 style={{ ...cardTitleStyle, marginTop: '0.45rem' }}>
                    {t('contact.form.title')}
                  </h2>
                  <p
                    className="ls-body"
                    style={{
                      fontSize: '0.92rem',
                      marginTop: '0.5rem',
                    }}
                  >
                    {t('contact.form.replyGuarantee')}
                  </p>
                </div>

                {status === 'success' ? (
                  <div
                    style={{
                      borderRadius: '14px',
                      border:
                        '1px solid color-mix(in oklab, var(--ls-accent) 30%, var(--ls-rule))',
                      background:
                        'color-mix(in oklab, var(--ls-accent) 6%, transparent)',
                      padding: '1.75rem 1.25rem',
                      textAlign: 'center',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '52px',
                        height: '52px',
                        borderRadius: '999px',
                        background:
                          'color-mix(in oklab, var(--ls-accent) 14%, transparent)',
                        color: 'var(--ls-accent)',
                        marginBottom: '0.9rem',
                      }}
                    >
                      <Check className="h-6 w-6" />
                    </span>
                    <h3 style={cardTitleStyle}>
                      {t('contact.form.successTitle')}
                    </h3>
                    <p
                      className="ls-body"
                      style={{
                        fontSize: '0.92rem',
                        marginTop: '0.5rem',
                      }}
                    >
                      {t('contact.form.successBody')}
                    </p>
                    <button
                      type="button"
                      onClick={() => contactMutation.reset()}
                      className="ls-link"
                      style={{
                        marginTop: '1.1rem',
                        color: 'var(--ls-ink)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      {t('contact.form.sendAnother')}
                    </button>
                  </div>
                ) : (
                  <form
                    onSubmit={handleSubmit}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '1rem',
                    }}
                  >
                    {/* Honeypot — off-screen rather than `display:none` (some
                        bots skip fields a screen reader would never reach,
                        but not ones that only check computed visibility),
                        `tabIndex={-1}` and `aria-hidden` so it is never in a
                        real visitor's tab order or announced. A filled value
                        makes `/api/contact` return its normal success shape
                        without inserting or notifying (see route.ts). */}
                    <div
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        width: '1px',
                        height: '1px',
                        overflow: 'hidden',
                        clip: 'rect(0,0,0,0)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <label htmlFor="contact-website">Website</label>
                      <input
                        id="contact-website"
                        name="website"
                        type="text"
                        tabIndex={-1}
                        autoComplete="off"
                        value={formData.website}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            website: e.target.value,
                          })
                        }
                      />
                    </div>

                    <div>
                      <label htmlFor="contact-name" style={labelStyle}>
                        {t('contact.form.nameLabel')}
                      </label>
                      <input
                        id="contact-name"
                        type="text"
                        required
                        value={formData.name}
                        onChange={(e) =>
                          setFormData({ ...formData, name: e.target.value })
                        }
                        placeholder={t('contact.form.namePlaceholder')}
                        style={inputStyle}
                      />
                    </div>

                    <div>
                      <label htmlFor="contact-email" style={labelStyle}>
                        {t('contact.form.emailLabel')}
                      </label>
                      <input
                        id="contact-email"
                        type="email"
                        required
                        value={formData.email}
                        onChange={(e) =>
                          setFormData({ ...formData, email: e.target.value })
                        }
                        placeholder={t('contact.form.emailPlaceholder')}
                        style={inputStyle}
                      />
                    </div>

                    <div>
                      <label htmlFor="contact-subject" style={labelStyle}>
                        {t('contact.form.subjectLabel')}
                      </label>
                      <select
                        id="contact-subject"
                        required
                        value={formData.subject}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            subject: e.target.value,
                          })
                        }
                        style={inputStyle}
                      >
                        <option value="">
                          {t('contact.form.subjectDefault')}
                        </option>
                        <option value="General">
                          {t('contact.form.subjectGeneral')}
                        </option>
                        <option value="Project">
                          {t('contact.form.subjectProject')}
                        </option>
                        <option value="Support">
                          {t('contact.form.subjectSupport')}
                        </option>
                        <option value="Billing">
                          {t('contact.form.subjectBilling')}
                        </option>
                        <option value="Press">
                          {t('contact.form.subjectPress')}
                        </option>
                        <option value="Other">
                          {t('contact.form.subjectOther')}
                        </option>
                      </select>
                    </div>

                    <div>
                      <label htmlFor="contact-message" style={labelStyle}>
                        {t('contact.form.messageLabel')}
                      </label>
                      <textarea
                        id="contact-message"
                        required
                        rows={5}
                        value={formData.message}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            message: e.target.value,
                          })
                        }
                        placeholder={t('contact.form.messagePlaceholder')}
                        style={{
                          ...inputStyle,
                          resize: 'vertical' as const,
                          minHeight: '8rem',
                        }}
                      />
                    </div>

                    {status === 'error' && (
                      <div
                        role="alert"
                        style={{
                          padding: '0.85rem 1rem',
                          borderRadius: '12px',
                          border:
                            '1px solid color-mix(in oklab, #b45309 40%, var(--ls-rule))',
                          background:
                            'color-mix(in oklab, #b45309 10%, transparent)',
                          color: 'var(--ls-accent-warm)',
                          fontFamily: 'var(--ls-sans)',
                          fontSize: '0.88rem',
                        }}
                      >
                        {errorMessage}
                      </div>
                    )}

                    <Button
                      type="submit"
                      variant="primary"
                      loading={status === 'loading'}
                      disabled={status === 'loading'}
                      iconPosition="right"
                      icon={
                        status === 'loading' ? undefined : (
                          <Send className="h-4 w-4" />
                        )
                      }
                      style={{ alignSelf: 'flex-start' }}
                    >
                      {status === 'loading'
                        ? t('contact.form.sending')
                        : t('contact.form.send')}
                    </Button>
                  </form>
                )}
              </div>

              {/* Right rail */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1.25rem',
                }}
              >
                {/* Discovery call */}
                <div
                  className="ls-card"
                  style={{
                    padding: cardPadding,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.9rem',
                  }}
                >
                  <span style={cardKickerStyle}>
                    {t('contact.call.kicker')}
                  </span>
                  <h3 style={cardTitleStyle}>{t('contact.call.title')}</h3>
                  <p
                    className="ls-body"
                    style={{ fontSize: '0.92rem', margin: 0 }}
                  >
                    {t('contact.call.body')}
                  </p>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={openBookingModal}
                    icon={<Calendar className="h-3.5 w-3.5" />}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    {t('contact.call.cta')}
                  </Button>
                </div>

                {/* Email + socials */}
                <div
                  className="ls-card"
                  style={{
                    padding: cardPadding,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.95rem',
                  }}
                >
                  <span style={cardKickerStyle}>
                    {t('contact.direct.kicker')}
                  </span>
                  <h3 style={cardTitleStyle}>{t('contact.direct.title')}</h3>

                  <a
                    href="mailto:hello@flowstarter.net"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.85rem',
                      padding: '0.85rem 0',
                      borderTop: '1px solid var(--ls-rule)',
                      color: 'var(--ls-ink)',
                      textDecoration: 'none',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '36px',
                        height: '36px',
                        borderRadius: '10px',
                        background:
                          'color-mix(in oklab, var(--ls-accent) 12%, transparent)',
                        color: 'var(--ls-accent)',
                      }}
                    >
                      <Mail className="h-4 w-4" />
                    </span>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span
                        style={{
                          fontFamily: 'var(--ls-mono)',
                          fontSize: '10.5px',
                          letterSpacing: '0.2em',
                          textTransform: 'uppercase',
                          color: 'var(--ls-ink-faint)',
                        }}
                      >
                        {t('contact.direct.emailLabel')}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--ls-sans)',
                          fontSize: '0.95rem',
                          color: 'var(--ls-ink)',
                        }}
                      >
                        hello@flowstarter.net
                      </span>
                    </div>
                  </a>

                  <a
                    href="https://twitter.com/flowstarter"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.85rem',
                      padding: '0.85rem 0',
                      borderTop: '1px solid var(--ls-rule)',
                      color: 'var(--ls-ink)',
                      textDecoration: 'none',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '36px',
                        height: '36px',
                        borderRadius: '10px',
                        background:
                          'color-mix(in oklab, var(--ls-accent) 12%, transparent)',
                        color: 'var(--ls-accent)',
                      }}
                    >
                      <Twitter className="h-4 w-4" />
                    </span>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span
                        style={{
                          fontFamily: 'var(--ls-mono)',
                          fontSize: '10.5px',
                          letterSpacing: '0.2em',
                          textTransform: 'uppercase',
                          color: 'var(--ls-ink-faint)',
                        }}
                      >
                        {t('contact.direct.twitterLabel')}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--ls-sans)',
                          fontSize: '0.95rem',
                          color: 'var(--ls-ink)',
                        }}
                      >
                        @flowstarter
                      </span>
                    </div>
                  </a>

                  <a
                    href="https://linkedin.com/company/flowstarter"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.85rem',
                      padding: '0.85rem 0',
                      borderTop: '1px solid var(--ls-rule)',
                      color: 'var(--ls-ink)',
                      textDecoration: 'none',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '36px',
                        height: '36px',
                        borderRadius: '10px',
                        background:
                          'color-mix(in oklab, var(--ls-accent) 12%, transparent)',
                        color: 'var(--ls-accent)',
                      }}
                    >
                      <Linkedin className="h-4 w-4" />
                    </span>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span
                        style={{
                          fontFamily: 'var(--ls-mono)',
                          fontSize: '10.5px',
                          letterSpacing: '0.2em',
                          textTransform: 'uppercase',
                          color: 'var(--ls-ink-faint)',
                        }}
                      >
                        {t('contact.direct.linkedinLabel')}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--ls-sans)',
                          fontSize: '0.95rem',
                          color: 'var(--ls-ink)',
                        }}
                      >
                        /company/flowstarter
                      </span>
                    </div>
                  </a>
                </div>

                {/* Response time */}
                <div
                  className="ls-card"
                  style={{
                    padding: '1.25rem 1.35rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.95rem',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '999px',
                      background: '#22c55e',
                      boxShadow: '0 0 0 4px rgba(34, 197, 94, 0.18)',
                    }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span
                      style={{
                        fontFamily: 'var(--ls-mono)',
                        fontSize: '10.5px',
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        color: 'var(--ls-ink-faint)',
                      }}
                    >
                      {t('contact.responseTime.label')}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--ls-sans)',
                        fontSize: '0.95rem',
                        color: 'var(--ls-ink)',
                      }}
                    >
                      {t('contact.responseTime.value')}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </MarketingShell>
  );
}
