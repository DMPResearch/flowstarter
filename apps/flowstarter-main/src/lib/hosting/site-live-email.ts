/**
 * "Your site is live", sent the moment a deploy actually succeeds.
 *
 * `deploySite` is the only place in the app where `workspaces.deploy_status`
 * becomes `live`, and every route that publishes anything goes through it: the
 * build worker's callback, the operator's deploy button, and the client's own
 * publish (by way of a rebuild that ends at the worker callback). Hooking the
 * email there instead of at any one of those call sites is what makes the
 * promise "you will hear when it is live" true for all of them at once.
 *
 * Keyed on the deploy version rather than the workspace, because the sentence
 * is true again every time: a client who publishes an edit has genuinely put a
 * new site live and should be told, while a webhook or a job retried against
 * the same version should not send a second copy of the same mail.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { siteLiveEmail } from '@/lib/email-templates/client-notices';
import { notifyClientOnce } from '@/lib/flowstarter/client-notifications';
import { deployedSiteUrl, type EnvLike } from './site-urls';

export async function notifySiteLive(input: {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  /** `deployments.version`, the idempotency key for this notice. */
  version: number;
  slug: string;
  primaryDomain?: string | null;
  deploymentId?: string;
  env?: EnvLike;
}): Promise<boolean> {
  const siteUrl = deployedSiteUrl({
    slug: input.slug,
    primaryDomain: input.primaryDomain ?? null,
    ...(input.env ? { env: input.env } : {}),
  });

  const result = await notifyClientOnce({
    supabase: input.supabase,
    workspaceId: input.workspaceId,
    notification: 'site_live',
    dedupeKey: String(input.version),
    detail: {
      version: input.version,
      siteUrl,
      ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}),
    },
    render: (client) =>
      siteLiveEmail({
        siteUrl,
        dashboardUrl: client.dashboardUrl,
        clientName: client.clientName,
        businessName: client.businessName,
      }),
  });
  return result.sent;
}
