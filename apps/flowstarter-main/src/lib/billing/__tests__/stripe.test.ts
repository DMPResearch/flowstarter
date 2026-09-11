import { describe, expect, it, vi } from 'vitest';
import {
  StripeBilling,
  StripeBillingError,
  type WorkspaceBillingRow,
} from '../stripe';
import type Stripe from 'stripe';

function baseProject(
  overrides: Partial<WorkspaceBillingRow> = {}
): WorkspaceBillingRow {
  return {
    id: 'ws_1',
    client_email: 'client@example.com',
    client_name: 'Ana Pop',
    client_business_name: 'Acme Coaching',
    setup_fee: 799,
    // The authoritative quote; setup_fee stays as the legacy mirror.
    final_value_minor: 79_900,
    monthly_fee: 49,
    billing_interval: 'monthly',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_status: null,
    subscription_trial_ends: null,
    deposit_status: null,
    deposit_invoice_id: null,
    final_status: null,
    final_invoice_id: null,
    ...overrides,
  };
}

function fakeStripe(impl: Record<string, unknown>): Stripe {
  return impl as unknown as Stripe;
}

type AnyMock = ReturnType<typeof vi.fn>;

describe('StripeBilling.getOrCreateCustomer', () => {
  it('returns existing customer ID without calling Stripe', async () => {
    const customers = { create: vi.fn() };
    const billing = new StripeBilling({
      client: fakeStripe({ customers }),
    });
    const { customerId, created } = await billing.getOrCreateCustomer(
      baseProject({ stripe_customer_id: 'cus_existing' })
    );
    expect(customerId).toBe('cus_existing');
    expect(created).toBe(false);
    expect(customers.create).not.toHaveBeenCalled();
  });

  it('creates a customer with project metadata', async () => {
    const customers = {
      create: vi.fn(async () => ({ id: 'cus_new' })),
    };
    const billing = new StripeBilling({
      client: fakeStripe({ customers }),
    });
    const { customerId, created } = await billing.getOrCreateCustomer(
      baseProject()
    );
    expect(customerId).toBe('cus_new');
    expect(created).toBe(true);
    const arg = (customers.create as AnyMock).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      email: 'client@example.com',
      name: 'Acme Coaching',
      metadata: { workspaceId: 'ws_1', flowstarterWorkspace: 'ws_1' },
    });
  });

  it('throws when client_email is missing', async () => {
    const billing = new StripeBilling({
      client: fakeStripe({ customers: { create: vi.fn() } }),
    });
    await expect(
      billing.getOrCreateCustomer(baseProject({ client_email: null }))
    ).rejects.toBeInstanceOf(StripeBillingError);
  });
});

