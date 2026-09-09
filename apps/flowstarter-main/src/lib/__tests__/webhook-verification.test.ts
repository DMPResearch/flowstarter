/**
 * Behavioural coverage for webhook signature verification.
 *
 * Real HMAC signatures are computed with node's `crypto`, the same way
 * Svix and Stripe compute theirs, so these tests exercise the actual
 * comparison logic rather than a mocked stand-in.
 */
import { createHmac } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  extractWebhookHeaders,
  logWebhookEvent,
  verifyGenericHmacSignature,
  verifySvixSignature,
  verifyStripeSignature,
  verifyWebhook,
  type WebhookHeaders,
} from '../webhook-verification';

const SVIX_SECRET =
  'whsec_' + Buffer.from('svix-test-secret').toString('base64');
const STRIPE_SECRET = 'whsec_stripe_test_secret';
const GENERIC_SECRET = 'generic-shared-secret';

function svixSign(
  svixId: string,
  svixTimestamp: string,
  payload: string,
  secret: string
): string {
  const secretBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'base64');
  const signedPayload = `${svixId}.${svixTimestamp}.${payload}`;
  return createHmac('sha256', secretBytes)
    .update(signedPayload)
    .digest('base64');
}

function stripeSign(
  timestamp: string,
  payload: string,
  secret: string
): string {
  const signedPayload = `${timestamp}.${payload}`;
  return createHmac('sha256', secret).update(signedPayload).digest('hex');
}

