import 'server-only';
/**
 * "Your change is live", sent the moment a paid change request reaches the
 * host.
 *
 * It hangs off the deploy, not off the job, for exactly the reason
 * `notifySiteLive` does: `deploySite` is the single place in the app where a
 * site actually becomes reachable, and a notice attached anywhere else is a
 * promise made before the thing it promises is true. The change request's id
 * rides on the build worker's deploy callback so this can name the request
 * without guessing which of a workspace's requests it was.
 *
 * Keyed on the request id. A client hears once per thing they bought; a second
 * build of the same request is a repair of the first and is not news.
 *
 * Never throws, by `notifyClientOnce`'s contract, so a mail problem cannot
 * fail a deploy that has already put a client's site on the internet.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { changeRequestLiveEmail } from '@/lib/email-templates/client-notices';
import { notifyClientOnce } from '@/lib/flowstarter/client-notifications';
import { deployedSiteUrl, type EnvLike } from './site-urls';

export async function notifyChangeRequestLive(input: {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  changeRequestId: string;
  /** `site_versions.version` the change landed in, for the client's own card. */
  version: number;
  env?: EnvLike;
}): Promise<boolean> {
  // The request text is read here rather than carried on the callback: it is
  // the client's own sentence, it is quoted back to them in the email, and the
  // database row is the only copy of it nobody can have retyped on the way.
  const { data: request } = await input.supabase
    .from('flowstarter_change_requests')
    .select('id, request')
    .eq('id', input.changeRequestId)
    .eq('workspace_id', input.workspaceId)
    .maybeSingle();
  if (!request) {
    console.warn(
      `[change-request-email] ${input.changeRequestId} is not a request on ` +
        `workspace ${input.workspaceId}; no notice sent`
    );
    return false;
  }

  const { data: workspace } = await input.supabase
    .from('workspaces')
    .select('slug')
    .eq('id', input.workspaceId)
    .maybeSingle();
  const { data: hosts } = await input.supabase
    .from('workspace_hosts')
    .select('hostname, is_primary')
    .eq('workspace_id', input.workspaceId);

  const siteUrl = deployedSiteUrl({
    slug: workspace?.slug ?? '',
    primaryDomain:
      (hosts ?? []).find((host) => host.is_primary)?.hostname ?? null,
    ...(input.env ? { env: input.env } : {}),
  });

  const result = await notifyClientOnce({
    supabase: input.supabase,
    workspaceId: input.workspaceId,
    notification: 'change_request_live',
    dedupeKey: input.changeRequestId,
    detail: {
      changeRequestId: input.changeRequestId,
      version: input.version,
      siteUrl,
    },
    render: (client) =>
      changeRequestLiveEmail({
        request: request.request,
        siteUrl,
        version: input.version,
        dashboardUrl: client.dashboardUrl,
        clientName: client.clientName,
        businessName: client.businessName,
      }),
  });
  return result.sent;
}