describe('StripeBilling.createDepositInvoice', () => {
  it('creates a draft invoice, adds line item, finalizes, returns hosted URL', async () => {
    const invoices = {
      create: vi.fn(async () => ({ id: 'in_draft' })),
      finalizeInvoice: vi.fn(async () => ({
        id: 'in_final',
        hosted_invoice_url: 'https://invoice.stripe.com/abc',
        status: 'open',
      })),
      sendInvoice: vi.fn(async () => ({
        id: 'in_final',
        hosted_invoice_url: 'https://invoice.stripe.com/abc',
        status: 'open',
      })),
    };
    const invoiceItems = { create: vi.fn(async () => ({})) };
    const billing = new StripeBilling({
      client: fakeStripe({ invoices, invoiceItems }),
    });
    const out = await billing.createDepositInvoice({
      project: baseProject({ stripe_customer_id: 'cus_1' }),
      customerId: 'cus_1',
      amountMinor: 39950,
    });
    expect(out.invoiceId).toBe('in_final');
    expect(out.hostedUrl).toBe('https://invoice.stripe.com/abc');
    expect(out.status).toBe('open');
    expect(out.stripeEmailed).toBe(true);

    const draftArg = (invoices.create as AnyMock).mock.calls[0]?.[0];
    expect(draftArg).toMatchObject({
      customer: 'cus_1',
      collection_method: 'send_invoice',
      days_until_due: 14,
      currency: 'eur',
      metadata: { workspaceId: 'ws_1', invoiceType: 'deposit' },
    });

    const itemArg = (invoiceItems.create as AnyMock).mock.calls[0]?.[0];
    expect(itemArg).toMatchObject({
      customer: 'cus_1',
      invoice: 'in_draft',
      amount: 39950,
      currency: 'eur',
    });

    expect(invoices.finalizeInvoice).toHaveBeenCalledWith('in_draft');
    // sendInvoice is what actually hands the finalized invoice to Stripe's
    // own delivery; finalizing alone leaves it created but never mailed.
    expect(invoices.sendInvoice).toHaveBeenCalledWith('in_final');
  });

  it('prefers the sent invoice hostedUrl/status over the finalized one', async () => {
    // Stripe can update hosted_invoice_url/status as a side effect of
    // sendInvoice (e.g. draft -> open), so the sent invoice is the source of
    // truth for what the caller shows an operator.
    const invoices = {
      create: vi.fn(async () => ({ id: 'in_draft' })),
      finalizeInvoice: vi.fn(async () => ({
        id: 'in_final',
        hosted_invoice_url: 'https://invoice.stripe.com/finalized-url',
        status: 'draft',
      })),
      sendInvoice: vi.fn(async () => ({
        id: 'in_final',
        hosted_invoice_url: 'https://invoice.stripe.com/sent-url',
        status: 'open',
      })),
    };
    const billing = new StripeBilling({
      client: fakeStripe({
        invoices,
        invoiceItems: { create: vi.fn(async () => ({})) },
      }),
    });
    const out = await billing.createDepositInvoice({
      project: baseProject({ stripe_customer_id: 'cus_1' }),
      customerId: 'cus_1',
      amountMinor: 39950,
    });
    expect(out.hostedUrl).toBe('https://invoice.stripe.com/sent-url');
    expect(out.status).toBe('open');
    expect(out.stripeEmailed).toBe(true);
  });

  it('rejects non-positive amounts', async () => {
    const billing = new StripeBilling({
      client: fakeStripe({
        invoices: {
          create: vi.fn(),
          finalizeInvoice: vi.fn(),
          sendInvoice: vi.fn(),
        },
        invoiceItems: { create: vi.fn() },
      }),
    });
    await expect(
      billing.createDepositInvoice({
        project: baseProject(),
        customerId: 'cus_1',
        amountMinor: 0,
      })
    ).rejects.toBeInstanceOf(StripeBillingError);
    await expect(
      billing.createDepositInvoice({
        project: baseProject(),
        customerId: 'cus_1',
        amountMinor: -100,
      })
    ).rejects.toBeInstanceOf(StripeBillingError);
  });
});

