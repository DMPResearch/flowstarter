/**
 * Refunding the setup fee: the path that lets the published promise be kept.
 *
 * Terms and the landing hero have both promised a refund since launch and
 * nothing in the product could issue one. This is the missing half, and it is
 * one function rather than two route handlers, because the operator console
 * reaches it through `/api/admin/...` and `/api/team/...` and those two must
 * not be able to drift into two different refund policies.
 *
 * What it does, in the order it does it, and why that order:
 *
 *   1. Reads the workspace, its agreed price, and when the site launched.
 *      The launch date comes from the first deployment that actually went
 *      live, not from `last_deployed_at`, which moves on every rebuild and
 *      would silently restart the guarantee window every time a client
 *      changed a headline.
 *   2. Resolves which Stripe payment intents hold the money. The deposit may
 *      be a Checkout payment intent recorded on the workspace, or the payment
 *      intent behind a hosted deposit invoice; the balance is almost always
 *      the latter, because nothing has ever written
 *      `balance_payment_intent_id`. Both are resolved through Stripe and the
 *      resolved id is written back, so the next refund does not have to look
 *      it up again.
 *   3. Asks Stripe what is still refundable on each, so a refund made by hand
 *      from the dashboard before this code existed is subtracted rather than
 *      doubled.
 *   4. Asks `decideRefund` for the amount. That is the only place the window
 *      and the percentage live.
 *   5. Claims a ledger row per payment intent BEFORE calling Stripe. The
 *      unique index on `payment_intent_id` is what makes a double-clicked
 *      button, a retried POST or a second operator lose the race instead of
 *      refunding twice. Stripe's idempotency key is the second belt.
 *   6. Refunds, stamps the row, and tells the client through the branded
 *      templates. The email is best effort and cannot fail the refund: money
 *      that has gone back has gone back whatever the mailer does, and the
 *      `charge.refunded` webhook writes the workspace state either way.
 *
 * The money is drained balance-first. A guarantee refund of half the setup
 * fee is larger than the 20% deposit, so it has to span both milestones to be
 * payable at all; taking it from the 80% balance first means the common case
 * is one refund on one charge, and the deposit is only touched when the
 * balance could not cover it.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { quoteMinorFrom } from '@/lib/flowstarter/quote';
import {
  StripeBilling,
  StripeBillingError,
  type WorkspaceBillingRow,
} from './stripe';
import {
  decideRefund,
  refundGuarantee,
  type RefundGuarantee,
  type RefundVerdict,
} from './refund-policy';
import { notifyRefundIssued } from './refund-email';

type ServiceClient = SupabaseClient<Database>;

export type RefundMilestone = 'deposit' | 'final';

/** One milestone's money, as Stripe currently sees it. */
export interface RefundSource {
  milestone: RefundMilestone;
  paymentIntentId: string;
  remainingMinor: number;
  currency: string;
}

/** One refund about to be made, or already made. */
export interface RefundLeg {
  milestone: RefundMilestone;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
}

export interface RefundInput {
  supabase: ServiceClient;
  billing: StripeBilling;
  workspaceId: string;
  /** The operator's own words. Stored, and the only record of why. */
  reason: string;
  /** Set to go outside the guarantee. Stored separately from `reason`. */
  overrideReason?: string | null;
  /** Major units as an operator types them, e.g. 399.5. Optional. */
  requestedAmountMinor?: number | null;
  /** Clerk user id of whoever pressed the button. */
  requestedBy: string;
  now?: Date;
  guarantee?: RefundGuarantee;
}

export type RefundOutcome =
  | {
      ok: true;
      legs: RefundLeg[];
      totalMinor: number;
      currency: string;
      basis: 'guarantee' | 'override';
      /** True when every leg was already on the ledger: nothing new was sent. */
      duplicate: boolean;
      clientEmailed: boolean;
    }
  | { ok: false; code: string; message: string; status: number };

/**
 * The columns a refund decision is made from.
 *
 * Read in one select rather than through `ensureBillingCustomer`: a refund
 * never needs to create a Stripe customer, and a workspace with no customer
 * has nothing to refund anyway.
 */
const REFUND_COLUMNS =
  'id, client_email, client_name, client_business_name, setup_fee, ' +
  'final_value_minor, monthly_fee, billing_interval, stripe_customer_id, ' +
  'stripe_subscription_id, subscription_status, subscription_trial_ends, ' +
  'deposit_status, deposit_invoice_id, deposit_payment_intent_id, ' +
  'final_status, final_invoice_id, balance_payment_intent_id';

type RefundWorkspaceRow = WorkspaceBillingRow & {
  deposit_payment_intent_id: string | null;
  balance_payment_intent_id: string | null;
};

function fail(
  code: string,
  message: string,
  status: number
): Extract<RefundOutcome, { ok: false }> {
  return { ok: false, code, message, status };
}

