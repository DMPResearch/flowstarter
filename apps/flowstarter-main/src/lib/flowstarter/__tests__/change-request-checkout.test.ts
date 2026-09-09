/**
 * The money side of a change request.
 *
 * Two halves of one contract, and the contract is the metadata: the request
 * id and the workspace, never an amount. The amount is read back from the row
 * at checkout time, and the webhook trusts Stripe's `paid` status rather than
 * anything the browser could have sent. Everything here runs in Stripe test
 * mode; the key is a fixture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { createFakeSupabase } from './fake-supabase';

const createSession = vi.fn();

vi.mock('stripe', () => ({
  default: class {
    checkout = { sessions: { create: createSession } };
  },
}));

const db = createFakeSupabase();

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

import {
  CHANGE_REQUEST_CHECKOUT_KIND,
  createChangeRequestCheckout,
  settleChangeRequestCheckout,
} from '../change-request-checkout';
import { getChangeRequest, type ChangeRequestRow } from '../change-requests';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const TABLE = 'flowstarter_change_requests';

function row(overrides: Partial<ChangeRequestRow> = {}): ChangeRequestRow {
  return {
    id: 'cr-1',
    workspace_id: WORKSPACE_ID,
    message_id: 'msg-1',
    request: 'Add a page for group workshops with its own booking calendar',
    classification: 'structural',
    matched_rules: ['structural:new-thing'],
    status: 'quoted',
    quote_minor: 19_000,
    currency: 'eur',
    quote_note: 'Two days of work',
    quoted_by: 'user_operator',
    quoted_at: '2026-09-08T10:00:00.000Z',
    responded_at: null,
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    paid_at: null,
    completed_at: null,
    created_by: 'user_client',
    created_at: '2026-09-08T09:00:00.000Z',
    updated_at: '2026-09-08T10:00:00.000Z',
    ...overrides,
  };
}

/** Seeds the row into the fake database and hands back the same object. */
function seeded(overrides: Partial<ChangeRequestRow> = {}): ChangeRequestRow {
  const seed = row(overrides);
  db.seed(TABLE, [{ ...seed }]);
  return seed;
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_1',
    payment_status: 'paid',
    payment_intent: 'pi_test_1',
    metadata: {
      kind: CHANGE_REQUEST_CHECKOUT_KIND,
      changeRequestId: 'cr-1',
      workspaceId: WORKSPACE_ID,
    },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => {
  db.reset();
  createSession.mockReset();
  createSession.mockResolvedValue({
    id: 'cs_test_1',
    url: 'https://checkout.stripe.com/c/pay/cs_test_1',
  });
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fixture');
});

