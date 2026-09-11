/**
 * Stripe billing lib for the Flowstarter concierge service.
 *
 * Handles platform-side billing: how Flowstarter charges its concierge clients.
 * NOT the same as the per-project Stripe integration that lets a client embed
 * a Buy Button on their own site (that lives outside this lib).
 *
 * Concierge billing flow:
 *   1. Discovery call → team scopes setup fee + monthly fee
 *   2. team clicks "Send deposit invoice" → createDepositInvoice (20%)
 *   3. Client pays via Stripe-hosted invoice URL → webhook marks deposit_status='paid'
 *   4. Team builds the site
 *   5. Site approved → team clicks "Send final invoice" → createFinalInvoice (80%)
 *   6. Client pays → webhook marks final_status='paid'
 *   7. Team activates a monthly or yearly care subscription
 *   8. Production activation waits for final payment and a real subscription
 *
 * Pairs with /api/webhooks/stripe/route.ts which is already implemented.
 */

import Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';

export const STRIPE_API_VERSION = '2026-02-25.clover' as const;

/**
 * Workspaces row, narrowed to just the columns the billing flow touches.
 * (Was ProjectBillingRow — kept as a re-exported alias for older imports.)
 */
export type WorkspaceBillingRow = {
  id: string;
  client_email: string | null;
  client_name: string | null;
  client_business_name: string | null;
  /** Legacy euro column; read through quoteMinorFrom, never directly. */
  setup_fee: number | null;
  final_value_minor: number | null;
  monthly_fee: number | null;
  billing_interval: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  subscription_trial_ends: string | null;
  deposit_status: string | null;
  deposit_invoice_id: string | null;
  final_status: string | null;
  final_invoice_id: string | null;
};

export type ProjectBillingRow = WorkspaceBillingRow;

export class StripeBillingError extends Error {
  constructor(public code: string, message: string, public cause?: unknown) {
    super(message);
    this.name = 'StripeBillingError';
  }
}

export interface StripeBillingOptions {
  apiKey?: string;
  client?: Stripe;
  defaultCurrency?: string;
}

/**
 * Wrapper around the Stripe SDK that knows how to bill a Flowstarter project.
 * Each method takes the project row + only the fields it needs to act on,
 * keeping side-effects (DB writes) out of this lib — those happen in the
 * API route that calls these methods.
 */
export class StripeBilling {
  public readonly stripe: Stripe;
  public readonly currency: string;

  constructor(opts: StripeBillingOptions = {}) {
    if (opts.client) {
      this.stripe = opts.client;
    } else {
      const key = opts.apiKey ?? process.env.STRIPE_SECRET_KEY;
      if (!key) {
        throw new StripeBillingError(
          'missing_secret_key',
          'STRIPE_SECRET_KEY is not configured'
        );
      }
      this.stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
    }
    this.currency = (opts.defaultCurrency ?? 'eur').toLowerCase();
  }

  /**
   * Returns the Stripe Customer ID for a workspace, creating one if missing.
   * Caller persists the new ID onto workspaces.stripe_customer_id.
   */
  async getOrCreateCustomer(workspace: WorkspaceBillingRow): Promise<{
    customerId: string;
    created: boolean;
  }> {
    if (workspace.stripe_customer_id) {
      return { customerId: workspace.stripe_customer_id, created: false };
    }
    if (!workspace.client_email) {
      throw new StripeBillingError(
        'missing_client_email',
        'Workspace has no client_email; set one before creating a Stripe customer'
      );
    }
    const name =
      workspace.client_business_name?.trim() ||
      workspace.client_name?.trim() ||
      workspace.client_email;
    const customer = await this.stripe.customers.create({
      email: workspace.client_email,
      name,
      metadata: {
        workspaceId: workspace.id,
        flowstarterWorkspace: workspace.id,
      },
    });
    return { customerId: customer.id, created: true };
  }

  /**
   * Create a 20% deposit invoice for a workspace's setup fee.
   * Returns the invoice's hosted URL + the Stripe invoice ID.
   * Caller persists invoice ID + URL onto workspaces.deposit_invoice_*.
   */
  async createDepositInvoice(opts: {
    project: WorkspaceBillingRow;
    customerId: string;
    /** amount in the smallest currency unit, e.g. 15980 for 20% of €799 */
    amountMinor: number;
    daysUntilDue?: number;
    description?: string;
  }): Promise<{
    invoiceId: string;
    hostedUrl: string | null;
    status: Stripe.Invoice.Status;
    /** Whether Stripe accepted the invoice for its own hosted email. */
    stripeEmailed: boolean;
  }> {
    return this.createConciergeInvoice({
      ...opts,
      invoiceType: 'deposit',
      defaultDescription:
        opts.description ?? 'Flowstarter setup fee: 20% deposit',
    });
  }

