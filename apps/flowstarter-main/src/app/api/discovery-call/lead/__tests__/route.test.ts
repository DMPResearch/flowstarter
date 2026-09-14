/**
 * The contact form that stands in for the calendar.
 *
 * The thing worth pinning is that it files the same kind of row a booking offer
 * files, so the operator's lane stays one list, and that a bot filling in the
 * honeypot cannot tell it was refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const fileCustomWorkEnquiry = vi.fn<
  (...args: unknown[]) => Promise<string | null>
>(async () => 'lead-1');
vi.mock('@/lib/flowstarter/scope-gate', () => ({
  fileCustomWorkEnquiry: (...args: unknown[]) => fileCustomWorkEnquiry(...args),
}));

/** Arcjet-backed since #151; stubbed at that seam. See the scope route test. */
const limited = { value: false };
vi.mock('@/lib/security/route-limits', () => ({
  routeLimiter: (name: string) => ({
    name,
    check: async () => ({
      ok: !limited.value,
      retryAfter: limited.value ? 42 : 0,
    }),
  }),
}));

import { POST } from '../route';

function post(body: unknown) {
  return new NextRequest('https://flowstarter.net/api/discovery-call/lead', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.4',
    },
    body: JSON.stringify(body),
  });
}

const ENQUIRY = {
  name: 'Sarah Smith',
  email: 'sarah@example.com',
  description: 'A booking platform for three clinics with their own logins',
  linkUrl: 'https://acme.example.com',
};

beforeEach(() => {
  fileCustomWorkEnquiry.mockClear();
  limited.value = false;
});

describe('POST /api/discovery-call/lead', () => {
  it('files the enquiry', async () => {
    const res = await POST(post(ENQUIRY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fileCustomWorkEnquiry).toHaveBeenCalledWith({
      name: 'Sarah Smith',
      email: 'sarah@example.com',
      description: ENQUIRY.description,
      linkUrl: 'https://acme.example.com',
    });
  });

  it('answers a honeypot exactly as it answers a person, and files nothing', async () => {
    const res = await POST(
      post({ ...ENQUIRY, website: 'http://spam.example' })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fileCustomWorkEnquiry).not.toHaveBeenCalled();
  });

  it('refuses a body that is missing what it needs', async () => {
    for (const bad of [
      { ...ENQUIRY, email: 'not-an-email' },
      { ...ENQUIRY, name: 'S' },
      { ...ENQUIRY, description: 'short' },
      {},
    ]) {
      const res = await POST(post(bad));
      expect(res.status).toBe(400);
    }
    expect(fileCustomWorkEnquiry).not.toHaveBeenCalled();
  });

  it('refuses a rate-limited caller without filing anything', async () => {
    limited.value = true;
    const res = await POST(post(ENQUIRY));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(fileCustomWorkEnquiry).not.toHaveBeenCalled();
  });

  it('carries no link when the visitor gave none', async () => {
    await POST(post({ ...ENQUIRY, linkUrl: '' }));
    expect(fileCustomWorkEnquiry).toHaveBeenCalledWith(
      expect.objectContaining({ linkUrl: null })
    );
  });
});
