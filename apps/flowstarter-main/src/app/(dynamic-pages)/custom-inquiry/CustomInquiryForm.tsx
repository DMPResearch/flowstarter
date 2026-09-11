'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

const ROLE_OPTIONS = [
  { value: 'founder_ceo', label: 'Founder / CEO' },
  { value: 'cto', label: 'CTO' },
  { value: 'marketing_director', label: 'Marketing Director' },
  { value: 'product_manager', label: 'Product Manager' },
  { value: 'other', label: 'Other' },
] as const;

const INDUSTRY_OPTIONS = [
  'SaaS',
  'E-commerce',
  'Professional services',
  'Healthcare',
  'Education',
  'Finance',
  'Real estate',
  'Hospitality',
  'Manufacturing',
  'Non-profit',
  'Other',
] as const;

const PROJECT_TYPES = [
  { value: 'ai_integration', label: 'AI integration' },
  { value: 'custom_platform', label: 'Custom platform / SaaS' },
  { value: 'booking_system', label: 'Complex booking system' },
  { value: 'ecommerce_customization', label: 'E-commerce customisation' },
  { value: 'internal_tool', label: 'Internal tool / dashboard' },
  { value: 'membership', label: 'Membership / course platform' },
  { value: 'other', label: 'Other' },
] as const;

const BUDGET_OPTIONS = [
  { value: '5-10k', label: '€5,000 – €10,000' },
  { value: '10-20k', label: '€10,000 – €20,000' },
  { value: '20-30k', label: '€20,000 – €30,000' },
  { value: '30k+', label: '€30,000+' },
] as const;

const TIMELINE_OPTIONS = [
  { value: '1-2-months', label: '1–2 months' },
  { value: '2-4-months', label: '2–4 months' },
  { value: '4-6-months', label: '4–6 months' },
  { value: 'flexible', label: 'Flexible' },
] as const;

const REFERRAL_OPTIONS = [
  'Google',
  'LinkedIn',
  'YouTube',
  'Referral',
  'Other',
] as const;

const MIN_JUSTIFICATION = 300;
const MAX_JUSTIFICATION = 2000;

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--ls-mono)',
  fontSize: '10.5px',
  letterSpacing: '0.2em',
  textTransform: 'uppercase',
  color: 'var(--ls-ink-faint)',
  marginBottom: '0.55rem',
};

