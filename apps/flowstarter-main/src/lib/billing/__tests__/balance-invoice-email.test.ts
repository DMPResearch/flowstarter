/**
 * Our own "your balance invoice is ready", sent alongside Stripe's hosted
 * invoice mail. `notifyClientOnce` owns delivery and dedupe; this module owns
 * only turning a Stripe invoice into the right call to it, so the mock here
 * stands in for `notifyClientOnce` and every assertion is about what this
 * module handed it, not about sending or the ledger (covered separately in
 * client-notifications.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  formatInvoiceAmount,
  notifyBalanceInvoiceReady,
} from '../balance-invoice-email';

const notifyClientOnce = vi.fn();
vi.mock('@/lib/flowstarter/client-notifications', () => ({
  notifyClientOnce: (...args: unknown[]) => notifyClientOnce(...args),
}));

beforeEach(() => {
  notifyClientOnce.mockReset();
  notifyClientOnce.mockResolvedValue({ sent: true });
});

describe('formatInvoiceAmount', () => {
  it('formats minor units as a euro amount', () => {
    expect(formatInvoiceAmount(63920, 'eur')).toContain('639.20');
  });

  it('falls back to a plain "<amount> <CODE>" string rather than throwing on a malformed currency code', () => {
    // Intl.NumberFormat only validates that a currency code is three letters,
    // not that it is a real ISO 4217 code, so triggering the catch branch
    // needs a code that fails even that syntactic check.
    expect(formatInvoiceAmount(63920, 'usd1')).toBe('639.20 USD1');
  });
});

describe('notifyBalanceInvoiceReady', () => {
  const baseInput = {
    workspaceId: 'ws_1',
    invoiceId: 'in_final2',
    hostedUrl: 'https://invoice.stripe.com/def',
    amountMinor: 63920,
    currency: 'eur',
  };

  it('sends nothing and returns false when there is no hosted URL', async () => {
    // The invoice still exists and the operator still gets a 200; the
    // dashboard is what tells the client instead, since there is no link to
    // put in an email yet.
    const result = await notifyBalanceInvoiceReady({
      ...baseInput,
      hostedUrl: null,
    });
    expect(result).toBe(false);
    expect(notifyClientOnce).not.toHaveBeenCalled();
  });

  it('keys the dedupe on the invoice id, not the workspace', async () => {
    // A new final invoice for the same workspace (rare, but possible after a
    // correction) has to be able to notify again.
    await notifyBalanceInvoiceReady(baseInput);
    const call = notifyClientOnce.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      workspaceId: 'ws_1',
      notification: 'balance_invoice',
      dedupeKey: 'in_final2',
    });
  });

  it('renders the hosted URL and the formatted amount into the email', async () => {
    await notifyBalanceInvoiceReady(baseInput);
    const call = notifyClientOnce.mock.calls[0]?.[0];
    const rendered = call.render({
      workspaceId: 'ws_1',
      email: 'client@example.com',
      clientName: 'Ana Pop',
      businessName: 'Acme Coaching',
      dashboardUrl: 'https://flowstarter.net/dashboard/projects/ws_1',
    });
    expect(rendered.subject).toBe('Your balance invoice is ready');
    expect(rendered.html).toContain('https://invoice.stripe.com/def');
    expect(rendered.html).toContain('639.20');
  });

  it('returns whatever notifyClientOnce reports', async () => {
    notifyClientOnce.mockResolvedValueOnce({
      sent: false,
      reason: 'no_recipient',
    });
    const result = await notifyBalanceInvoiceReady(baseInput);
    expect(result).toBe(false);
  });
});
