'use client';

import { useState } from 'react';
import { quoteMajorFrom, type QuoteBearingRow } from '@/lib/flowstarter/quote';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Send,
  CheckCircle2,
  Clock,
  AlertCircle,
  ExternalLink,
  Receipt,
  RefreshCcw,
  Ban,
  PlayCircle,
  Undo2,
} from 'lucide-react';
import { ShellCard } from '../../../components/TeamDashboardShell';
import { Button } from '@/components/ui/button';
import type { Project } from './form-helpers';
import { formatDate } from '@/lib/format-utils';
import { MIN_REASON_CHARS, refundGuarantee } from '@/lib/billing/refund-policy';

type InvoiceState = 'pending' | 'sent' | 'paid' | 'overdue' | null | string;
type SubscriptionState =
  | 'trial'
  | 'active'
  | 'past_due'
  | 'cancelled'
  | 'incomplete'
  | string
  | null;

/**
 * One chip recipe across the console: a hairline border, a 10% tint and a
 * readable text tone in both themes. Matches the pipeline board's chips.
 */
const NEUTRAL_TONE =
  'border-[var(--fs-rule)] bg-transparent text-[var(--fs-ink-dim)]';

const INVOICE_TONE: Record<string, string> = {
  paid: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  sent: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  pending: NEUTRAL_TONE,
  overdue: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
};

const SUBSCRIPTION_TONE: Record<string, string> = {
  trial: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  active:
    'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  past_due: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
  cancelled: NEUTRAL_TONE,
  incomplete:
    'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
};

