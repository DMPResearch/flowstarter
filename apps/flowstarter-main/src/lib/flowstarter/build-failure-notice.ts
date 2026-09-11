/**
 * Telling a client their build stopped.
 *
 * On 2026-09-12 a client paid EUR 799 in full, their build was failed by a
 * gate fourteen minutes later, and the product told them nothing. It had five
 * client notices and none of them covered "your build stopped", so the only
 * thing they could read was a dashboard saying the build was about to start.
 *
 * The dedupe key is the job id rather than the workspace: a build that stops,
 * is re-dispatched, and stops again is two separate pieces of news, and a
 * client who has already been written to about job A should hear about job B.
 * `notifyClientOnce` writes its marker only after a send that succeeded, so a
 * mailer that was down when the build failed still delivers this on the next
 * call rather than silently consuming it.
 *
 * Never throws, by `notifyClientOnce`'s contract, so a caller rendering a page
 * or handling a callback can await it without a guard.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { buildNeedsReviewEmail } from '@/lib/email-templates/client-notices';
import {
  notifyClientOnce,
  type ClientNotifyResult,
} from './client-notifications';

export async function notifyClientBuildNeedsReview(input: {
  supabase?: SupabaseClient<Database>;
  workspaceId: string;
  /** The FULL_SITE_BUILD job that stopped. One notice per id, ever. */
  jobId: string;
  /** `flowstarter_agent_jobs.error_code`, for the operator reading the ledger. */
  errorCode?: string | null;
}): Promise<ClientNotifyResult> {
  return notifyClientOnce({
    ...(input.supabase ? { supabase: input.supabase } : {}),
    workspaceId: input.workspaceId,
    notification: 'build_failed',
    dedupeKey: input.jobId,
    detail: {
      jobId: input.jobId,
      errorCode: input.errorCode ?? null,
    },
    render: (recipient) =>
      buildNeedsReviewEmail({
        dashboardUrl: recipient.dashboardUrl,
        clientName: recipient.clientName,
        businessName: recipient.businessName,
      }),
  });
}