/**
 * When the site first went live.
 *
 * The earliest `deployments` row that reached `live`, because that is the
 * moment the guarantee starts running from and it is the only one that does
 * not move. `workspaces.last_deployed_at` is the latest deploy, so using it
 * would hand a client a fresh thirty days every time they asked for a copy
 * change — and `setup_go_live_at` exists as a column and has never been
 * written by anything.
 *
 * Null means the site has not launched, which `decideRefund` turns into a
 * refusal the operator can override, not into a crash.
 */
export async function firstLaunchedAt(
  supabase: ServiceClient,
  workspaceId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('deployments')
    .select('finished_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'live')
    .not('finished_at', 'is', null)
    .order('finished_at', { ascending: true })
    .limit(1);
  if (error) {
    throw new StripeBillingError(
      'db_error',
      `Could not read the deployment history for workspace ${workspaceId}: ${error.message}`,
      error
    );
  }
  return data?.[0]?.finished_at ?? null;
}

/**
 * The payment intent behind one milestone, looked up once and remembered.
 *
 * The deposit path records its intent on the workspace (the guest Checkout
 * does, at least); the balance path never has, because the balance is billed
 * as a hosted invoice and nothing wrote `balance_payment_intent_id`. So a
 * missing column is resolved from the invoice and written back, which turns
 * the second refund attempt on the same workspace into one fewer Stripe call
 * and gives an operator reading the row something to paste into the
 * dashboard.
 *
 * A write-back failure is logged and swallowed: the id is a cache, and
 * refusing a refund because a cache could not be filled would be absurd.
 */
async function resolvePaymentIntent(
  supabase: ServiceClient,
  billing: StripeBilling,
  row: RefundWorkspaceRow,
  milestone: RefundMilestone
): Promise<string | null> {
  const stored =
    milestone === 'deposit'
      ? row.deposit_payment_intent_id
      : row.balance_payment_intent_id;
  if (stored) return stored;

  const invoiceId =
    milestone === 'deposit' ? row.deposit_invoice_id : row.final_invoice_id;
  const resolved = await billing.paymentIntentForInvoice(invoiceId);
  if (!resolved) return null;

  const column =
    milestone === 'deposit'
      ? 'deposit_payment_intent_id'
      : 'balance_payment_intent_id';
  const { error } = await supabase
    .from('workspaces')
    .update({ [column]: resolved })
    .eq('id', row.id);
  if (error) {
    console.warn(
      `[refund] resolved ${column}=${resolved} for workspace ${row.id} but ` +
        `could not store it: ${error.message}`
    );
  }
  return resolved;
}

/**
 * What is refundable, per milestone, balance first.
 *
 * Milestones with nothing left are dropped rather than returned as zeroes, so
 * the planner below never has to think about them and a workspace where every
 * charge has already been refunded produces an empty list, which
 * `decideRefund` reads as `nothing_refundable`.
 */
export async function refundSources(
  supabase: ServiceClient,
  billing: StripeBilling,
  row: RefundWorkspaceRow
): Promise<RefundSource[]> {
  const sources: RefundSource[] = [];
  for (const milestone of ['final', 'deposit'] as const) {
    const paymentIntentId = await resolvePaymentIntent(
      supabase,
      billing,
      row,
      milestone
    );
    if (!paymentIntentId) continue;
    const { remainingMinor, currency } = await billing.refundableMinor(
      paymentIntentId
    );
    if (remainingMinor <= 0) continue;
    sources.push({ milestone, paymentIntentId, remainingMinor, currency });
  }
  return sources;
}

/**
 * Split one amount across the milestones that can pay it.
 *
 * Pure, and exported so a test can pin the split without a Stripe client.
 * Balance first, because a guaranteed half of the setup fee is more than the
 * 20% deposit and would otherwise not be payable in one action at all.
 */
export function planRefundLegs(
  sources: readonly RefundSource[],
  amountMinor: number
): RefundLeg[] {
  const legs: RefundLeg[] = [];
  let left = amountMinor;
  for (const source of sources) {
    if (left <= 0) break;
    const take = Math.min(left, source.remainingMinor);
    if (take <= 0) continue;
    legs.push({
      milestone: source.milestone,
      paymentIntentId: source.paymentIntentId,
      amountMinor: take,
      currency: source.currency,
    });
    left -= take;
  }
  return legs;
}

/** Postgres unique-violation: another request claimed this intent first. */
const UNIQUE_VIOLATION = '23505';

/**
 * Refund the setup fee, as far as the rules and the money allow.
 *
 * Returns a result rather than throwing for anything an operator can act on,
 * so the two routes can map a code to a status and print the message. It
 * throws only for a database or Stripe failure the operator cannot fix by
 * typing something different, which is what `mapBillingError` is for.
 */
export async function refundSetupFee(
  input: RefundInput
): Promise<RefundOutcome> {
  const { supabase, billing, workspaceId } = input;
  const now = input.now ?? new Date();
  const guarantee = input.guarantee ?? refundGuarantee();

  const { data, error } = await supabase
    .from('workspaces')
    .select(REFUND_COLUMNS)
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) {
    throw new StripeBillingError('db_error', error.message, error);
  }
  if (!data) {
    return fail(
      'workspace_not_found',
      `Workspace ${workspaceId} not found`,
      404
    );
  }
  const row = data as unknown as RefundWorkspaceRow;

  const sources = await refundSources(supabase, billing, row);
  const remainingRefundableMinor = sources.reduce(
    (total, source) => total + source.remainingMinor,
    0
  );

  const launchedAt = await firstLaunchedAt(supabase, workspaceId);

  const verdict: RefundVerdict = decideRefund(
    {
      quoteMinor: quoteMinorFrom(row),
      remainingRefundableMinor,
      launchedAt,
      now,
      reason: input.reason,
      overrideReason: input.overrideReason ?? null,
      requestedAmountMinor: input.requestedAmountMinor ?? null,
    },
    guarantee
  );
  if (!verdict.allowed) {
    return fail(verdict.code, verdict.message, 409);
  }

  const legs = planRefundLegs(sources, verdict.amountMinor);
  if (legs.length === 0) {
    return fail(
      'nothing_refundable',
      'There is no settled payment left to refund on this workspace.',
      409
    );
  }

  const currency = legs[0]?.currency ?? billing.currency;
  const issued: RefundLeg[] = [];
  let claimedAny = false;

  for (const leg of legs) {
    const claim = await supabase
      .from('billing_refunds')
      .insert({
        workspace_id: workspaceId,
        milestone: leg.milestone,
        payment_intent_id: leg.paymentIntentId,
        amount_minor: leg.amountMinor,
        currency: leg.currency,
        reason: input.reason.trim(),
        override_reason: input.overrideReason?.trim() || null,
        basis: verdict.basis,
        requested_by: input.requestedBy,
        status: 'pending',
      })
      .select('id')
      .maybeSingle();

    if (claim.error) {
      if (claim.error.code === UNIQUE_VIOLATION) {
        // Somebody already refunded this payment intent: a double click, a
        // retried POST, a second operator, or a refund made earlier today.
        // One refund per intent, so this leg is simply already done.
        console.info(
          `[refund] payment intent ${leg.paymentIntentId} already has a ` +
            `refund on the ledger for workspace ${workspaceId}; skipping`
        );
        continue;
      }
      throw new StripeBillingError(
        'db_error',
        `Could not claim the refund ledger row for ${leg.paymentIntentId}: ${claim.error.message}`,
        claim.error
      );
    }
    claimedAny = true;
    const ledgerId = claim.data?.id as string | undefined;

    try {
      const refund = await billing.refundPaymentIntent({
        paymentIntentId: leg.paymentIntentId,
        amountMinor: leg.amountMinor,
        // Keyed on the intent, not on the request: two requests for the same
        // money are the same refund as far as Stripe is concerned.
        idempotencyKey: `flowstarter-refund:${leg.paymentIntentId}`,
        metadata: {
          workspaceId,
          milestone: leg.milestone,
          basis: verdict.basis,
        },
      });
      if (ledgerId) {
        const stamped = await supabase
          .from('billing_refunds')
          .update({
            stripe_refund_id: refund.refundId,
            status: 'succeeded',
            amount_minor: refund.amountMinor,
            currency: refund.currency,
            updated_at: new Date().toISOString(),
          })
          .eq('id', ledgerId);
        if (stamped.error) {
          // The money has gone back. Losing the stamp is bad and is not worth
          // failing the request over: the row stays `pending`, the
          // charge.refunded webhook still writes the workspace state, and an
          // operator reading a pending row with a Stripe refund id knows
          // exactly what happened.
          console.error(
            `[refund] Stripe refunded ${refund.refundId} but the ledger row ` +
              `${ledgerId} could not be stamped: ${stamped.error.message}`
          );
        }
      }
      issued.push({ ...leg, amountMinor: refund.amountMinor });
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Stripe refused the refund';
      if (ledgerId) {
        await supabase
          .from('billing_refunds')
          .update({
            status: 'failed',
            failure_reason: message.slice(0, 500),
            updated_at: new Date().toISOString(),
          })
          .eq('id', ledgerId);
      }
      throw e;
    }
  }

  if (!claimedAny) {
    return {
      ok: true,
      legs: [],
      totalMinor: 0,
      currency,
      basis: verdict.basis,
      duplicate: true,
      clientEmailed: false,
    };
  }

  const totalMinor = issued.reduce((sum, leg) => sum + leg.amountMinor, 0);

  // After the money, never before, and never able to fail it.
  const clientEmailed = await notifyRefundIssued({
    supabase,
    workspaceId,
    amountMinor: totalMinor,
    currency,
    basis: verdict.basis,
    // One notice per set of intents, so a retry that refunds a second
    // milestone is a second email and a redelivery of the same one is not.
    dedupeKey: issued.map((leg) => leg.paymentIntentId).join(','),
  });

  return {
    ok: true,
    legs: issued,
    totalMinor,
    currency,
    basis: verdict.basis,
    duplicate: false,
    clientEmailed,
  };
}