function StatusPill({
  status,
  tone,
}: {
  status: string;
  tone: Record<string, string>;
}) {
  // The old fallback had no dark variant, so an unmapped status rendered as
  // dark slate text on a light slate chip in dark mode.
  const cls = tone[status] ?? NEUTRAL_TONE;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase leading-5 tracking-wide ${cls}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/**
 * Displays a milestone's share of the setup fee exactly as the invoice route
 * charges it: `resolveAmountMinor` computes `round(setupFee × percent)` minor
 * units, so €799 splits into €159.80 / €639.20 — not round euros.
 */
function formatSetupSplit(setupFeeMajor: number, percent: number): string {
  const major = Math.round(setupFeeMajor * percent) / 100;
  return major.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function BillingTab({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  // Reads the same quote the deposit Checkout and the webhook use, so the
  // split shown here cannot disagree with what the client is charged.
  const setupFee = quoteMajorFrom(project as QuoteBearingRow);
  const monthlyFee = (project.monthly_fee as number | null) ?? 0;
  const depositStatus = (project.deposit_status as InvoiceState) ?? 'pending';
  const finalStatus = (project.final_status as InvoiceState) ?? 'pending';
  const subscriptionStatus =
    (project.subscription_status as SubscriptionState) ?? null;
  const stripeSubscriptionId = project.stripe_subscription_id as string | null;
  const stripeCustomerId = project.stripe_customer_id as string | null;
  const depositInvoiceUrl = project.deposit_invoice_url as string | null;
  const finalInvoiceUrl = project.final_invoice_url as string | null;
  const subscriptionTrialEnds = project.subscription_trial_ends as
    | string
    | null;
  const subscriptionNextBilling = project.subscription_next_billing as
    | string
    | null;

  const callBilling = useMutation({
    mutationFn: async (vars: {
      action:
        | 'deposit-invoice'
        | 'final-invoice'
        | 'activate-subscription'
        | 'cancel-subscription';
      query?: string;
    }) => {
      setBusy(vars.action);
      const res = await fetch(
        `/api/admin/projects/${project.id}/billing/${vars.action}${
          vars.query ?? ''
        }`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Billing call failed');
      }
      return res.json();
    },
    onSettled: () => setBusy(null),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['team-project', project.id] });
      qc.invalidateQueries({ queryKey: ['team-projects'] });
      if (vars.action === 'deposit-invoice')
        toast.success('Deposit invoice sent');
      else if (vars.action === 'final-invoice')
        toast.success('Final invoice sent');
      else if (vars.action === 'activate-subscription')
        toast.success('Subscription activated');
      else if (vars.action === 'cancel-subscription')
        toast.success('Subscription cancelled');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  const canSendDeposit =
    !!project.client_email && setupFee > 0 && depositStatus !== 'paid';
  const canSendFinal =
    !!project.client_email &&
    setupFee > 0 &&
    depositStatus === 'paid' &&
    finalStatus !== 'paid';
  const canActivateSubscription =
    !!project.client_email &&
    monthlyFee > 0 &&
    !stripeSubscriptionId &&
    finalStatus === 'paid';
  const canCancelSubscription =
    !!stripeSubscriptionId && subscriptionStatus !== 'cancelled';

  return (
    <div className="space-y-4">
      {!project.client_email && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertCircle className="inline-block w-4 h-4 mr-1 -mt-0.5" />
          Set <strong>Client email</strong> on the Overview tab before
          generating invoices. Stripe needs it to create a Customer.
        </div>
      )}

      {/* Setup fee — two invoices */}
      <ShellCard>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fs-ink)]">
              Setup fee
            </h3>
            <p className="text-xs text-[var(--fs-ink-faint)]">
              Two invoices: 20% deposit upfront + 80% on approval.
            </p>
          </div>
          <p className="text-sm font-bold text-[var(--fs-ink)]">
            €{setupFee.toLocaleString()}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Deposit */}
          <div className="rounded-lg border border-[var(--fs-rule)] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-[var(--fs-ink-dim)]">
                Deposit (20%)
              </span>
              <StatusPill status={depositStatus} tone={INVOICE_TONE} />
            </div>
            <p className="text-lg font-semibold text-[var(--fs-ink)]">
              €{formatSetupSplit(setupFee, 20)}
            </p>
            {depositInvoiceUrl && (
              <a
                href={depositInvoiceUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[0.65rem] text-[var(--purple)] hover:underline"
              >
                Hosted invoice <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {depositStatus === 'paid' && project.deposit_paid_at && (
              <p className="mt-1 text-[0.65rem] text-[var(--fs-ink-faint)]">
                Paid {formatDate(project.deposit_paid_at as string)}
              </p>
            )}
            <div className="mt-3">
              <Button
                size="sm"
                disabled={!canSendDeposit || busy !== null}
                onClick={() =>
                  callBilling.mutate({ action: 'deposit-invoice' })
                }
              >
                <Send className="w-3.5 h-3.5" />
                {busy === 'deposit-invoice'
                  ? 'Sending…'
                  : depositStatus === 'sent'
                  ? 'Resend deposit'
                  : 'Send deposit'}
              </Button>
            </div>
          </div>

          {/* Final */}
          <div className="rounded-lg border border-[var(--fs-rule)] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-[var(--fs-ink-dim)]">
                Final (80%)
              </span>
              <StatusPill status={finalStatus} tone={INVOICE_TONE} />
            </div>
            <p className="text-lg font-semibold text-[var(--fs-ink)]">
              €{formatSetupSplit(setupFee, 80)}
            </p>
            {finalInvoiceUrl && (
              <a
                href={finalInvoiceUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[0.65rem] text-[var(--purple)] hover:underline"
              >
                Hosted invoice <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {finalStatus === 'paid' && project.final_paid_at && (
              <p className="mt-1 text-[0.65rem] text-[var(--fs-ink-faint)]">
                Paid {formatDate(project.final_paid_at as string)}
              </p>
            )}
            <div className="mt-3">
              <Button
                size="sm"
                disabled={!canSendFinal || busy !== null}
                onClick={() => callBilling.mutate({ action: 'final-invoice' })}
              >
                <Send className="w-3.5 h-3.5" />
                {busy === 'final-invoice'
                  ? 'Sending…'
                  : finalStatus === 'sent'
                  ? 'Resend final'
                  : 'Send final'}
              </Button>
            </div>
          </div>
        </div>
      </ShellCard>

      {/* Subscription */}
      <ShellCard>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fs-ink)]">
              Subscription
            </h3>
            <p className="text-xs text-[var(--fs-ink-faint)]">
              Recurring monthly fee with 30-day trial (first month free).
            </p>
          </div>
          {subscriptionStatus && (
            <StatusPill status={subscriptionStatus} tone={SUBSCRIPTION_TONE} />
          )}
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Monthly amount
            </dt>
            <dd className="font-semibold text-[var(--fs-ink)]">
              €{monthlyFee.toLocaleString()}/mo
            </dd>
          </div>
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Trial ends
            </dt>
            <dd className="text-[var(--fs-ink-dim)]">
              {formatDate(subscriptionTrialEnds) || '–'}
            </dd>
          </div>
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Next billing
            </dt>
            <dd className="text-[var(--fs-ink-dim)]">
              {formatDate(subscriptionNextBilling) || '–'}
            </dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-2 pt-3 border-t border-[var(--fs-rule)]">
          <Button
            size="sm"
            disabled={!canActivateSubscription || busy !== null}
            onClick={() => {
              if (!canActivateSubscription) return;
              callBilling.mutate({ action: 'activate-subscription' });
            }}
          >
            <PlayCircle className="w-3.5 h-3.5" />
            {busy === 'activate-subscription'
              ? 'Activating…'
              : 'Activate subscription'}
          </Button>

          {!canActivateSubscription && !stripeSubscriptionId && (
            <p className="text-[0.65rem] text-[var(--fs-ink-faint)]">
              Available once both invoices are paid (or pass force=true via
              API).
            </p>
          )}

          {canCancelSubscription && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  if (
                    !confirm(
                      'Cancel at period end? Client keeps service through what they already paid for.'
                    )
                  )
                    return;
                  callBilling.mutate({ action: 'cancel-subscription' });
                }}
              >
                <Clock className="w-3.5 h-3.5" />
                Cancel at period end
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  if (
                    !confirm(
                      'Cancel IMMEDIATELY? Service stops now. This does not refund the unused part of the paid period; use Refund setup fee below if money should go back.'
                    )
                  )
                    return;
                  callBilling.mutate({
                    action: 'cancel-subscription',
                    query: '?immediate=true',
                  });
                }}
              >
                <Ban className="w-3.5 h-3.5" />
                Cancel now
              </Button>
            </>
          )}
        </div>
      </ShellCard>

      {/* Refund — the published guarantee, issuable from here */}
      <RefundCard projectId={project.id as string} setupFee={setupFee} />

      {/* Stripe references */}
      <ShellCard>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--fs-ink)] flex items-center gap-2">
            <Receipt className="w-4 h-4" /> Stripe references
          </h3>
          {stripeCustomerId && (
            <Button
              size="sm"
              disabled={busy === 'portal-link'}
              onClick={async () => {
                setBusy('portal-link');
                try {
                  const res = await fetch(
                    `/api/admin/projects/${project.id}/billing/portal-link`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({}),
                    }
                  );
                  const data = await res.json();
                  if (!res.ok || !data.url) {
                    toast.error(data.error || 'Failed to create portal link');
                    return;
                  }
                  await navigator.clipboard.writeText(data.url);
                  toast.success(
                    'Portal link copied, paste into the client email'
                  );
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : 'Portal link failed'
                  );
                } finally {
                  setBusy(null);
                }
              }}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {busy === 'portal-link'
                ? 'Generating…'
                : 'Copy Stripe portal link'}
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Customer ID
            </dt>
            <dd className="font-mono text-[var(--fs-ink-dim)]">
              {stripeCustomerId ?? '–'}
            </dd>
          </div>
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Subscription ID
            </dt>
            <dd className="font-mono text-[var(--fs-ink-dim)]">
              {stripeSubscriptionId ?? '–'}
            </dd>
          </div>
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Deposit invoice
            </dt>
            <dd className="font-mono text-[var(--fs-ink-dim)] truncate">
              {(project.deposit_invoice_id as string | null) ?? '–'}
            </dd>
          </div>
          <div>
            <dt className="text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Final invoice
            </dt>
            <dd className="font-mono text-[var(--fs-ink-dim)] truncate">
              {(project.final_invoice_id as string | null) ?? '–'}
            </dd>
          </div>
        </dl>
        {stripeCustomerId && (
          <p className="mt-3 text-[0.65rem] text-[var(--fs-ink-faint)]">
            <CheckCircle2 className="inline-block w-3 h-3 mr-1" /> Open the
            client&apos;s billing page in Stripe dashboard for payment-method
            updates and invoice voiding. Refunds belong above, not there: one
            issued here is recorded, emailed to the client, and readable
            afterwards.
          </p>
        )}
      </ShellCard>
    </div>
  );
}