describe('StripeBilling.createFinalInvoice', () => {
  it('uses invoiceType=final in metadata', async () => {
    const invoices = {
      create: vi.fn(async () => ({ id: 'in_draft' })),
      finalizeInvoice: vi.fn(async () => ({
        id: 'in_final',
        hosted_invoice_url: 'https://invoice.stripe.com/x',
        status: 'open',
      })),
      sendInvoice: vi.fn(async () => ({
        id: 'in_final',
        hosted_invoice_url: 'https://invoice.stripe.com/x',
        status: 'open',
      })),
    };
    const billing = new StripeBilling({
      client: fakeStripe({
        invoices,
        invoiceItems: { create: vi.fn(async () => ({})) },
      }),
    });
    await billing.createFinalInvoice({
      project: baseProject({ stripe_customer_id: 'cus_1' }),
      customerId: 'cus_1',
      amountMinor: 39950,
    });
    expect((invoices.create as AnyMock).mock.calls[0]?.[0]).toMatchObject({
      metadata: { workspaceId: 'ws_1', invoiceType: 'final' },
    });
    // Same delivery path as the deposit invoice: the final invoice must also
    // reach the client, not just exist on Stripe.
    expect(invoices.sendInvoice).toHaveBeenCalledWith('in_final');
  });

  it('resolves (does not throw) when sendInvoice rejects, using the finalized invoice as fallback', async () => {
    // The invoice is already created and payable at its hosted URL by this
    // point. A delivery failure must not read as "it did not work" and send
    // the operator to retry, which would mint a second invoice for the same
    // money.
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const invoices = {
      create: vi.fn(async () => ({ id: 'in_draft' })),
      finalizeInvoice: vi.fn(async () => ({
        id: 'in_final',
        hosted_invoice_url: 'https://invoice.stripe.com/final-hosted',
        status: 'open',
      })),
      sendInvoice: vi.fn(async () => {
        throw new Error('Stripe would not send this invoice');
      }),
    };
    const billing = new StripeBilling({
      client: fakeStripe({
        invoices,
        invoiceItems: { create: vi.fn(async () => ({})) },
      }),
    });
    try {
      const out = await billing.createFinalInvoice({
        project: baseProject({ stripe_customer_id: 'cus_1' }),
        customerId: 'cus_1',
        amountMinor: 39950,
      });
      expect(out.invoiceId).toBe('in_final');
      expect(out.hostedUrl).toBe('https://invoice.stripe.com/final-hosted');
      expect(out.status).toBe('open');
      expect(out.stripeEmailed).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('StripeBilling.activateSubscription', () => {
  it('creates a subscription with 30-day trial by default', async () => {
    const subscriptions = {
      create: vi.fn(async () => ({
        id: 'sub_1',
        status: 'trialing',
        trial_end: 1735689600, // 2025-01-01
        items: {
          data: [{ current_period_end: 1738368000 }],
        },
      })),
    };
    const billing = new StripeBilling({
      client: fakeStripe({ subscriptions }),
    });
    const out = await billing.activateSubscription({
      project: baseProject({ stripe_customer_id: 'cus_1' }),
      customerId: 'cus_1',
      recurringAmountMinor: 4900,
      cadence: 'monthly',
      productId: 'prod_concierge',
    });
    expect(out.subscriptionId).toBe('sub_1');
    expect(out.status).toBe('trialing');
    expect(out.trialEnd).toBeInstanceOf(Date);
    expect(out.currentPeriodEnd).toBeInstanceOf(Date);

    const arg = (subscriptions.create as AnyMock).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      customer: 'cus_1',
      trial_period_days: 30,
      collection_method: 'charge_automatically',
      payment_behavior: 'default_incomplete',
      metadata: { workspaceId: 'ws_1' },
    });
    expect(arg?.items[0].price_data).toMatchObject({
      currency: 'eur',
      unit_amount: 4900,
      recurring: { interval: 'month' },
      product: 'prod_concierge',
    });
  });

  it('creates a yearly subscription when yearly cadence is selected', async () => {
    const subscriptions = {
      create: vi.fn(async () => ({
        id: 'sub_yearly',
        status: 'active',
        trial_end: null,
        items: { data: [{ current_period_end: 1767225600 }] },
      })),
    };
    const billing = new StripeBilling({
      client: fakeStripe({ subscriptions }),
    });

    await billing.activateSubscription({
      project: baseProject(),
      customerId: 'cus_1',
      recurringAmountMinor: 49_000,
      cadence: 'yearly',
      productId: 'prod_concierge',
      trialPeriodDays: 0,
    });

    const arg = (subscriptions.create as AnyMock).mock.calls[0]?.[0];
    expect(arg?.items[0].price_data).toMatchObject({
      unit_amount: 49_000,
      recurring: { interval: 'year' },
    });
    expect(arg?.metadata).toMatchObject({ cadence: 'yearly' });
  });

  it('refuses if subscription already exists', async () => {
    const billing = new StripeBilling({
      client: fakeStripe({ subscriptions: { create: vi.fn() } }),
    });
    await expect(
      billing.activateSubscription({
        project: baseProject({ stripe_subscription_id: 'sub_existing' }),
        customerId: 'cus_1',
        recurringAmountMinor: 4900,
        cadence: 'monthly',
        productId: 'prod_x',
      })
    ).rejects.toMatchObject({ code: 'subscription_exists' });
  });

  it('refuses non-positive recurringAmountMinor', async () => {
    const billing = new StripeBilling({
      client: fakeStripe({ subscriptions: { create: vi.fn() } }),
    });
    await expect(
      billing.activateSubscription({
        project: baseProject(),
        customerId: 'cus_1',
        recurringAmountMinor: 0,
        cadence: 'monthly',
        productId: 'prod_x',
      })
    ).rejects.toMatchObject({ code: 'invalid_amount' });
  });

  it('throws when productId is missing and STRIPE_CONCIERGE_PRODUCT_ID is unset', async () => {
    const original = process.env.STRIPE_CONCIERGE_PRODUCT_ID;
    delete process.env.STRIPE_CONCIERGE_PRODUCT_ID;
    try {
      const billing = new StripeBilling({
        client: fakeStripe({ subscriptions: { create: vi.fn() } }),
      });
      await expect(
        billing.activateSubscription({
          project: baseProject(),
          customerId: 'cus_1',
          recurringAmountMinor: 4900,
          cadence: 'monthly',
        })
      ).rejects.toMatchObject({ code: 'missing_product_id' });
    } finally {
      if (original !== undefined)
        process.env.STRIPE_CONCIERGE_PRODUCT_ID = original;
    }
  });
});

describe('StripeBilling.createBillingPortalSession', () => {
  it('creates a portal session and returns the URL', async () => {
    const billingPortal = {
      sessions: {
        create: vi.fn(async () => ({
          url: 'https://billing.stripe.com/p/session/xyz',
        })),
      },
    };
    const billing = new StripeBilling({
      client: fakeStripe({ billingPortal }),
    });
    const out = await billing.createBillingPortalSession({
      customerId: 'cus_1',
      returnUrl: 'https://flowstarter.dev/admin/dashboard/projects/ws_1',
    });
    expect(out.url).toBe('https://billing.stripe.com/p/session/xyz');
    expect(billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_1',
      return_url: 'https://flowstarter.dev/admin/dashboard/projects/ws_1',
    });
  });
});

describe('StripeBilling.cancelSubscription', () => {
  it('defaults to cancel at period end', async () => {
    const subscriptions = {
      update: vi.fn(async () => ({
        id: 'sub_1',
        status: 'active',
        cancel_at_period_end: true,
      })),
      cancel: vi.fn(),
    };
    const billing = new StripeBilling({
      client: fakeStripe({ subscriptions }),
    });
    const out = await billing.cancelSubscription({
      project: baseProject({ stripe_subscription_id: 'sub_1' }),
    });
    expect(out.cancelAtPeriodEnd).toBe(true);
    expect(subscriptions.update).toHaveBeenCalledWith('sub_1', {
      cancel_at_period_end: true,
    });
    expect(subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('cancels immediately when immediate=true', async () => {
    const subscriptions = {
      update: vi.fn(),
      cancel: vi.fn(async () => ({
        id: 'sub_1',
        status: 'canceled',
        cancel_at_period_end: false,
      })),
    };
    const billing = new StripeBilling({
      client: fakeStripe({ subscriptions }),
    });
    const out = await billing.cancelSubscription({
      project: baseProject({ stripe_subscription_id: 'sub_1' }),
      immediate: true,
    });
    expect(out.status).toBe('canceled');
    expect(subscriptions.cancel).toHaveBeenCalledWith('sub_1');
    expect(subscriptions.update).not.toHaveBeenCalled();
  });

  it('throws if there is no active subscription', async () => {
    const billing = new StripeBilling({
      client: fakeStripe({
        subscriptions: { update: vi.fn(), cancel: vi.fn() },
      }),
    });
    await expect(
      billing.cancelSubscription({ project: baseProject() })
    ).rejects.toMatchObject({ code: 'no_subscription' });
  });
});

describe('StripeBilling constructor', () => {
  it('throws when no api key + no client', () => {
    const original = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      expect(() => new StripeBilling()).toThrow(StripeBillingError);
    } finally {
      if (original !== undefined) process.env.STRIPE_SECRET_KEY = original;
    }
  });
});
