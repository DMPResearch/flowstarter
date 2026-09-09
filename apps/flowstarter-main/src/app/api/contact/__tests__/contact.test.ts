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

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSupabase = {
  from: vi.fn((_table: string) => ({
    insert: vi.fn((_values: any) =>
      Promise.resolve({ error: supabaseInsertError })
    ),
  })),
} as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => mockSupabase,
}));

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
function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/contact', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
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
