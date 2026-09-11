/**
 * Our own "your balance invoice is ready", sent alongside Stripe's.
 *
 * `createConciergeInvoice` now calls `invoices.sendInvoice`, so Stripe will
 * deliver the hosted invoice too. That is the right thing to do and it is not
 * enough on its own: Stripe only mails invoices when the account is configured
 * to, and in test mode it never mails the customer's address at all. An
 * operator pressing "send final invoice" should not have to know which of
 * those is true today in order to know whether the client heard about it.
 *
 * So this is the reliable half. Same hosted link, our template, our mailer,
 * recorded once per invoice id so a re-press that Stripe rejects as a
 * duplicate does not produce a second email either.
 */
import { balanceInvoiceEmail } from '@/lib/email-templates/client-notices';
import { notifyClientOnce } from '@/lib/flowstarter/client-notifications';

/**
 * `Intl` rather than a hand-rolled `€${n / 100}`: the amount appears in the
 * body of an email about money, where "639.2" is a support ticket.
 */
export function formatInvoiceAmount(
  amountMinor: number,
  currency: string
): string {
  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export async function notifyBalanceInvoiceReady(input: {
  workspaceId: string;
  invoiceId: string;
  hostedUrl: string | null;
  amountMinor: number;
  currency: string;
  daysUntilDue?: number;
  stripeEmailed?: boolean;
}): Promise<boolean> {
  // Without a hosted URL the email would be a promise with nothing behind it.
  // The invoice still exists and the operator still gets a 200; the client is
  // simply told by the dashboard instead.
  if (!input.hostedUrl) {
    console.warn(
      `[billing] invoice ${input.invoiceId} has no hosted URL, so no balance ` +
        `email was sent for workspace ${input.workspaceId}`
    );
    return false;
  }

  const amount = formatInvoiceAmount(input.amountMinor, input.currency);
  const result = await notifyClientOnce({
    workspaceId: input.workspaceId,
    notification: 'balance_invoice',
    dedupeKey: input.invoiceId,
    detail: {
      invoiceId: input.invoiceId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      stripeEmailed: input.stripeEmailed ?? false,
    },
    render: (client) =>
      balanceInvoiceEmail({
        hostedInvoiceUrl: input.hostedUrl as string,
        amount,
        dashboardUrl: client.dashboardUrl,
        clientName: client.clientName,
        ...(typeof input.daysUntilDue === 'number'
          ? { dueInDays: input.daysUntilDue }
          : {}),
      }),
  });
  return result.sent;
}