describe('minting the checkout for an accepted quote', () => {
  it('charges the amount on the row, and tells Stripe only the ids', async () => {
    const quoted = seeded();

    const result = await createChangeRequestCheckout({
      row: quoted,
      clientEmail: 'maria@example.com',
      businessName: 'Ionescu Dental',
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      sessionId: 'cs_test_1',
    });

    const args = createSession.mock.calls[0]![0] as Record<string, never>;
    expect(args.mode).toBe('payment');
    expect(args.customer_email).toBe('maria@example.com');
    const lineItem = (args.line_items as Array<Record<string, never>>)[0]!;
    expect(lineItem.price_data).toMatchObject({
      currency: 'eur',
      unit_amount: 19_000,
    });
    expect(
      (lineItem.price_data as Record<string, never>).product_data
    ).toMatchObject({ name: 'Ionescu Dental: website change' });
    // The amount is never in metadata: the webhook must not be able to learn
    // a price from something a browser round-tripped.
    expect(args.metadata).toEqual({
      kind: 'change_request',
      changeRequestId: 'cr-1',
      workspaceId: WORKSPACE_ID,
    });
    expect(args.payment_intent_data).toEqual({ metadata: args.metadata });
    expect(args.success_url).toContain(
      `/dashboard/projects/${WORKSPACE_ID}/editor`
    );
    expect(args.success_url).toContain('paid=1');
    expect(args.cancel_url).toContain('cancelled=1');

    // The row is now accepted and carries the session that may settle it.
    const stored = await getChangeRequest(
      db.client as never,
      WORKSPACE_ID,
      'cr-1'
    );
    expect(stored?.status).toBe('accepted');
    expect(stored?.stripe_checkout_session_id).toBe('cs_test_1');
  });

  it('omits customer_email when the client never gave one', async () => {
    await createChangeRequestCheckout({
      row: seeded(),
      clientEmail: null,
      businessName: 'Ionescu Dental',
      origin: 'https://app.example.com',
    });

    expect(createSession.mock.calls[0]![0]).not.toHaveProperty(
      'customer_email'
    );
  });

  it('trims a very long ask down to what Stripe will accept as a description', async () => {
    const long = 'a'.repeat(500);
    await createChangeRequestCheckout({
      row: seeded({ request: long }),
      clientEmail: null,
      businessName: 'Ionescu Dental',
      origin: 'https://app.example.com',
    });

    const args = createSession.mock.calls[0]![0] as Record<string, never>;
    const product = (
      (args.line_items as Array<Record<string, never>>)[0]!
        .price_data as Record<string, never>
    ).product_data as {
      description: string;
    };
    expect(product.description).toHaveLength(300);
  });

  it('refuses to open a checkout when payments are not configured', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');

    await expect(
      createChangeRequestCheckout({
        row: seeded(),
        clientEmail: null,
        businessName: 'Ionescu Dental',
        origin: 'https://app.example.com',
      })
    ).rejects.toMatchObject({ code: 'STRIPE_UNCONFIGURED', status: 503 });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('refuses a request with nothing to pay', async () => {
    for (const quote_minor of [null, 0, -100]) {
      await expect(
        createChangeRequestCheckout({
          row: row({ quote_minor }),
          clientEmail: null,
          businessName: 'Ionescu Dental',
          origin: 'https://app.example.com',
        })
      ).rejects.toMatchObject({ code: 'CHANGE_REQUEST_AMOUNT', status: 409 });
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  it('does not accept the quote when Stripe returns a session with no link', async () => {
    createSession.mockResolvedValue({ id: 'cs_test_1', url: null });
    const quoted = seeded();

    await expect(
      createChangeRequestCheckout({
        row: quoted,
        clientEmail: null,
        businessName: 'Ionescu Dental',
        origin: 'https://app.example.com',
      })
    ).rejects.toMatchObject({ code: 'STRIPE_NO_URL', status: 502 });

    // Nothing was accepted: the client can try again on the same quote.
    expect(db.rows(TABLE)[0]!.status).toBe('quoted');
  });

  it('refuses to open a second checkout for a request that is already paid', async () => {
    const paid = seeded({ status: 'paid' });

    await expect(
      createChangeRequestCheckout({
        row: paid,
        clientEmail: null,
        businessName: 'Ionescu Dental',
        origin: 'https://app.example.com',
      })
    ).rejects.toMatchObject({ code: 'CHANGE_REQUEST_TRANSITION', status: 409 });
  });
});

describe('settling the webhook', () => {
  it('marks the request paid and puts it on the project timeline', async () => {
    seeded({ status: 'accepted', stripe_checkout_session_id: 'cs_test_1' });

    const outcome = await settleChangeRequestCheckout(session());

    expect(outcome).toEqual({ changeRequestId: 'cr-1', outcome: 'paid' });
    const stored = db.rows(TABLE)[0]!;
    expect(stored.status).toBe('paid');
    expect(stored.stripe_payment_intent_id).toBe('pi_test_1');
    expect(stored.paid_at).not.toBeNull();

    const event = db.rows('project_events')[0]!;
    expect(event).toMatchObject({
      workspace_id: WORKSPACE_ID,
      kind: 'change_request_paid',
      actor: 'stripe',
    });
    // The amount on the timeline is the one the row carried, never the session.
    expect(event.payload).toEqual({
      changeRequestId: 'cr-1',
      amountMinor: 19_000,
      currency: 'eur',
      checkoutSessionId: 'cs_test_1',
    });
  });

  it('reads the payment intent out of an expanded session too', async () => {
    seeded({ status: 'accepted' });

    await settleChangeRequestCheckout(
      session({ payment_intent: { id: 'pi_expanded' } })
    );

    expect(db.rows(TABLE)[0]!.stripe_payment_intent_id).toBe('pi_expanded');
  });

  it('records no payment intent when Stripe sent none', async () => {
    seeded({ status: 'accepted' });

    await settleChangeRequestCheckout(session({ payment_intent: null }));

    expect(db.rows(TABLE)[0]!.stripe_payment_intent_id).toBeNull();
  });

  it('moves no money for a session Stripe has not marked paid', async () => {
    seeded({ status: 'accepted' });

    expect(
      await settleChangeRequestCheckout(session({ payment_status: 'unpaid' }))
    ).toEqual({ changeRequestId: 'cr-1', outcome: 'unpaid' });
    expect(db.rows(TABLE)[0]!.status).toBe('accepted');
    expect(db.rows('project_events')).toHaveLength(0);
  });

  it('ignores a session that is not a change request at all', async () => {
    for (const metadata of [
      undefined,
      {},
      { changeRequestId: 'cr-1' },
      { workspaceId: WORKSPACE_ID },
    ]) {
      expect(await settleChangeRequestCheckout(session({ metadata }))).toEqual({
        changeRequestId: null,
        outcome: 'unknown',
      });
    }
  });

  it('does not settle a request that belongs to another workspace', async () => {
    seeded({ status: 'accepted', workspace_id: 'ws-someone-else' });

    const outcome = await settleChangeRequestCheckout(session());

    expect(outcome).toEqual({ changeRequestId: 'cr-1', outcome: 'unknown' });
    expect(db.rows(TABLE)[0]!.status).toBe('accepted');
  });

  it('writes nothing the second time Stripe delivers the same event', async () => {
    seeded({ status: 'paid', paid_at: '2026-09-08T12:00:00.000Z' });

    expect(await settleChangeRequestCheckout(session())).toEqual({
      changeRequestId: 'cr-1',
      outcome: 'already_paid',
    });
    expect(db.rows(TABLE)[0]!.paid_at).toBe('2026-09-08T12:00:00.000Z');
    expect(db.rows('project_events')).toHaveLength(0);

    db.reset();
    seeded({ status: 'done' });
    expect((await settleChangeRequestCheckout(session())).outcome).toBe(
      'already_paid'
    );
  });
});