  /**
   * Create the final 80% invoice once the site is approved.
   */
  async createFinalInvoice(opts: {
    project: WorkspaceBillingRow;
    customerId: string;
    amountMinor: number;
    daysUntilDue?: number;
    description?: string;
  }): Promise<{
    invoiceId: string;
    hostedUrl: string | null;
    status: Stripe.Invoice.Status;
    /** Whether Stripe accepted the invoice for its own hosted email. */
    stripeEmailed: boolean;
  }> {
    return this.createConciergeInvoice({
      ...opts,
      invoiceType: 'final',
      defaultDescription:
        opts.description ?? 'Flowstarter setup fee: final 80% on approval',
    });
  }

  /**
   * Create a Stripe Subscription for the monthly or yearly care fee.
   * `trialPeriodDays` defaults to 30 (first month free) per pricing copy.
   * Caller is responsible for persisting subscription_id and resetting any
   * older subscription state.
   *
   * Requires a Stripe Product to attach the price to. Pass `productId`
   * explicitly OR set STRIPE_CONCIERGE_PRODUCT_ID in env. Create the
   * product once in your Stripe dashboard (e.g. "Flowstarter Concierge")
   * and reuse it for every client subscription — the per-client amount
   * lives on the Price, not the Product.
   */
  async activateSubscription(opts: {
    project: WorkspaceBillingRow;
    customerId: string;
    /** amount billed per selected interval, in the smallest currency unit */
    recurringAmountMinor: number;
    cadence: 'monthly' | 'yearly';
    /** Stripe Product ID (or set STRIPE_CONCIERGE_PRODUCT_ID in env) */
    productId?: string;
    trialPeriodDays?: number;
  }): Promise<{
    subscriptionId: string;
    status: Stripe.Subscription.Status;
    trialEnd: Date | null;
    currentPeriodEnd: Date | null;
  }> {
    const { project, customerId, recurringAmountMinor } = opts;
    if (project.stripe_subscription_id) {
      throw new StripeBillingError(
        'subscription_exists',
        `Project already has subscription ${project.stripe_subscription_id}; cancel it first`
      );
    }
    if (!Number.isInteger(recurringAmountMinor) || recurringAmountMinor <= 0) {
      throw new StripeBillingError(
        'invalid_amount',
        'recurringAmountMinor must be a positive integer'
      );
    }
    const productId = opts.productId ?? process.env.STRIPE_CONCIERGE_PRODUCT_ID;
    if (!productId) {
      throw new StripeBillingError(
        'missing_product_id',
        'productId is required; set STRIPE_CONCIERGE_PRODUCT_ID in env or pass productId explicitly'
      );
    }
    const trialDays = opts.trialPeriodDays ?? 30;

    const subscription = await this.stripe.subscriptions.create({
      customer: customerId,
      trial_period_days: trialDays,
      items: [
        {
          price_data: {
            currency: this.currency,
            unit_amount: recurringAmountMinor,
            recurring: {
              interval: opts.cadence === 'yearly' ? 'year' : 'month',
            },
            product: productId,
          },
        },
      ],
      metadata: { workspaceId: project.id, cadence: opts.cadence },
      // Auto-charge collection: Stripe attempts the card on file when the
      // trial ends. If no payment method is on file, the subscription enters
      // 'incomplete' state and we surface that in the webhook.
      collection_method: 'charge_automatically',
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    const item = subscription.items.data[0];
    const periodEnd = item?.current_period_end ?? null;
    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      trialEnd: subscription.trial_end
        ? new Date(subscription.trial_end * 1000)
        : null,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    };
  }

  /**
   * Create a Stripe Billing Portal session for a customer. Returns the
   * one-time URL the client uses to update their payment method, view
   * past invoices, or cancel themselves.
   *
   * Setup: in Stripe dashboard → Customer Portal, configure what the
   * portal exposes (default: payment methods + invoices). No code change
   * needed beyond this method.
   */
  async createBillingPortalSession(opts: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: opts.customerId,
      return_url: opts.returnUrl,
    });
    return { url: session.url };
  }

  /**
   * Cancel an active subscription. Default behaviour: cancel at period end
   * (so the client keeps service through what they've already paid for).
   * Pass `immediate: true` to cancel now (refunds handled separately by
   * the team via Stripe dashboard).
   */
  async cancelSubscription(opts: {
    project: WorkspaceBillingRow;
    immediate?: boolean;
  }): Promise<{
    subscriptionId: string;
    status: Stripe.Subscription.Status;
    cancelAtPeriodEnd: boolean;
  }> {
    const subId = opts.project.stripe_subscription_id;
    if (!subId) {
      throw new StripeBillingError(
        'no_subscription',
        'Project has no active stripe_subscription_id'
      );
    }
    const updated = opts.immediate
      ? await this.stripe.subscriptions.cancel(subId)
      : await this.stripe.subscriptions.update(subId, {
          cancel_at_period_end: true,
        });
    return {
      subscriptionId: updated.id,
      status: updated.status,
      cancelAtPeriodEnd: updated.cancel_at_period_end ?? false,
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async createConciergeInvoice(opts: {
    project: WorkspaceBillingRow;
    customerId: string;
    amountMinor: number;
    daysUntilDue?: number;
    invoiceType: 'deposit' | 'final';
    defaultDescription: string;
  }): Promise<{
    invoiceId: string;
    hostedUrl: string | null;
    status: Stripe.Invoice.Status;
    /** Whether Stripe accepted the invoice for its own hosted email. */
    stripeEmailed: boolean;
  }> {
    const {
      project,
      customerId,
      amountMinor,
      invoiceType,
      defaultDescription,
    } = opts;
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      throw new StripeBillingError(
        'invalid_amount',
        'amountMinor must be a positive integer'
      );
    }
    const daysUntilDue = opts.daysUntilDue ?? 14;

    // Create a draft invoice first so we control invoice metadata; then
    // add a single line item, then finalize so it's sendable.
    const draft = await this.stripe.invoices.create({
      customer: customerId,
      collection_method: 'send_invoice',
      days_until_due: daysUntilDue,
      auto_advance: false,
      currency: this.currency,
      metadata: {
        workspaceId: project.id,
        invoiceType,
      },
      description: defaultDescription,
    });
    if (!draft.id) {
      throw new StripeBillingError(
        'invoice_create_failed',
        'Stripe did not return an invoice id'
      );
    }

    await this.stripe.invoiceItems.create({
      customer: customerId,
      invoice: draft.id,
      amount: amountMinor,
      currency: this.currency,
      description: defaultDescription,
    });

    const finalized = await this.stripe.invoices.finalizeInvoice(draft.id);
    if (!finalized.id) {
      throw new StripeBillingError(
        'invoice_finalize_failed',
        'Stripe did not return a finalized invoice id'
      );
    }

    // `collection_method: 'send_invoice'` with `auto_advance: false` means
    // Stripe finalizes the invoice and then does nothing: no email, no
    // reminders. That is how a real client ended up with a finalized, payable
    // balance invoice that nobody ever told him about. `sendInvoice` is the
    // call that actually hands it to Stripe's own delivery.
    //
    // What it does in test mode is worth stating plainly, because it is not
    // "nothing" and it is not "the client gets it": Stripe delivers test-mode
    // invoice emails only to the email addresses on the Stripe account itself,
    // and only when invoice emails are enabled in the dashboard. A test-mode
    // customer address never receives one. That is exactly why the caller also
    // sends our own mail with the hosted link, which is the path that is
    // reliable in every mode.
    const sent = await this.sendInvoiceEmail(finalized.id);

    return {
      invoiceId: finalized.id,
      hostedUrl: (sent ?? finalized).hosted_invoice_url ?? null,
      status: (sent ?? finalized).status ?? 'draft',
      stripeEmailed: sent !== null,
    };
  }

  /**
   * Best effort by contract. The invoice exists and is payable at its hosted
   * URL whatever Stripe's mailer does, so a delivery problem must not turn a
   * created invoice into an HTTP error the operator reads as "it did not
   * work" and retries, minting a second invoice for the same money.
   */
  private async sendInvoiceEmail(
    invoiceId: string
  ): Promise<Stripe.Invoice | null> {
    try {
      return await this.stripe.invoices.sendInvoice(invoiceId);
    } catch (e) {
      console.error(
        `[billing] invoice ${invoiceId} was finalized but Stripe would not send it: ` +
          (e instanceof Error ? e.message : 'unknown error')
      );
      return null;
    }
  }
}