describe('verifySvixSignature', () => {
  const payload = JSON.stringify({ type: 'user.created', data: { id: 'u1' } });

  it('accepts a validly signed payload', () => {
    const svixId = 'msg_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const signature = svixSign(svixId, svixTimestamp, payload, SVIX_SECRET);

    const result = verifySvixSignature(
      payload,
      {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${signature}`,
      },
      SVIX_SECRET
    );

    expect(result.valid).toBe(true);
    expect(result.payload).toEqual({
      type: 'user.created',
      data: { id: 'u1' },
    });
  });

  it('rejects when the signature does not match', () => {
    const svixId = 'msg_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));

    const result = verifySvixSignature(
      payload,
      {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': 'v1,not-the-right-signature-at-all',
      },
      SVIX_SECRET
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid webhook signature');
  });

  it('rejects when a required header is missing', () => {
    const result = verifySvixSignature(
      payload,
      { 'svix-timestamp': '123', 'svix-signature': 'v1,abc' },
      SVIX_SECRET
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Missing required Svix headers/);
  });

  it('rejects a stale timestamp (older than 300s)', () => {
    const svixId = 'msg_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000) - 400);
    const signature = svixSign(svixId, svixTimestamp, payload, SVIX_SECRET);

    const result = verifySvixSignature(
      payload,
      {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${signature}`,
      },
      SVIX_SECRET
    );

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too old/);
  });

  it('rejects a timestamp too far in the future (> 60s skew)', () => {
    const svixId = 'msg_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000) + 120);
    const signature = svixSign(svixId, svixTimestamp, payload, SVIX_SECRET);

    const result = verifySvixSignature(
      payload,
      {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${signature}`,
      },
      SVIX_SECRET
    );

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/future/);
  });

  it('rejects a malformed (non-numeric) timestamp', () => {
    const result = verifySvixSignature(
      payload,
      {
        'svix-id': 'msg_1',
        'svix-timestamp': 'not-a-number',
        'svix-signature': 'v1,abc',
      },
      SVIX_SECRET
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid timestamp format');
  });

  it('tries each signature in a multi-signature header and accepts the second match', () => {
    const svixId = 'msg_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const correct = svixSign(svixId, svixTimestamp, payload, SVIX_SECRET);

    const result = verifySvixSignature(
      payload,
      {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        // First signature is wrong, second is correct -- Svix redelivers
        // with multiple candidate signatures when a secret was rotated.
        'svix-signature': `v1,wrong-signature-value v1,${correct}`,
      },
      SVIX_SECRET
    );

    expect(result.valid).toBe(true);
  });

  it('skips non-v1 signature versions without matching them', () => {
    const svixId = 'msg_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const correct = svixSign(svixId, svixTimestamp, payload, SVIX_SECRET);

    const result = verifySvixSignature(
      payload,
      {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        // A v2-only header should never validate even though the value
        // happens to equal a correct v1 signature.
        'svix-signature': `v2,${correct}`,
      },
      SVIX_SECRET
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid webhook signature');
  });

  it('reports invalid JSON payload after a valid signature check', () => {
    const svixId = 'msg_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const badPayload = '{not valid json';
    const signature = svixSign(svixId, svixTimestamp, badPayload, SVIX_SECRET);

    const result = verifySvixSignature(
      badPayload,
      {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${signature}`,
      },
      SVIX_SECRET
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid JSON payload');
  });

  it('accepts a secret with no whsec_ prefix (treated as raw base64)', () => {
    const rawSecret = Buffer.from('raw-secret-bytes').toString('base64');
    const svixId = 'msg_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const signature = svixSign(svixId, svixTimestamp, payload, rawSecret);

    const result = verifySvixSignature(
      payload,
      {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${signature}`,
      },
      rawSecret
    );

    expect(result.valid).toBe(true);
  });
});

describe('verifyStripeSignature', () => {
  const payload = JSON.stringify({ type: 'invoice.payment_succeeded' });

  it('accepts a validly signed payload', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = stripeSign(timestamp, payload, STRIPE_SECRET);

    const result = verifyStripeSignature(
      payload,
      `t=${timestamp},v1=${signature}`,
      STRIPE_SECRET
    );

    expect(result.valid).toBe(true);
    expect(result.payload).toEqual({ type: 'invoice.payment_succeeded' });
  });

  it('rejects an empty signature header', () => {
    const result = verifyStripeSignature(payload, '', STRIPE_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Missing Stripe signature header');
  });

  it('rejects a header with no timestamp element', () => {
    const signature = stripeSign('123', payload, STRIPE_SECRET);
    const result = verifyStripeSignature(
      payload,
      `v1=${signature}`,
      STRIPE_SECRET
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Missing timestamp in Stripe signature');
  });

  it('rejects a header with no v1 signature element', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = verifyStripeSignature(
      payload,
      `t=${timestamp}`,
      STRIPE_SECRET
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('No v1 signatures found in Stripe signature');
  });

  it('rejects a wrong signature', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = verifyStripeSignature(
      payload,
      `t=${timestamp},v1=deadbeef`,
      STRIPE_SECRET
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid Stripe webhook signature');
  });

  it('rejects a stale timestamp', () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 1000);
    const signature = stripeSign(timestamp, payload, STRIPE_SECRET);
    const result = verifyStripeSignature(
      payload,
      `t=${timestamp},v1=${signature}`,
      STRIPE_SECRET
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too old/);
  });

  it('accepts multiple v1 signatures when one matches', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = stripeSign(timestamp, payload, STRIPE_SECRET);
    const result = verifyStripeSignature(
      payload,
      `t=${timestamp},v1=wrongvalue,v1=${signature}`,
      STRIPE_SECRET
    );
    expect(result.valid).toBe(true);
  });

  it('reports invalid JSON payload after a valid signature check', () => {
    const badPayload = '{not valid json';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = stripeSign(timestamp, badPayload, STRIPE_SECRET);
    const result = verifyStripeSignature(
      badPayload,
      `t=${timestamp},v1=${signature}`,
      STRIPE_SECRET
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid JSON payload');
  });
});

describe('verifyGenericHmacSignature', () => {
  const payload = JSON.stringify({ event: 'ping' });

  it('rejects a missing signature', () => {
    const result = verifyGenericHmacSignature(payload, '', GENERIC_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Missing webhook signature');
  });

  it('accepts a valid hex-encoded signature with no timestamp', () => {
    const hex = createHmac('sha256', GENERIC_SECRET)
      .update(payload)
      .digest('hex');
    const result = verifyGenericHmacSignature(payload, hex, GENERIC_SECRET);
    expect(result.valid).toBe(true);
    expect(result.payload).toEqual({ event: 'ping' });
  });

  it('accepts a valid base64-encoded signature with no timestamp', () => {
    const b64 = createHmac('sha256', GENERIC_SECRET)
      .update(payload)
      .digest('base64');
    const result = verifyGenericHmacSignature(payload, b64, GENERIC_SECRET);
    expect(result.valid).toBe(true);
  });

  it('rejects a signature that matches neither hex nor base64', () => {
    const result = verifyGenericHmacSignature(
      payload,
      'totally-wrong',
      GENERIC_SECRET
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid webhook signature');
  });

  it('honors an explicit timestamp and rejects it when stale', () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 1000);
    const dataToSign = `${timestamp}.${payload}`;
    const hex = createHmac('sha256', GENERIC_SECRET)
      .update(dataToSign)
      .digest('hex');
    const result = verifyGenericHmacSignature(
      payload,
      hex,
      GENERIC_SECRET,
      timestamp
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too old/);
  });

  it('accepts a valid signature that includes a fresh timestamp', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const dataToSign = `${timestamp}.${payload}`;
    const hex = createHmac('sha256', GENERIC_SECRET)
      .update(dataToSign)
      .digest('hex');
    const result = verifyGenericHmacSignature(
      payload,
      hex,
      GENERIC_SECRET,
      timestamp
    );
    expect(result.valid).toBe(true);
  });

  it('reports invalid JSON payload after a valid signature check', () => {
    const badPayload = '{not valid json';
    const hex = createHmac('sha256', GENERIC_SECRET)
      .update(badPayload)
      .digest('hex');
    const result = verifyGenericHmacSignature(badPayload, hex, GENERIC_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid JSON payload');
  });
});

describe('verifyWebhook', () => {
  const payload = JSON.stringify({ ok: true });

  it('routes to Svix verification for the clerk provider', () => {
    const svixId = 'msg_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const signature = svixSign(svixId, svixTimestamp, payload, SVIX_SECRET);

    const result = verifyWebhook(
      'clerk',
      payload,
      {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${signature}`,
      },
      SVIX_SECRET
    );

    expect(result.valid).toBe(true);
  });

  it('routes to Stripe verification for the stripe provider', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = stripeSign(timestamp, payload, STRIPE_SECRET);

    const result = verifyWebhook(
      'stripe',
      payload,
      { 'stripe-signature': `t=${timestamp},v1=${signature}` },
      STRIPE_SECRET
    );

    expect(result.valid).toBe(true);
  });

  it('defaults the stripe-signature header to empty string when absent', () => {
    const result = verifyWebhook('stripe', payload, {}, STRIPE_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Missing Stripe signature header');
  });

  it('routes to generic HMAC verification for the generic provider', () => {
    const hex = createHmac('sha256', GENERIC_SECRET)
      .update(payload)
      .digest('hex');

    const result = verifyWebhook(
      'generic',
      payload,
      { 'x-webhook-signature': hex },
      GENERIC_SECRET
    );

    expect(result.valid).toBe(true);
  });

  it('defaults the generic signature header to empty string when absent', () => {
    const result = verifyWebhook('generic', payload, {}, GENERIC_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Missing webhook signature');
  });

  it('rejects an unknown provider', () => {
    const result = verifyWebhook(
      // Force an unsupported provider through the default branch.
      'unknown' as unknown as 'clerk',
      payload,
      {},
      'secret'
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Unknown webhook provider: unknown');
  });
});

describe('extractWebhookHeaders', () => {
  it('lower-cases header names into a plain object', () => {
    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: {
        'Svix-Id': 'msg_1',
        'SVIX-TIMESTAMP': '123',
        'X-Webhook-Signature': 'abc',
      },
      body: '{}',
    });

    const headers = extractWebhookHeaders(request);

    expect(headers['svix-id']).toBe('msg_1');
    expect(headers['svix-timestamp']).toBe('123');
    expect(headers['x-webhook-signature']).toBe('abc');
  });
});

describe('logWebhookEvent', () => {
  it('logs failures through console.warn with the failure details', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logWebhookEvent('clerk', 'failed', {
      error: 'Invalid webhook signature',
      webhookId: 'msg_1',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[Webhook Security]',
      expect.stringContaining('"event":"failed"')
    );
    warnSpy.mockRestore();
  });

  it('logs received/verified events through console.info', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logWebhookEvent('stripe', 'received', {
      eventType: 'invoice.payment_succeeded',
    });
    logWebhookEvent('stripe', 'verified', {
      eventType: 'invoice.payment_succeeded',
    });
    expect(infoSpy).toHaveBeenCalledTimes(2);
    infoSpy.mockRestore();
  });
});
