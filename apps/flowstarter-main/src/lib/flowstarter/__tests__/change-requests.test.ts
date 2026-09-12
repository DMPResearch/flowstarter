/**
 * A change request's life is a table of allowed moves, and the price the
 * operator sees first comes from the classifier's own labels. Both are pure.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHANGE_REQUEST_TRANSITIONS,
  acceptChangeRequest,
  acceptFreeChangeRequest,
  canTransition,
  classifyChangeRequest,
  completeChangeRequest,
  createChangeRequest,
  declineChangeRequest,
  getChangeRequest,
  listChangeRequests,
  markChangeRequestPaid,
  quoteChangeRequest,
  suggestQuoteMinor,
  toChangeRequestView,
  type ChangeRequestRow,
} from '../change-requests';
import { createFakeSupabase } from './fake-supabase';

function row(overrides: Partial<ChangeRequestRow> = {}): ChangeRequestRow {
  return {
    id: 'cr-1',
    workspace_id: 'ws-1',
    message_id: null,
    request: 'Add a page for group workshops with its own booking calendar',
    classification: 'structural',
    matched_rules: ['structural:new-thing'],
    status: 'requested',
    quote_minor: null,
    currency: 'eur',
    quote_note: null,
    quoted_by: null,
    quoted_at: null,
    responded_at: null,
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    paid_at: null,
    completed_at: null,
    build_job_id: null,
    built_version: null,
    completed_via: null,
    completion_note: null,
    created_by: 'user_client',
    created_at: '2026-09-08T10:00:00.000Z',
    updated_at: '2026-09-08T10:00:00.000Z',
    ...overrides,
  };
}

describe('who may move a request where', () => {
  it('lets the operator quote, re-quote and decline, and finish only what was paid', () => {
    expect(canTransition('requested', 'quoted', 'operator')).toBe(true);
    expect(canTransition('quoted', 'quoted', 'operator')).toBe(true);
    expect(canTransition('quoted', 'declined', 'operator')).toBe(true);
    expect(canTransition('paid', 'done', 'operator')).toBe(true);
    expect(canTransition('quoted', 'done', 'operator')).toBe(false);
    expect(canTransition('requested', 'paid', 'operator')).toBe(false);
  });

  it('lets the client answer a quote and nothing else', () => {
    expect(canTransition('quoted', 'accepted', 'client')).toBe(true);
    expect(canTransition('quoted', 'declined', 'client')).toBe(true);
    expect(canTransition('quoted', 'paid', 'client')).toBe(true); // a zero quote
    expect(canTransition('requested', 'accepted', 'client')).toBe(false);
    expect(canTransition('paid', 'done', 'client')).toBe(false);
    expect(canTransition('accepted', 'declined', 'client')).toBe(false);
  });

  it('lets Stripe settle an accepted request only', () => {
    expect(canTransition('accepted', 'paid', 'stripe')).toBe(true);
    expect(canTransition('quoted', 'paid', 'stripe')).toBe(false);
    expect(canTransition('paid', 'paid', 'stripe')).toBe(false);
  });

  it('never leaves done or declined', () => {
    for (const t of CHANGE_REQUEST_TRANSITIONS) {
      expect(['done', 'declined']).not.toContain(t.from);
    }
  });
});

describe('the suggested quote', () => {
  it('takes the dearest rule that fired', () => {
    expect(suggestQuoteMinor(['structural:new-thing'])).toBe(19_000);
    expect(suggestQuoteMinor(['structural:theme', 'structural:platform'])).toBe(
      24_000
    );
    expect(suggestQuoteMinor(['image:media-swap'])).toBe(3_000);
  });

  it('has a base rate for a request no rule priced', () => {
    expect(suggestQuoteMinor([])).toBe(9_000);
    expect(suggestQuoteMinor(['something:unknown'])).toBe(9_000);
  });
});

describe('the view', () => {
  it('shows the client no suggested price and the operator one', () => {
    expect(toChangeRequestView(row()).suggestedQuoteMinor).toBeUndefined();
    expect(
      toChangeRequestView(row(), { forOperator: true }).suggestedQuoteMinor
    ).toBe(19_000);
  });

  it('never invents a status the table does not know', () => {
    expect(toChangeRequestView(row({ status: 'weird' })).status).toBe(
      'requested'
    );
  });

  it('survives a matched_rules column that is not a list of labels', () => {
    // `matched_rules` is jsonb: a row written before the classifier existed,
    // or by hand, must render rather than throw at the client.
    expect(
      toChangeRequestView(row({ matched_rules: null })).matchedRules
    ).toEqual([]);
    expect(
      toChangeRequestView(row({ matched_rules: { label: 'theme' } }))
        .matchedRules
    ).toEqual([]);
    expect(
      toChangeRequestView(row({ matched_rules: ['structural:theme', 7, null] }))
        .matchedRules
    ).toEqual(['structural:theme']);
    // With nothing priced, the operator still gets the base rate.
    expect(
      toChangeRequestView(row({ matched_rules: null }), { forOperator: true })
        .suggestedQuoteMinor
    ).toBe(9_000);
  });
});

// ── The same table, enforced against a database ────────────────────────────
//
// `canTransition` is the rule; `move` is the rule applied to a row with a
// compare-and-set on the status we read a moment ago. Both halves matter: a
// quote that skips a step and a quote that races a payment are different
// bugs with the same symptom.

describe('a change request through quote, payment and completion', () => {
  const db = createFakeSupabase();
  const client = () =>
    db.client as unknown as Parameters<typeof createChangeRequest>[0];

  beforeEach(() => db.reset());

  async function filed(
    request = 'Add a group workshops page with its own calendar'
  ) {
    return createChangeRequest(client(), {
      workspaceId: 'ws-1',
      request: `  ${request}  `,
      classification: classifyChangeRequest(request),
      messageId: 'msg-1',
      createdBy: 'user_client',
    });
  }

  it('files the client ask with the classifier verdict and no price yet', async () => {
    const created = await filed();

    expect(created.status).toBe('requested');
    expect(created.quote_minor).toBeUndefined();
    // Trimmed, because the ask is shown back to the client verbatim.
    expect(created.request).toBe(
      'Add a group workshops page with its own calendar'
    );
    expect(created.classification).toBe('structural');
    expect(created.currency).toBe('eur');
  });

  it('walks quoted -> accepted -> paid -> done, one step at a time', async () => {
    const created = await filed();

    const quoted = await quoteChangeRequest(client(), created, {
      amountMinor: 24_000,
      note: 'Two days of work',
      quotedBy: 'user_operator',
    });
    expect(quoted.status).toBe('quoted');
    expect(quoted.quote_minor).toBe(24_000);
    expect(quoted.quote_note).toBe('Two days of work');
    expect(quoted.quoted_by).toBe('user_operator');

    const accepted = await acceptChangeRequest(client(), quoted, 'cs_test_123');
    expect(accepted.status).toBe('accepted');
    expect(accepted.stripe_checkout_session_id).toBe('cs_test_123');

    const paid = await markChangeRequestPaid(client(), accepted, {
      paymentIntentId: 'pi_test_123',
    });
    expect(paid.status).toBe('paid');
    expect(paid.stripe_payment_intent_id).toBe('pi_test_123');
    expect(paid.paid_at).not.toBeNull();

    const done = await completeChangeRequest(client(), paid, {
      reason: 'Handled on a call; the client no longer wants it built.',
    });
    expect(done.status).toBe('done');
    expect(done.completed_at).not.toBeNull();
    expect(done.completed_via).toBe('manual');
  });

  it('re-quotes a quoted request and drops the checkout the old price minted', async () => {
    const created = await filed();
    const first = await quoteChangeRequest(client(), created, {
      amountMinor: 9_000,
      note: null,
      quotedBy: 'user_operator',
    });
    // A Checkout session and a client response left over from the first price.
    Object.assign(db.rows('flowstarter_change_requests')[0]!, {
      stripe_checkout_session_id: 'cs_test_old',
      responded_at: '2026-09-08T11:00:00.000Z',
    });

    const requoted = await quoteChangeRequest(client(), first, {
      amountMinor: 19_000,
      note: 'Scope grew',
      quotedBy: 'user_operator',
    });

    expect(requoted.status).toBe('quoted');
    expect(requoted.quote_minor).toBe(19_000);
    expect(requoted.quote_note).toBe('Scope grew');
    // A stale Checkout session must not be able to settle the new price.
    expect(requoted.stripe_checkout_session_id).toBeNull();
    expect(requoted.responded_at).toBeNull();
  });

  it('pays a zero quote without Stripe ever being involved', async () => {
    const created = await filed();
    const quoted = await quoteChangeRequest(client(), created, {
      amountMinor: 0,
      note: 'On the house',
      quotedBy: 'user_operator',
    });

    const paid = await acceptFreeChangeRequest(client(), quoted);

    expect(paid.status).toBe('paid');
    expect(paid.paid_at).not.toBeNull();
    expect(paid.stripe_checkout_session_id).toBeNull();
  });

  it('lets either side decline a quote', async () => {
    const byClient = await quoteChangeRequest(client(), await filed(), {
      amountMinor: 12_000,
      note: null,
      quotedBy: 'user_operator',
    });
    const declined = await declineChangeRequest(client(), byClient, 'client');
    expect(declined.status).toBe('declined');
    expect(declined.responded_at).not.toBeNull();

    const byOperator = await filed('Change the hero photo');
    expect(
      (await declineChangeRequest(client(), byOperator, 'operator')).status
    ).toBe('declined');
  });

  it('refuses a quote outside the form range, before touching the row', async () => {
    const created = await filed();
    for (const amountMinor of [-1, 100_000_01, 12.5]) {
      // The guard runs before the promise does, so it throws synchronously.
      expect(() =>
        quoteChangeRequest(client(), created, {
          amountMinor,
          note: null,
          quotedBy: 'user_operator',
        })
      ).toThrow(
        expect.objectContaining({
          code: 'CHANGE_REQUEST_AMOUNT',
          status: 400,
        })
      );
    }
    // The ceiling itself is allowed.
    expect(
      (
        await quoteChangeRequest(client(), created, {
          amountMinor: 100_000_00,
          note: null,
          quotedBy: 'user_operator',
        })
      ).quote_minor
    ).toBe(100_000_00);
  });

  it('refuses a step the table does not allow, naming who tried it', async () => {
    const created = await filed();

    await expect(
      markChangeRequestPaid(client(), created, { paymentIntentId: 'pi_x' })
    ).rejects.toMatchObject({
      code: 'CHANGE_REQUEST_TRANSITION',
      status: 409,
    });
    await expect(
      completeChangeRequest(client(), created, {
        reason: 'Handled on a call with the client.',
      })
    ).rejects.toThrow(
      /requested request cannot be marked done by the operator/
    );
  });

  it('refuses to settle a quote that was already paid while the tab was open', async () => {
    const created = await filed();
    const quoted = await quoteChangeRequest(client(), created, {
      amountMinor: 19_000,
      note: null,
      quotedBy: 'user_operator',
    });
    const accepted = await acceptChangeRequest(client(), quoted, 'cs_test_1');
    // What a concurrent request is holding: the row as it looked before the
    // webhook settled it.
    const stale = { ...accepted };
    await markChangeRequestPaid(client(), accepted, {
      paymentIntentId: 'pi_1',
    });

    await expect(
      markChangeRequestPaid(client(), stale, { paymentIntentId: 'pi_1' })
    ).rejects.toMatchObject({ code: 'CHANGE_REQUEST_STALE', status: 409 });
  });

  it('reads back only this workspace, newest first', async () => {
    await filed('Add a booking calendar');
    await filed('Change the fonts');
    db.seed('flowstarter_change_requests', [
      {
        id: 'cr-other',
        workspace_id: 'ws-2',
        status: 'requested',
        created_at: 'z',
      },
    ]);

    const mine = await listChangeRequests(client(), 'ws-1');
    expect(mine).toHaveLength(2);
    expect(mine.map((r) => r.workspace_id)).toEqual(['ws-1', 'ws-1']);
    expect(mine[0]!.created_at > mine[1]!.created_at).toBe(true);

    // A neighbour's id is not readable by guessing it.
    expect(await getChangeRequest(client(), 'ws-1', 'cr-other')).toBeNull();
    expect((await getChangeRequest(client(), 'ws-2', 'cr-other'))?.id).toBe(
      'cr-other'
    );
  });

  it('surfaces a database failure rather than reporting a phantom quote', async () => {
    const created = await filed();
    db.failing.add('flowstarter_change_requests');

    await expect(listChangeRequests(client(), 'ws-1')).rejects.toMatchObject({
      message: expect.stringContaining('unavailable'),
    });
    await expect(
      getChangeRequest(client(), 'ws-1', created.id)
    ).rejects.toMatchObject({
      message: expect.stringContaining('unavailable'),
    });
    await expect(
      quoteChangeRequest(client(), created, {
        amountMinor: 9_000,
        note: null,
        quotedBy: 'user_operator',
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('unavailable'),
    });
    await expect(
      createChangeRequest(client(), {
        workspaceId: 'ws-1',
        request: 'Another ask',
        classification: classifyChangeRequest('Another ask'),
        messageId: null,
        createdBy: 'user_client',
        currency: 'ron',
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('unavailable'),
    });
  });
});
