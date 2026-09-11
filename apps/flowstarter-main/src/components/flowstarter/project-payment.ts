/**
 * When the client owes us money, and how much.
 *
 * None of the arithmetic lives here. The quote comes from
 * `lib/flowstarter/quote.ts` and the 20/80 split from the state machine's
 * `depositAmountMinor`/`balanceAmountMinor`, which is the same pair the deposit
 * Checkout endpoint and the unlock page use. This file only decides which of
 * the two calls to *offer*, and it mirrors the server rules so the page can
 * never show a payment the API would refuse.
 */
import {
  balanceAmountMinor,
  depositAmountMinor,
} from '@flowstarter/agentic-codegen/src/flowstarter/state-machine';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { quoteMinorFrom, type QuoteBearingRow } from '@/lib/flowstarter/quote';
import type { ClientBuildSignal } from './project-build-signal';
import { projectStateFrom } from './project-progress';

export interface PaymentBearingRow extends QuoteBearingRow {
  project_state?: string | null;
  deposit_status?: string | null;
  final_status?: string | null;
  final_invoice_url?: string | null;
  billing_currency?: string | null;
}

export interface PaymentDue {
  kind: 'deposit' | 'balance';
  amountMinor: number;
  currency: string;
  /** Where the CTA sends the client. Never a checkout we implement ourselves. */
  href: string;
  label: string;
  explainer: string;
}

export interface ProjectPayments {
  quoteMinor: number;
  depositMinor: number;
  balanceMinor: number;
  currency: string;
  depositPaid: boolean;
  balancePaid: boolean;
  /** The one call to action to show, or null when nothing is owed today. */
  due: PaymentDue | null;
}

/**
 * The deposit is payable in exactly the window
 * `/api/flowstarter/projects/[id]/deposit-checkout` accepts: the project is
 * PREVIEW_READY, a quote exists, and the deposit is not already paid.
 */
export function depositDue(row: PaymentBearingRow): boolean {
  return (
    projectStateFrom(row.project_state) === ProjectState.PREVIEW_READY &&
    quoteMinorFrom(row) > 0 &&
    row.deposit_status !== 'paid'
  );
}

/**
 * The balance is due at HUMAN_QA and not before.
 *
 * This follows `productionActivationAllowed` in
 * `lib/flowstarter/deposit-workflow.ts`, which is the only place the balance
 * gate is expressed: a site may only be activated when
 * `projectState === HUMAN_QA && finalStatus === 'paid'` (plus a live
 * subscription). So the balance is outstanding exactly when the project has
 * reached HUMAN_QA and `final_status` is not yet 'paid'. Asking earlier would
 * be asking for money before a human has seen the build.
 */
export function balanceDue(row: PaymentBearingRow): boolean {
  return (
    projectStateFrom(row.project_state) === ProjectState.HUMAN_QA &&
    row.final_status !== 'paid' &&
    quoteMinorFrom(row) > 0
  );
}

export function formatMinor(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: (currency || 'eur').toUpperCase(),
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

export function projectPayments(
  row: PaymentBearingRow,
  workspaceId: string
): ProjectPayments {
  const currency = row.billing_currency ?? 'eur';
  const quoteMinor = quoteMinorFrom(row);
  const depositMinor = quoteMinor > 0 ? depositAmountMinor(quoteMinor) : 0;
  const balanceMinor = quoteMinor > 0 ? balanceAmountMinor(quoteMinor) : 0;

  let due: PaymentDue | null = null;
  if (depositDue(row)) {
    due = {
      kind: 'deposit',
      amountMinor: depositMinor,
      currency,
      // The existing unlock page owns the quote breakdown and the Checkout
      // button. Linking to it keeps one payment path, not two.
      href: `/unlock/${workspaceId}`,
      label: `Pay your ${formatMinor(depositMinor, currency)} deposit`,
      explainer:
        'The deposit is 20% of your quote and starts the full build. The balance is only due once the finished site has been checked.',
    };
  } else if (balanceDue(row)) {
    due = {
      kind: 'balance',
      amountMinor: balanceMinor,
      currency,
      // The final invoice is raised by the team through Stripe; we send the
      // client to the invoice we already stored, or to their billing page.
      href: row.final_invoice_url ?? '/account/billing',
      label: `Pay your ${formatMinor(balanceMinor, currency)} balance`,
      explainer:
        'Your site has passed our final check. Settling the balance publishes it.',
    };
  }

  return {
    quoteMinor,
    depositMinor,
    balanceMinor,
    currency,
    depositPaid: row.deposit_status === 'paid',
    balancePaid: row.final_status === 'paid',
    due,
  };
}

export interface PaymentPositionLine {
  key: 'deposit' | 'balance';
  label: string;
  amountMinor: number;
  status: 'paid' | 'due' | 'upcoming';
  note: string;
}

/**
 * The client's money position, stated even when nothing is owed. A client
 * mid-build deserves to see "deposit paid, balance falls due after final
 * checks" rather than a page that only mentions money when it wants some.
 * Pure projection of ProjectPayments; the due/not-due decisions above stay
 * the only authority.
 *
 * `signal` never changes what is owed or which call to action is offered. The
 * balance gate is `balanceDue` and nothing else, which is the rule the server
 * enforces and the only one worth having. What it changes is what the lines
 * are allowed to promise. On 2026-09-12 a client whose build had failed was
 * shown "Paid. Your site is cleared to go live." next to a site that was
 * never going to go live off that build, which is the money half of the same
 * lie the stepper was telling.
 */
export function paymentPosition(
  payments: ProjectPayments,
  signal?: ClientBuildSignal | null
): PaymentPositionLine[] {
  if (payments.quoteMinor <= 0) return [];
  const stopped = Boolean(signal);
  return [
    {
      key: 'deposit',
      label: 'Deposit (20%)',
      amountMinor: payments.depositMinor,
      status: payments.depositPaid
        ? 'paid'
        : payments.due?.kind === 'deposit'
        ? 'due'
        : 'upcoming',
      note: payments.depositPaid
        ? 'Paid. This is what started your build.'
        : payments.due?.kind === 'deposit'
        ? 'Due now. Paying it starts the full build.'
        : 'Becomes payable once your preview is ready.',
    },
    {
      key: 'balance',
      label: 'Balance (80%)',
      amountMinor: payments.balanceMinor,
      status: payments.balancePaid
        ? 'paid'
        : payments.due?.kind === 'balance'
        ? 'due'
        : 'upcoming',
      note: payments.balancePaid
        ? stopped
          ? 'Paid. Your site is not live yet because your build needs a ' +
            'second look, and a person is on it.'
          : 'Paid. Your site is cleared to go live.'
        : payments.due?.kind === 'balance'
        ? 'Due now. A person has checked every page of the finished site.'
        : stopped
        ? 'Not due yet. Your build needs a second look first, and a person ' +
          'is on it.'
        : 'Falls due only after we have checked the finished site.',
    },
  ];
}
