/**
 * POST /api/custom-inquiry
 *
 * Public intake for the Custom Solution Inquiry funnel. Parallel to the paid
 * Strategy Call flow — these submissions go through manual triage in
 * /admin/dashboard/inquiries instead of being charged a deposit.
 *
 * Layers, in order:
 *   1. Honeypot field — if set, return 200 silently (don't tip off bots).
 *   2. Min form-fill time — humans take >10s; under that, silent drop.
 *   3. Per-IP rate limit — max 3/hr.
 *   4. Disposable-email check — basic blocklist.
 *   5. Zod validation — required fields, length bounds.
 *   6. Per-email 7-day dedup — friendly message, no notification re-fire.
 *   7. Persist to custom_inquiries (service role).
 *   8. Best-effort admin notification + acknowledgment emails (Resend).
 *
 * Returns 200 + { ok: true } on success; 200 + { ok: true, duplicate: true }
 * on a recent dedup hit. Returns 400 for validation, 429 for rate-limit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { sendEmail } from '@/lib/email';
import { readJsonCapped } from '@/lib/net/ingress';
import { clientIp } from '@/lib/request-ip';

function inquiryStore() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

const RoleEnum = z.enum([
  'founder_ceo',
  'cto',
  'marketing_director',
  'product_manager',
  'other',
]);

const ProjectTypeEnum = z.enum([
  'ai_integration',
  'custom_platform',
  'booking_system',
  'ecommerce_customization',
  'internal_tool',
  'membership',
  'other',
]);

const BudgetEnum = z.enum(['5-10k', '10-20k', '20-30k', '30k+']);
const TimelineEnum = z.enum([
  '1-2-months',
  '2-4-months',
  '4-6-months',
  'flexible',
]);

const InquirySchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  companyName: z.string().trim().min(1).max(200),
  website: z.string().trim().max(500).optional(),
  role: RoleEnum,
  industry: z.string().trim().min(1).max(120),
  projectTypes: z.array(ProjectTypeEnum).min(1).max(7),
  projectTypeOther: z.string().trim().max(200).optional(),
  budgetRange: BudgetEnum,
  timeline: TimelineEnum,
  justification: z.string().trim().min(300).max(2000),
  referralSource: z.string().trim().max(80).optional(),
  website2: z.string().optional(), // honeypot
  formFillMs: z.number().int().nonnegative().optional(),
});

type Inquiry = z.infer<typeof InquirySchema>;

// Per-IP rate limiter — 3 submissions per hour.
const RATE_LIMIT_MAX = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'tempmail.com',
  'guerrillamail.com',
  '10minutemail.com',
  'yopmail.com',
  'throwaway.email',
  'sharklasers.com',
  'getnada.com',
  'dispostable.com',
  'fakeinbox.com',
  'trashmail.com',
  'maildrop.cc',
]);

function isDisposable(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && DISPOSABLE_DOMAINS.has(domain);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function row(label: string, value: string | undefined | null): string {
  if (!value) return '';
  return `<tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;vertical-align:top;white-space:nowrap;">${escapeHtml(
    label
  )}</td><td style="padding:6px 12px;font-size:14px;color:#111827;white-space:pre-wrap;">${escapeHtml(
    value
  )}</td></tr>`;
}

const ROLE_LABELS: Record<string, string> = {
  founder_ceo: 'Founder / CEO',
  cto: 'CTO',
  marketing_director: 'Marketing Director',
  product_manager: 'Product Manager',
  other: 'Other',
};

const BUDGET_LABELS: Record<string, string> = {
  '5-10k': '€5,000 – €10,000',
  '10-20k': '€10,000 – €20,000',
  '20-30k': '€20,000 – €30,000',
  '30k+': '€30,000+',
};

const TIMELINE_LABELS: Record<string, string> = {
  '1-2-months': '1–2 months',
  '2-4-months': '2–4 months',
  '4-6-months': '4–6 months',
  flexible: 'Flexible',
};

const PROJECT_TYPE_LABELS: Record<string, string> = {
  ai_integration: 'AI integration',
  custom_platform: 'Custom platform / SaaS',
  booking_system: 'Complex booking system',
  ecommerce_customization: 'E-commerce customisation',
  internal_tool: 'Internal tool / dashboard',
  membership: 'Membership / course platform',
  other: 'Other',
};

function buildAdminEmail(
  inquiry: Inquiry,
  inquiryId: string | null,
  baseUrl: string
): { subject: string; html: string } {
  const projectTypes = inquiry.projectTypes
    .map((t) => PROJECT_TYPE_LABELS[t] || t)
    .join(', ');
  const subject = `New Custom Inquiry from ${inquiry.companyName}: ${
    BUDGET_LABELS[inquiry.budgetRange]
  }`;
  const dashboardLink = inquiryId
    ? `${baseUrl}/admin/dashboard/inquiries/${inquiryId}`
    : `${baseUrl}/admin/dashboard/inquiries`;
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111827;">
  <h1 style="font-size:18px;margin:0 0 4px;">New custom solution inquiry</h1>
  <p style="font-size:13px;color:#6b7280;margin:0 0 12px;">
    <strong style="color:#7c3aed;">${escapeHtml(
      BUDGET_LABELS[inquiry.budgetRange]
    )}</strong> · ${escapeHtml(projectTypes)}
  </p>
  <p style="margin:0 0 16px;">
    <a href="${dashboardLink}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;">
      Open in dashboard
    </a>
  </p>
  <table style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    ${row('Name', inquiry.name)}
    ${row('Email', inquiry.email)}
    ${row('Company', inquiry.companyName)}
    ${row('Website', inquiry.website)}
    ${row('Role', ROLE_LABELS[inquiry.role])}
    ${row('Industry', inquiry.industry)}
    ${row('Project types', projectTypes)}
    ${row('Other type', inquiry.projectTypeOther)}
    ${row('Budget', BUDGET_LABELS[inquiry.budgetRange])}
    ${row('Timeline', TIMELINE_LABELS[inquiry.timeline])}
    ${row('Referral', inquiry.referralSource)}
    ${row('Justification', inquiry.justification)}
  </table>
</div>`;
  return { subject, html };
}

function buildAcknowledgmentEmail(inquiry: Inquiry): {
  subject: string;
  html: string;
} {
  const firstName = inquiry.name.split(/\s+/)[0] || inquiry.name;
  const subject = 'We received your Custom Solution Inquiry';
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#111827;line-height:1.55;">
  <p style="margin:0 0 14px;font-size:15px;">Hi ${escapeHtml(firstName)},</p>
  <p style="margin:0 0 14px;font-size:15px;">
    Thanks for sharing details about your project at ${escapeHtml(
      inquiry.companyName
    )}.
  </p>
  <p style="margin:0 0 14px;font-size:15px;">
    We review every Custom Solution Inquiry personally to make sure we can
    provide genuine value. You can expect a response within 2 business days,
    either with a booking link for a free consultation or a recommendation
    for a different path forward.
  </p>
  <p style="margin:0 0 14px;font-size:15px;">
    In the meantime, feel free to follow our updates on
    <a href="https://www.linkedin.com/company/flowstarter" style="color:#4f46e5;">LinkedIn</a>.
  </p>
  <p style="margin:0 0 4px;font-size:15px;">Talk soon,</p>
  <p style="margin:0;font-size:15px;font-weight:600;">The Flowstarter team</p>
</div>`;
  return { subject, html };
}

export async function POST(request: NextRequest) {
  // Capped as it streams rather than buffered and measured afterwards: an
  // anonymous body arrives in whatever size the sender chooses, and a chunked
  // one advertises no size at all. Codex F07.
  const read = await readJsonCapped(request);
  if (read.status === 'too_large') {
    return NextResponse.json(
      { error: 'That request is too large.' },
      { status: 413 }
    );
  }
  if (read.status === 'invalid') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const body: unknown = read.value;

  const parsed = InquirySchema.safeParse(body);
  // Layer 1+2: honeypot + min-fill-time → silent success (don't tip off bots).
  const raw = body as Partial<Inquiry> | null;
  const honeypotTripped = !!raw?.website2 && raw.website2.length > 0;
  const tooFast =
    typeof raw?.formFillMs === 'number' && raw.formFillMs < 10_000;
  if (honeypotTripped || tooFast) {
    return NextResponse.json({ ok: true });
  }

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid payload' },
      { status: 400 }
    );
  }
  const inquiry = parsed.data;

  // Cross-field: project_type "other" requires the freetext value.
  if (
    inquiry.projectTypes.includes('other') &&
    !inquiry.projectTypeOther?.trim()
  ) {
    return NextResponse.json(
      { error: 'Please describe the "Other" project type' },
      { status: 400 }
    );
  }

  // Layer 3: per-IP rate limit.
  const ip = clientIp(request.headers);
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: 'Too many submissions. Please try again later.' },
      { status: 429 }
    );
  }

  // Layer 4: disposable email block.
  if (isDisposable(inquiry.email)) {
    return NextResponse.json(
      { error: 'Please use a business email address.' },
      { status: 400 }
    );
  }

  const store = inquiryStore();

  // Layer 6: 7-day per-email dedup (best-effort; if no store, skip).
  if (store) {
    try {
      const sevenDaysAgo = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000
      ).toISOString();
      const { data: existing, error: lookupErr } = await store
        .from('custom_inquiries')
        .select('id, created_at')
        .ilike('email', inquiry.email)
        .gte('created_at', sevenDaysAgo)
        .limit(1)
        .maybeSingle();
      if (lookupErr) {
        console.error('[custom-inquiry] dedup lookup failed', lookupErr);
      } else if (existing) {
        return NextResponse.json({ ok: true, duplicate: true });
      }
    } catch (err) {
      console.error('[custom-inquiry] dedup threw', err);
    }
  }

  // Layer 7: persist.
  let inquiryId: string | null = null;
  if (store) {
    try {
      const { data, error } = await store
        .from('custom_inquiries')
        .insert({
          name: inquiry.name,
          email: inquiry.email,
          company_name: inquiry.companyName,
          website: inquiry.website || null,
          role: inquiry.role,
          industry: inquiry.industry,
          project_types: inquiry.projectTypes,
          project_type_other: inquiry.projectTypeOther || null,
          budget_range: inquiry.budgetRange,
          timeline: inquiry.timeline,
          justification: inquiry.justification,
          referral_source: inquiry.referralSource || null,
        })
        .select('id')
        .single();
      if (error) throw error;
      inquiryId = (data as { id: string } | null)?.id ?? null;
    } catch (err) {
      console.error('[custom-inquiry] persist failed', err);
      // Continue — better to send the admin email than to lose the lead.
    }
  }

  // Layer 8: emails (fire-and-log).
  const notifyTo =
    process.env.CUSTOM_INQUIRY_NOTIFY_EMAIL ||
    process.env.DISCOVERY_LEAD_NOTIFY_EMAIL ||
    'hello@flowstarter.net';
  const origin =
    request.headers.get('origin') ||
    `https://${request.headers.get('host') ?? 'flowstarter.net'}`;
  const adminEmail = buildAdminEmail(inquiry, inquiryId, origin);
  try {
    await sendEmail({
      to: notifyTo,
      subject: adminEmail.subject,
      html: adminEmail.html,
      replyTo: inquiry.email,
    });
  } catch (err) {
    console.error('[custom-inquiry] admin email failed', err);
  }

  const ackEmail = buildAcknowledgmentEmail(inquiry);
  try {
    await sendEmail({
      to: inquiry.email,
      subject: ackEmail.subject,
      html: ackEmail.html,
    });
  } catch (err) {
    console.error('[custom-inquiry] ack email failed', err);
  }

  return NextResponse.json({ ok: true, inquiryId });
}
