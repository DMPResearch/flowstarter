/**
 * POST /api/contact
 * Handles contact form submissions. No auth required.
 *
 * MVP readiness review, "Lead capture": "`/contact` is a dead letter box...
 * The route inserts into `contact_submissions` and sends no notification of
 * any kind... Nothing ever reads it." This adds the two things a message
 * needs to reach a human: a best-effort operator notification on every
 * successful insert (the insert itself is the source of truth and must
 * succeed even when the mailer is down — see `notifyOperator` below), and a
 * per-IP rate limit + honeypot, since this was also "an unauthenticated
 * insert with Zod validation and no rate limit" (readiness review,
 * "Security"). The admin listing that makes the insert actually reachable by
 * a human lives at `/api/admin/contact-submissions` and
 * `/admin/dashboard/contact-messages`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { resolveOperatorNotifyEmail, sendEmail } from '@/lib/email';
import { contactRateLimiter } from '@/lib/rate-limit';

const ContactSchema = z.object({
  name: z
    .string({ required_error: 'Name is required' })
    .min(1, 'Name is required')
    .max(100),
  email: z
    .string({ required_error: 'Email is required' })
    .email('Please enter a valid email address'),
  subject: z
    .string({ required_error: 'Subject is required' })
    .min(1, 'Subject is required')
    .max(200),
  message: z
    .string({ required_error: 'Message is required' })
    .min(1, 'Message is required')
    .max(5000),
  // Honeypot: a real visitor never sees or fills this field (see the
  // `contact` page's hidden input). Optional so every existing caller of
  // this schema keeps working unchanged.
  website: z.string().optional(),
});

function clientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Best-effort operator notification. Never throws: a dead mailer must not
 * fail the submission the visitor already sees confirmed on screen. The
 * caller logs (and, where the row id is known, records on the row itself)
 * whichever failure this reports back.
 */
async function notifyOperator(input: {
  name: string;
  email: string;
  subject: string;
  message: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const to = resolveOperatorNotifyEmail();
    const result = await sendEmail({
      to,
      subject: `New contact message: ${input.subject}`,
      replyTo: input.email,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827;">
          <h1 style="font-size:18px;margin:0 0 12px;">New message from the contact form</h1>
          <table style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
            <tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;text-transform:uppercase;white-space:nowrap;">Name</td><td style="padding:6px 12px;font-size:14px;">${escapeHtml(
              input.name
            )}</td></tr>
            <tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;text-transform:uppercase;white-space:nowrap;">Email</td><td style="padding:6px 12px;font-size:14px;">${escapeHtml(
              input.email
            )}</td></tr>
            <tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;text-transform:uppercase;white-space:nowrap;">Subject</td><td style="padding:6px 12px;font-size:14px;">${escapeHtml(
              input.subject
            )}</td></tr>
            <tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;text-transform:uppercase;white-space:nowrap;vertical-align:top;">Message</td><td style="padding:6px 12px;font-size:14px;white-space:pre-wrap;">${escapeHtml(
              input.message
            )}</td></tr>
          </table>
        </div>`,
    });
    if (!result.success) {
      return { ok: false, error: result.error ?? 'unknown mailer error' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'unknown mailer error',
    };
  }
}

export async function POST(request: NextRequest) {
  // Per-IP rate limit, same helper the public lead-capture and custom-inquiry
  // routes use. Checked before any parsing, so an oversized or malformed
  // body from an abusive client is also cheap to reject.
  if (contactRateLimiter.check(clientIp(request)).limited) {
    return NextResponse.json(
      { error: 'Too many messages. Please try again in a minute.' },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const result = ContactSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: result.error.errors[0].message },
      { status: 400 }
    );
  }

  // Honeypot tripped — return the same success shape a real visitor gets, so
  // a bot has no way to tell it was caught, and skip both the insert and the
  // notification.
  if (result.data.website && result.data.website.trim().length > 0) {
    return NextResponse.json({
      success: true,
      message: 'Message sent successfully',
    });
  }

  const { name, email, subject, message } = result.data;

  try {
    const supabase = createSupabaseServiceRoleClient();

    const { data: inserted, error } = await supabase
      .from('contact_submissions')
      .insert({
        name,
        email,
        subject,
        message,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      console.error('[Contact] Supabase error:', error);
      return NextResponse.json(
        { error: 'Failed to save your message. Please try again.' },
        { status: 500 }
      );
    }

    // The insert is what the visitor's success message is about, so it has
    // already happened by this point. The notification is best-effort on
    // top of it: a dead mailer must not turn a saved message into an error
    // response, but the failure must not vanish either — it is logged, and
    // (when the row id is known) recorded on the row's own `notes` column so
    // an operator scanning the admin list can see which messages never
    // reached anyone by email and have to be found by reading the table.
    const notified = await notifyOperator({ name, email, subject, message });
    if (!notified.ok) {
      console.error(
        '[Contact] operator notification failed for submission',
        inserted?.id,
        notified.error
      );
      if (inserted?.id) {
        const { error: noteError } = await supabase
          .from('contact_submissions')
          .update({
            notes: `Operator notification failed: ${notified.error}`,
          })
          .eq('id', inserted.id);
        if (noteError) {
          console.error(
            '[Contact] failed to record the notification failure on the row',
            inserted.id,
            noteError
          );
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Message sent successfully',
    });
  } catch (error) {
    console.error('[Contact] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    );
  }
}