/**
 * "Refund setup fee".
 *
 * The guarantee has been published on the terms page and the landing hero
 * since launch and there was no way to honour it from this console. An
 * operator had to open Stripe, find the charge, type an amount, and leave no
 * record anywhere this product could read.
 *
 * The form is deliberately two fields and a disclosure. The reason is
 * required because it is the only record of why money went back; the amount
 * and the override reason are behind a toggle because the common case is the
 * published guarantee and a form that leads with "how much?" invites an
 * operator to answer it. Leaving both blank refunds exactly the guaranteed
 * percentage, and only inside the window.
 *
 * Nothing here decides anything. The window, the percentage and whether this
 * particular refund is allowed are all settled server-side by
 * `decideRefund`; the numbers below are read from the same config purely so
 * the operator can see what they are about to send. A refusal comes back as
 * a message and is shown as it was written.
 */
function RefundCard({
  projectId,
  setupFee,
}: {
  projectId: string;
  setupFee: number;
}) {
  const qc = useQueryClient();
  const guarantee = refundGuarantee();
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [amount, setAmount] = useState('');

  const guaranteedMajor =
    Math.round(setupFee * guarantee.percentOfSetupFee) / 100;

  const refund = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/admin/projects/${projectId}/billing/refund`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason,
            ...(override && overrideReason ? { overrideReason } : {}),
            ...(override && amount ? { amount } : {}),
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Refund failed');
      return data as {
        refund: { totalMinor: number; duplicate: boolean; basis: string };
      };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['team-project', projectId] });
      qc.invalidateQueries({ queryKey: ['team-projects'] });
      if (data.refund.duplicate) {
        toast.success('Already refunded. Nothing was sent a second time.');
      } else {
        toast.success(
          `Refunded €${(data.refund.totalMinor / 100).toFixed(2)} (${
            data.refund.basis
          })`
        );
      }
      setReason('');
      setOverrideReason('');
      setAmount('');
      setOverride(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  const reasonLongEnough = reason.trim().length >= MIN_REASON_CHARS;
  const overrideReady =
    !override || overrideReason.trim().length >= MIN_REASON_CHARS;

  return (
    <ShellCard>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--fs-ink)] flex items-center gap-2">
            <Undo2 className="w-4 h-4" /> Refund setup fee
          </h3>
          <p className="text-xs text-[var(--fs-ink-faint)]">
            The published guarantee: {guarantee.percentOfSetupFee}% of the setup
            fee, within {guarantee.windowDays} days of launch, no questions
            asked.
          </p>
        </div>
        {setupFee > 0 && (
          <p className="text-sm font-bold text-[var(--fs-ink)]">
            €{guaranteedMajor.toLocaleString()}
          </p>
        )}
      </div>

      <label
        htmlFor="refund-reason"
        className="block text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)] mb-1"
      >
        Reason (stored with the refund)
      </label>
      <textarea
        id="refund-reason"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this money going back?"
        className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent p-2 text-sm text-[var(--fs-ink)]"
      />

      <label className="mt-3 flex items-center gap-2 text-xs text-[var(--fs-ink-dim)]">
        <input
          type="checkbox"
          checked={override}
          onChange={(e) => setOverride(e.target.checked)}
        />
        Refund outside the guarantee (different amount, before launch, or after
        the window)
      </label>

      {override && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="refund-amount"
              className="block text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)] mb-1"
            >
              Amount in euros (blank = everything still refundable)
            </label>
            <input
              id="refund-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent p-2 text-sm text-[var(--fs-ink)]"
            />
          </div>
          <div>
            <label
              htmlFor="refund-override-reason"
              className="block text-[0.65rem] uppercase tracking-wide text-[var(--fs-ink-faint)] mb-1"
            >
              Why outside the guarantee
            </label>
            <input
              id="refund-override-reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent p-2 text-sm text-[var(--fs-ink)]"
            />
          </div>
        </div>
      )}

      <div className="mt-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!reasonLongEnough || !overrideReady || refund.isPending}
          onClick={() => {
            if (
              !confirm(
                'Send this refund? The money goes back to the client and they ' +
                  'get an email about it. One refund per charge, so this ' +
                  'cannot be undone from here.'
              )
            )
              return;
            refund.mutate();
          }}
        >
          <Undo2 className="w-3.5 h-3.5" />
          {refund.isPending ? 'Refunding…' : 'Refund setup fee'}
        </Button>
      </div>

      <p className="mt-3 text-[0.65rem] text-[var(--fs-ink-faint)]">
        One refund per Stripe charge. Pressing this twice, or two operators
        pressing it at once, sends the money once.
      </p>
    </ShellCard>
  );
}
