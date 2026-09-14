/**
 * POST /api/discovery/deposit
 *
 * Creates a Stripe Checkout Session for the 10% booking deposit a prospect
 * pays to lock in the discovery call. Deposit amount is derived from the
 * chosen build tier (Starter €79 / Pro €119 / Commerce €149 / Custom €199
 * flat). On success Stripe redirects back with ?deposit=paid and the booking
 * modal reopens straight on the calendar step.
 *
 * Graceful fallback: if STRIPE_SECRET_KEY is not set, returns
 * { skip: true } so the funnel proceeds straight to Calendly instead of
 * dead-ending. The deposit is then handled manually by the team.
 *
 * No prospect-deposit table exists — Stripe is the source of truth. The
 * webhook (checkout.session.completed, kind=booking_deposit) emails the team.
 */
import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { readJsonCapped } from '@/lib/net/ingress';
import {
  type Tier,
  bookingDepositAmount,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import { clientIp } from '@/lib/request-ip';
import { consumeRateLimit, namedIntEnv } from '@/lib/rate-limit';

const STRIPE_API_VERSION = '2026-02-25.clover' as const;

const DepositSchema = z.object({
  tier: z.enum(['starter', 'pro', 'commerce', 'custom']),
  fullName: z.string().min(1).max(200),
  email: z.string().email(),
  businessName: z.string().max(200).optional().default(''),
  subscription: z.enum(['starter', 'pro', 'max', '']).optional().default(''),
  source: z.string().max(100).optional().default('cta'),
  leadId: z.string().uuid().nullish(),
});

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

/** Test seam: the limiter is module state and suites must be able to reset
 * it, same as `__resetGuestDepositRateLimit` in the sibling checkout route. */
export function __resetDiscoveryDepositRateLimit(): void {
  rateLimitMap.clear();
}

/**
 * Security audit 2026-09-13 (Claude H4 / Codex F06): this creates a real
 * Stripe Checkout session for an anonymous guest, so the per-IP limiter
 * above is not enough on its own — it is trivially defeated by rotating
 * `X-Forwarded-For` (closed at the source in `@/lib/request-ip`, but a
 * second, IP-independent dimension is still worth having). A per-email
 * limiter closes the other half: however many addresses an attacker spoofs,
 * they still name the same email to get a usable Checkout redirect.
 * Named, env-overridable config, never a bare literal — same pattern as
 * `capEur()` in `src/lib/ai/funnel-cost.ts`.
 */
const DEPOSIT_EMAIL_RATE_LIMIT_ENV = 'DISCOVERY_DEPOSIT_EMAIL_RATE_LIMIT';
const DEPOSIT_EMAIL_RATE_LIMIT_DEFAULT = 3;
const DEPOSIT_EMAIL_RATE_WINDOW_MS = 60_000;

/** Absolute origin of the current request — no hardcoded domains. */
function requestOrigin(request: NextRequest): string {
  const explicit = request.headers.get('origin');
  if (explicit) return explicit.replace(/\/$/, '');
  const proto =
    request.headers.get('x-forwarded-proto') ??
    (request.nextUrl.protocol || 'https').replace(':', '');
  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    request.nextUrl.host;
  return `${proto}://${host}`;
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
  }

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

  const parsed = DepositSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid payload' },
      { status: 400 }
    );
  }
  const lead = parsed.data;
  const normalizedEmail = lead.email.trim().toLowerCase();
  if (
    await consumeRateLimit(`discovery-deposit-email:${normalizedEmail}`, {
      limit: namedIntEnv(
        DEPOSIT_EMAIL_RATE_LIMIT_ENV,
        DEPOSIT_EMAIL_RATE_LIMIT_DEFAULT
      ),
      windowMs: DEPOSIT_EMAIL_RATE_WINDOW_MS,
    })
  ) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    // No Stripe configured — don't dead-end the funnel.
    console.warn('[discovery/deposit] STRIPE_SECRET_KEY unset — skipping');
    return NextResponse.json({ skip: true });
  }

  const amountEur = bookingDepositAmount(lead.tier as Tier);
  const origin = requestOrigin(request);

  try {
    const stripe = new Stripe(secret, { apiVersion: STRIPE_API_VERSION });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: lead.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: amountEur * 100,
            product_data: {
              name: `Flowstarter discovery call deposit: ${lead.tier}`,
              description:
                'Refundable after the call, before any build work starts. Credited toward your setup fee if you proceed.',
            },
          },
        },
      ],
      metadata: {
        kind: 'booking_deposit',
        tier: lead.tier,
        subscription: lead.subscription || '',
        name: lead.fullName,
        email: lead.email,
        businessName: lead.businessName || '',
        source: lead.source,
        amountEur: String(amountEur),
        leadId: lead.leadId ?? '',
      },
      success_url: `${origin}/?deposit=paid&tier=${lead.tier}`,
      cancel_url: `${origin}/?deposit=cancelled`,
    });

    if (!session.url) {
      throw new Error('Stripe returned no checkout URL');
    }
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('[discovery/deposit] checkout create failed', err);
    // Fail open: let the prospect still book the call.
    return NextResponse.json({ skip: true });
  }
}
