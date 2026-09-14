/**
 * Telling a client their money has gone back.
 *
 * Same shape as `balance-invoice-email.ts` and for the same reasons: the send
 * runs through `notifyClientOnce`, so it cannot throw into the refund path and
 * cannot send twice if the operator's request is retried. A refund that
 * succeeded on Stripe must not be reported as a failure because a mailer was
 * unreachable, and a client must not be told twice that they have been
 * refunded once.
 *
 * `dedupeKey` is the set of payment intents the refund touched. A second
 * refund on a workspace, for a milestone the first one did not reach, is
 * genuinely a second thing that happened and gets its own email; a redelivery
 * or a re-press that refunds the same intents gets nothing.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { refundIssuedEmail } from '@/lib/email-templates/client-notices';
import { notifyClientOnce } from '@/lib/flowstarter/client-notifications';
import { formatInvoiceAmount } from './balance-invoice-email';

export async function notifyRefundIssued(input: {
  supabase?: SupabaseClient<Database>;
  workspaceId: string;
  amountMinor: number;
  currency: string;
  basis: 'guarantee' | 'override';
  dedupeKey: string;
}): Promise<boolean> {
  const amount = formatInvoiceAmount(input.amountMinor, input.currency);
  const result = await notifyClientOnce({
    ...(input.supabase ? { supabase: input.supabase } : {}),
    workspaceId: input.workspaceId,
    notification: 'refund_issued',
    dedupeKey: input.dedupeKey,
    detail: {
      amountMinor: input.amountMinor,
      currency: input.currency,
      basis: input.basis,
    },
    render: (client) =>
      refundIssuedEmail({
        amount,
        dashboardUrl: client.dashboardUrl,
        clientName: client.clientName,
        businessName: client.businessName,
      }),
  });
  return result.sent;
}
