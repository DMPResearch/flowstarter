/**
 * POST /api/discovery-call/lead -- the contact form on `/discovery-call`.
 *
 * What stands in for the calendar when no Cal.com is configured in this
 * environment. It files exactly the row a booking offer would file, with
 * `source: 'contact_form'`, so Darius's lane on the pipeline board is one list
 * rather than two, and it sends the same branded confirmation.
 *
 * Nothing is classified here. Somebody who reached this page and typed out
 * their project has already told us what it is; spending a model call to agree
 * with them would be spending money on a conclusion we have.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { readJsonCapped } from '@/lib/net/ingress';
import { routeLimiter } from '@/lib/security/route-limits';
import { clientIp } from '@/lib/request-ip';
import { fileCustomWorkEnquiry } from '@/lib/flowstarter/scope-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Schema = z.object({
  name: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(320),
  description: z.string().trim().min(10).max(5_000),
  linkUrl: z.string().trim().max(300).optional().default(''),
  /**
   * Honeypot. Real visitors never see the field, so anything in it is a bot,
   * and a bot is told the same thing a person is: the same shape as
   * `/api/contact`, so a scraper cannot tell the two responses apart.
   */
  website: z.string().max(200).optional().default(''),
});

export async function POST(req: NextRequest) {
  const limit = await routeLimiter('discovery-call-enquiry').check(
    req,
    clientIp(req.headers)
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many requests. Try again in a minute.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
    );
  }

  const body = await readJsonCapped(req);
  if (body.status !== 'ok') {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const parsed = Schema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Please fill in your name, your email and what you need.' },
      { status: 400 }
    );
  }
  if (parsed.data.website.trim()) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  try {
    await fileCustomWorkEnquiry({
      name: parsed.data.name,
      email: parsed.data.email,
      description: parsed.data.description,
      linkUrl: parsed.data.linkUrl || null,
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error(
      '[custom-work] the enquiry form failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    );
  }
}