const inputStyle: React.CSSProperties = {
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

interface FormState {
  name: string;
  email: string;
  companyName: string;
  website: string;
  role: string;
  industry: string;
  projectTypes: string[];
  projectTypeOther: string;
  budgetRange: string;
  timeline: string;
  justification: string;
  referralSource: string;
  // Honeypot — bots fill it.
  website2: string;
}

const EMPTY: FormState = {
  name: '',
  email: '',
  companyName: '',
  website: '',
  role: '',
  industry: '',
  projectTypes: [],
  projectTypeOther: '',
  budgetRange: '',
  timeline: '',
  justification: '',
  referralSource: '',
  website2: '',
};

export function CustomInquiryForm() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [status, setStatus] = useState<
    'idle' | 'submitting' | 'success' | 'error' | 'duplicate'
  >('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  // Bot-fill-time check: stamp at mount, require >10s before submit succeeds.
  const [mountedAt] = useState<number>(() => Date.now());

  const justificationCount = form.justification.length;
  const justificationOk =
    justificationCount >= MIN_JUSTIFICATION &&
    justificationCount <= MAX_JUSTIFICATION;

  const isValid = useMemo(() => {
    if (!form.name.trim()) return false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return false;
    if (!form.companyName.trim()) return false;
    if (!form.role) return false;
    if (!form.industry) return false;
    if (form.projectTypes.length === 0) return false;
    if (form.projectTypes.includes('other') && !form.projectTypeOther.trim())
      return false;
    if (!form.budgetRange) return false;
    if (!form.timeline) return false;
    if (!justificationOk) return false;
    return true;
  }, [form, justificationOk]);

  const toggleProjectType = (value: string) => {
    setForm((prev) => {
      const has = prev.projectTypes.includes(value);
      return {
        ...prev,
        projectTypes: has
          ? prev.projectTypes.filter((v) => v !== value)
          : [...prev.projectTypes, value],
      };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || status === 'submitting') return;

    setStatus('submitting');
    setErrorMessage('');

    try {
      const res = await fetch('/api/custom-inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          companyName: form.companyName.trim(),
          website: form.website.trim() || undefined,
          role: form.role,
          industry: form.industry,
          projectTypes: form.projectTypes,
          projectTypeOther: form.projectTypeOther.trim() || undefined,
          budgetRange: form.budgetRange,
          timeline: form.timeline,
          justification: form.justification.trim(),
          referralSource: form.referralSource || undefined,
          website2: form.website2, // honeypot — server drops if set
          formFillMs: Date.now() - mountedAt,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        duplicate?: boolean;
        error?: string;
      };

      if (res.ok && data.ok) {
        if (data.duplicate) {
          setStatus('duplicate');
        } else {
          setStatus('success');
        }
        setForm(EMPTY);
        return;
      }

      setStatus('error');
      setErrorMessage(data.error || 'Something went wrong. Please try again.');
    } catch {
      setStatus('error');
      setErrorMessage('Network error. Please try again.');
    }
  };

  useEffect(() => {
    if (status === 'success' || status === 'duplicate') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [status]);

  if (status === 'success' || status === 'duplicate') {
    return (
      <div
        className="ls-card mx-auto max-w-2xl text-center"
        style={{ padding: '2.5rem 1.75rem' }}
      >
        <span
          aria-hidden
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
          <Check className="h-7 w-7" />
        </span>
        <h2
          style={{
            fontFamily: 'var(--ls-sans)',
            fontWeight: 600,
            fontSize: '1.4rem',
            color: 'var(--ls-ink)',
          }}
        >
          {status === 'duplicate'
            ? 'We already have your inquiry'
            : 'Thanks, we got it'}
        </h2>
        <p
          className="ls-body"
          style={{ fontSize: '0.95rem', marginTop: '0.6rem' }}
        >
          {status === 'duplicate'
            ? "We received your previous inquiry. We'll respond within 2 business days."
            : "We review every Custom Solution Inquiry personally. You'll hear back within 2 business days, either with a booking link for a free consultation or a recommendation for a different path forward."}
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="ls-card mx-auto"
      style={{
        maxWidth: '760px',
        padding: '2rem 1.75rem 1.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
      }}
      noValidate
    >
      {/* Honeypot — hidden from real users. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: '-10000px',
          top: 'auto',
          width: '1px',
          height: '1px',
          overflow: 'hidden',
        }}
      >
        <label>
          Website
          <input
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={form.website2}
            onChange={(e) => setForm({ ...form, website2: e.target.value })}
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="ci-name" style={labelStyle}>
            Full name *
          </label>
          <input
            id="ci-name"
            type="text"
            required
            placeholder="Jane Doe"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="ci-email" style={labelStyle}>
            Email *
          </label>
          <input
            id="ci-email"
            type="email"
            required
            placeholder="you@company.com"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            style={inputStyle}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="ci-company" style={labelStyle}>
            Company name *
          </label>
          <input
            id="ci-company"
            type="text"
            required
            placeholder="Acme Inc."
            value={form.companyName}
            onChange={(e) => setForm({ ...form, companyName: e.target.value })}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="ci-website" style={labelStyle}>
            Website
          </label>
          <input
            id="ci-website"
            type="url"
            placeholder="https://"
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
            style={inputStyle}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="ci-role" style={labelStyle}>
            Your role *
          </label>
          <select
            id="ci-role"
            required
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            style={inputStyle}
          >
            <option value="">Select…</option>
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ci-industry" style={labelStyle}>
            Industry *
          </label>
          <select
            id="ci-industry"
            required
            value={form.industry}
            onChange={(e) => setForm({ ...form, industry: e.target.value })}
            style={inputStyle}
          >
            <option value="">Select…</option>
            {INDUSTRY_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <span style={labelStyle}>Project type * (pick all that apply)</span>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '0.55rem',
          }}
        >
          {PROJECT_TYPES.map((opt) => {
            const checked = form.projectTypes.includes(opt.value);
            return (
              <label
                key={opt.value}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.55rem',
                  padding: '0.7rem 0.9rem',
                  borderRadius: '10px',
                  border: `1px solid ${
                    checked ? 'var(--ls-accent)' : 'var(--ls-rule)'
                  }`,
                  background: checked
                    ? 'color-mix(in oklab, var(--ls-accent) 8%, transparent)'
                    : 'var(--ls-glass-bg)',
                  color: 'var(--ls-ink)',
                  fontFamily: 'var(--ls-sans)',
                  fontSize: '0.92rem',
                  cursor: 'pointer',
                  transition: 'all 180ms ease',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleProjectType(opt.value)}
                  style={{ accentColor: 'var(--ls-accent)' }}
                />
                {opt.label}
              </label>
            );
          })}
        </div>
        {form.projectTypes.includes('other') && (
          <input
            type="text"
            placeholder="Describe the other project type"
            value={form.projectTypeOther}
            onChange={(e) =>
              setForm({ ...form, projectTypeOther: e.target.value })
            }
            style={{ ...inputStyle, marginTop: '0.6rem' }}
          />
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="ci-budget" style={labelStyle}>
            Budget range *
          </label>
          <select
            id="ci-budget"
            required
            value={form.budgetRange}
            onChange={(e) => setForm({ ...form, budgetRange: e.target.value })}
            style={inputStyle}
          >
            <option value="">Select…</option>
            {BUDGET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ci-timeline" style={labelStyle}>
            Timeline *
          </label>
          <select
            id="ci-timeline"
            required
            value={form.timeline}
            onChange={(e) => setForm({ ...form, timeline: e.target.value })}
            style={inputStyle}
          >
            <option value="">Select…</option>
            {TIMELINE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="ci-justification" style={labelStyle}>
          Project justification *
        </label>
        <textarea
          id="ci-justification"
          required
          minLength={MIN_JUSTIFICATION}
          maxLength={MAX_JUSTIFICATION}
          rows={9}
          value={form.justification}
          onChange={(e) => setForm({ ...form, justification: e.target.value })}
          placeholder="Describe your project in detail. What problem are you solving? What standard solutions have you considered and why don't they fit? What does success look like? Any constraints we should know about (technical, regulatory, integrations)?"
          style={{
            ...inputStyle,
            fontFamily: 'var(--ls-sans)',
            resize: 'vertical',
            minHeight: '180px',
          }}
        />
        <p
          style={{
            marginTop: '0.4rem',
            fontFamily: 'var(--ls-mono)',
            fontSize: '11px',
            color: justificationOk
              ? 'var(--ls-ink-faint)'
              : justificationCount > MAX_JUSTIFICATION
              ? '#dc2626'
              : 'var(--ls-ink-faint)',
            letterSpacing: '0.06em',
          }}
        >
          Characters: {justificationCount}/{MIN_JUSTIFICATION} minimum
          {justificationCount > 0 && justificationCount < MIN_JUSTIFICATION
            ? ` · ${MIN_JUSTIFICATION - justificationCount} more to go`
            : ''}
          {justificationCount > MAX_JUSTIFICATION
            ? ` · ${justificationCount - MAX_JUSTIFICATION} over the limit`
            : ''}
        </p>
      </div>

      <div>
        <label htmlFor="ci-referral" style={labelStyle}>
          How did you hear about us?
        </label>
        <select
          id="ci-referral"
          value={form.referralSource}
          onChange={(e) => setForm({ ...form, referralSource: e.target.value })}
          style={inputStyle}
        >
          <option value="">Skip</option>
          {REFERRAL_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>

      {status === 'error' && (
        <p
          role="alert"
          style={{
            margin: 0,
            fontFamily: 'var(--ls-sans)',
            fontSize: '0.9rem',
            color: '#dc2626',
          }}
        >
          {errorMessage}
        </p>
      )}

      <button
        type="submit"
        disabled={!isValid || status === 'submitting'}
        style={{
          marginTop: '0.5rem',
          width: '100%',
          height: '50px',
          borderRadius: '12px',
          border: 'none',
          background:
            !isValid || status === 'submitting'
              ? 'color-mix(in oklab, var(--ls-accent) 35%, transparent)'
              : 'var(--ls-accent)',
          color: '#fff',
          fontFamily: 'var(--ls-sans)',
          fontWeight: 600,
          fontSize: '0.95rem',
          cursor:
            !isValid || status === 'submitting' ? 'not-allowed' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          transition: 'all 200ms ease',
        }}
      >
        {status === 'submitting' && (
          <Loader2 className="h-4 w-4 animate-spin" />
        )}
        {status === 'submitting' ? 'Sending…' : 'Submit inquiry'}
      </button>

      <p
        style={{
          margin: 0,
          textAlign: 'center',
          fontFamily: 'var(--ls-sans)',
          fontSize: '0.8rem',
          color: 'var(--ls-ink-faint)',
        }}
      >
        We respond within 2 business days. For a standard website, the paid
        Strategy Call is the faster path.
      </p>
    </form>
  );
}
