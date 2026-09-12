/**
 * Tests for POST /api/contact
 * Covers: Zod validation, Supabase insert, error handling
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
// Static imports: vi.mock below is hoisted above them, and this app's
// tsconfig does not allow top-level await in tests.
import { POST } from '../route';
import { buildContactPayload } from '@/lib/contact-payload';

vi.mock('server-only', () => ({}));

// Mirror the schema from the route so we can test validation in isolation
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
});

// ── Mock Supabase ────────────────────────────────────────────────────────────
let supabaseInsertError: { message: string } | null = null;
let insertedRowId = 'row-1';
const updateSpy = vi.fn();

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSupabase = {
  from: vi.fn((_table: string) => ({
    // Thenable *and* chainable, the same shape the real Supabase query
    // builder has: `simulateContact` below awaits the insert call directly
    // (`const { error } = await ...insert(...)`), while the real route
    // chains `.select('id').single()` off it before awaiting.
    insert: vi.fn((_values: any) => ({
      then: (resolve: (v: unknown) => void) =>
        resolve({ error: supabaseInsertError }),
      select: (_cols: string) => ({
        single: async () => ({
          data: supabaseInsertError ? null : { id: insertedRowId },
          error: supabaseInsertError,
        }),
      }),
    })),
    update: vi.fn((values: any) => {
      updateSpy(values);
      return { eq: vi.fn(async () => ({ error: null })) };
    }),
  })),
} as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => mockSupabase,
}));

// Never let a real contact-form test reach Resend, even though
// `apps/flowstarter-main/.env.local` carries a real `RESEND_API_KEY` for the
// dev server — every call here must be observable and none may send mail.
const sendEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
  resolveOperatorNotifyEmail: () => 'hello@flowstarter.net',
}));

// File-wide default so every describe block below that drives the real POST
// handler gets a mailer that "succeeds" unless a test overrides it — only
// the notification tests below care about the failure paths.
beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true, id: 'em_test' });
});

// Simulate the route handler logic
async function simulateContact(body: unknown) {
  const result = ContactSchema.safeParse(body);
  if (!result.success) {
    return { status: 400, error: result.error.errors[0].message };
  }

  const { name, email, subject, message } = result.data;
  const { error } = await mockSupabase.from('contact_submissions').insert({
    name,
    email,
    subject,
    message,
    created_at: new Date().toISOString(),
  });

  if (error) {
    return {
      status: 500,
      error: 'Failed to save your message. Please try again.',
    };
  }

  return { status: 200, success: true, message: 'Message sent successfully' };
}

describe('POST /api/contact — Zod validation', () => {
  beforeEach(() => {
    supabaseInsertError = null;
    vi.clearAllMocks();
  });

  it('accepts a valid complete submission', async () => {
    const result = await simulateContact({
      name: 'Elena Popescu',
      email: 'elena@example.ro',
      subject: 'Programare',
      message: 'Aș dori o programare pentru vineri.',
    });
    expect(result.status).toBe(200);
    expect(result.success).toBe(true);
  });

  it('rejects missing name', async () => {
    const result = await simulateContact({
      email: 'elena@example.ro',
      subject: 'Hello',
      message: 'Test message',
    });
    expect(result.status).toBe(400);
    expect(result.error).toContain('Name is required');
  });

  it('rejects empty name', async () => {
    const result = await simulateContact({
      name: '',
      email: 'elena@example.ro',
      subject: 'Hello',
      message: 'Test message',
    });
    expect(result.status).toBe(400);
    expect(result.error).toContain('Name is required');
  });

  it('rejects invalid email format', async () => {
    const result = await simulateContact({
      name: 'Elena',
      email: 'not-an-email',
      subject: 'Hello',
      message: 'Test message',
    });
    expect(result.status).toBe(400);
    expect(result.error).toContain('valid email');
  });

  it('rejects missing email', async () => {
    const result = await simulateContact({
      name: 'Elena',
      subject: 'Hello',
      message: 'Test message',
    });
    expect(result.status).toBe(400);
  });

  it('rejects missing subject', async () => {
    const result = await simulateContact({
      name: 'Elena',
      email: 'elena@example.ro',
      message: 'Test message',
    });
    expect(result.status).toBe(400);
    expect(result.error).toContain('Subject is required');
  });

  it('rejects empty message', async () => {
    const result = await simulateContact({
      name: 'Elena',
      email: 'elena@example.ro',
      subject: 'Hello',
      message: '',
    });
    expect(result.status).toBe(400);
    expect(result.error).toContain('Message is required');
  });

  it('rejects name over 100 characters', async () => {
    const result = await simulateContact({
      name: 'A'.repeat(101),
      email: 'elena@example.ro',
      subject: 'Hello',
      message: 'Test',
    });
    expect(result.status).toBe(400);
  });

  it('rejects subject over 200 characters', async () => {
    const result = await simulateContact({
      name: 'Elena',
      email: 'elena@example.ro',
      subject: 'A'.repeat(201),
      message: 'Test',
    });
    expect(result.status).toBe(400);
  });

  it('rejects message over 5000 characters', async () => {
    const result = await simulateContact({
      name: 'Elena',
      email: 'elena@example.ro',
      subject: 'Hello',
      message: 'A'.repeat(5001),
    });
    expect(result.status).toBe(400);
  });

  it('accepts Romanian diacritics in all fields', async () => {
    const result = await simulateContact({
      name: 'Ștefan Năstase',
      email: 'stefan@example.ro',
      subject: 'Întrebare despre servicii',
      message:
        'Bună ziua, aș dori să știu mai multe despre ofertele dumneavoastră.',
    });
    expect(result.status).toBe(200);
  });

  it('accepts email with subdomain', async () => {
    const result = await simulateContact({
      name: 'Test User',
      email: 'user@mail.company.co.uk',
      subject: 'Test',
      message: 'Test message',
    });
    expect(result.status).toBe(200);
  });
});

describe('POST /api/contact — Supabase integration', () => {
  beforeEach(() => {
    supabaseInsertError = null;
    vi.clearAllMocks();
  });

  it('calls Supabase insert with all fields', async () => {
    await simulateContact({
      name: 'Elena',
      email: 'elena@example.ro',
      subject: 'Programare',
      message: 'Test',
    });

    expect(mockSupabase.from).toHaveBeenCalledWith('contact_submissions');
  });

  it('returns 500 when Supabase insert fails', async () => {
    supabaseInsertError = { message: 'DB connection error' };

    const result = await simulateContact({
      name: 'Elena',
      email: 'elena@example.ro',
      subject: 'Programare',
      message: 'Test',
    });

    expect(result.status).toBe(500);
    expect(result.error).toContain('Failed to save');
  });

  it('does not call Supabase when validation fails', async () => {
    await simulateContact({ name: '', email: 'bad', subject: '', message: '' });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

// ── Real route handler, exercised with the contact page's own payload ──────
// Regression coverage for the bug where the contact page folded the subject
// into the message body instead of sending it as its own field, so every
// submission hit `subject` missing from `ContactSchema` and got a 400. This
// imports the real `POST` handler (not a reimplementation) and the same
// `buildContactPayload` the page component calls, so a future regression in
// either side is caught here.
function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/contact', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('POST /api/contact — real route handler with the form payload', () => {
  beforeEach(() => {
    supabaseInsertError = null;
    vi.clearAllMocks();
  });

  it('accepts the exact payload the contact form builds', async () => {
    const payload = buildContactPayload({
      name: 'Elena Popescu',
      email: 'elena@example.ro',
      subject: 'Project',
      message: 'Aș dori o programare pentru vineri.',
    });

    const res = await POST(postRequest(payload));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockSupabase.from).toHaveBeenCalledWith('contact_submissions');
  });

  it('rejects the form payload when subject is missing, with 400', async () => {
    const payload = buildContactPayload({
      name: 'Elena Popescu',
      email: 'elena@example.ro',
      subject: '',
      message: 'Aș dori o programare pentru vineri.',
    });

    const res = await POST(postRequest(payload));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Subject is required');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

// ── Lead capture: reaching a human ──────────────────────────────────────────
// MVP readiness review, "Lead capture": "/contact is a dead letter box...
// sends no notification of any kind." These cover the fix at the route.
describe('POST /api/contact — operator notification', () => {
  beforeEach(() => {
    supabaseInsertError = null;
    insertedRowId = 'row-notify';
    vi.clearAllMocks();
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ success: true, id: 'em_test' });
  });

  const payload = () => ({
    name: 'Elena Popescu',
    email: 'elena@example.ro',
    subject: 'Project',
    message: 'Aș dori o programare pentru vineri.',
  });

  it('notifies the operator mailbox on a successful insert', async () => {
    const res = await POST(
      postRequest(payload(), { 'x-forwarded-for': '203.0.113.10' })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
      replyTo: string;
      html: string;
    };
    expect(mail.to).toBe('hello@flowstarter.net');
    expect(mail.replyTo).toBe('elena@example.ro');
    expect(mail.html).toContain('Elena Popescu');
  });

  it('still succeeds, and logs and records the row, when the mailer fails', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'API key invalid' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(
      postRequest(payload(), { 'x-forwarded-for': '203.0.113.11' })
    );
    const json = await res.json();

    // The insert already happened — a dead mailer is not the visitor's problem.
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    // Logged...
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('operator notification failed'),
      'row-notify',
      'API key invalid'
    );
    // ...and recorded on the row itself, so it can be found from the list.
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: expect.stringContaining('API key invalid'),
      })
    );
    errorSpy.mockRestore();
  });

  it('still succeeds, and logs, when the mailer throws', async () => {
    sendEmail.mockRejectedValue(new Error('socket hang up'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(
      postRequest(payload(), { 'x-forwarded-for': '203.0.113.12' })
    );

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('POST /api/contact — honeypot', () => {
  beforeEach(() => {
    supabaseInsertError = null;
    vi.clearAllMocks();
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ success: true, id: 'em_test' });
  });

  it('returns the normal success shape without inserting or notifying when the honeypot is filled', async () => {
    const res = await POST(
      postRequest(
        {
          name: 'Bot',
          email: 'bot@example.com',
          subject: 'General',
          message: 'buy now',
          website: 'https://spam.example',
        },
        { 'x-forwarded-for': '203.0.113.20' }
      )
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockSupabase.from).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('proceeds normally when the honeypot is left empty', async () => {
    const res = await POST(
      postRequest(
        {
          name: 'Elena Popescu',
          email: 'elena@example.ro',
          subject: 'Project',
          message: 'Aș dori o programare pentru vineri.',
          website: '',
        },
        { 'x-forwarded-for': '203.0.113.21' }
      )
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockSupabase.from).toHaveBeenCalledWith('contact_submissions');
  });
});

describe('POST /api/contact — per-IP rate limit', () => {
  beforeEach(() => {
    supabaseInsertError = null;
    vi.clearAllMocks();
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ success: true, id: 'em_test' });
  });

  it('limits a single IP to the configured number of messages per minute', async () => {
    const ip = '203.0.113.99';
    const payload = {
      name: 'Elena Popescu',
      email: 'elena@example.ro',
      subject: 'Project',
      message: 'Aș dori o programare pentru vineri.',
    };
    const limit = 5; // matches contactRateLimiter's documented limit

    for (let i = 0; i < limit; i += 1) {
      const res = await POST(postRequest(payload, { 'x-forwarded-for': ip }));
      expect(res.status).not.toBe(429);
    }

    const limited = await POST(postRequest(payload, { 'x-forwarded-for': ip }));
    expect(limited.status).toBe(429);
    const json = await limited.json();
    expect(json.error).toMatch(/too many/i);
  });
});