/**
 * Helper for API routes: load the minimal billing fields off `workspaces`,
 * then ensure stripe_customer_id is set (creating one if needed). Persists
 * the new customer ID immediately. Returns the up-to-date row + customer ID.
 */
export async function ensureBillingCustomer(
  supabase: SupabaseClient<Database>,
  billing: StripeBilling,
  workspaceId: string
): Promise<{ row: WorkspaceBillingRow; customerId: string }> {
  const { data, error } = await supabase
    .from('workspaces')
    .select(
      `id, client_email, client_name, client_business_name,
       setup_fee, final_value_minor, monthly_fee, billing_interval, stripe_customer_id, stripe_subscription_id,
       subscription_status, subscription_trial_ends,
       deposit_status, deposit_invoice_id,
       final_status, final_invoice_id`
    )
    .eq('id', workspaceId)
    .maybeSingle();

  if (error) {
    throw new StripeBillingError('db_error', error.message, error);
  }
  if (!data) {
    throw new StripeBillingError(
      'workspace_not_found',
      `Workspace ${workspaceId} not found`
    );
  }

  const row = data as WorkspaceBillingRow;

  if (row.stripe_customer_id) {
    return { row, customerId: row.stripe_customer_id };
  }

  const { customerId } = await billing.getOrCreateCustomer(row);

  const { error: updErr } = await supabase
    .from('workspaces')
    .update({ stripe_customer_id: customerId })
    .eq('id', workspaceId);

  if (updErr) {
    // The Stripe customer was created but we failed to persist; subsequent
    // calls will create another customer. Surface the error so the caller
    // knows to retry.
    throw new StripeBillingError(
      'persist_customer_failed',
      `Stripe customer ${customerId} created but could not be saved: ${updErr.message}`,
      updErr
    );
  }

  return {
    row: { ...row, stripe_customer_id: customerId },
    customerId,
  };
}
