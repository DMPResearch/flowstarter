import { NextResponse } from 'next/server';
import { requireTeamAuth } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  connectExistingHostingServer,
  ConnectExistingServerError,
} from '@/lib/hosting/connect-existing-server';

/**
 * POST /api/admin/hosting/servers/connect
 *
 * Connects the Hetzner server named by server-only env
 * (`FLOWSTARTER_EXISTING_HOST_ID` / `_AGENT_URL` / `_SECRET_REF`) into
 * `hosting_servers`. Deliberately takes no request body: the operator
 * configures the target server via env, not via the caller, so this can
 * never be pointed at an arbitrary host or asked to echo back a secret.
 */

const STATUS_BY_CODE: Record<string, number> = {
  config_missing: 409,
  config_invalid: 409,
  secret_unavailable: 500,
  health_check_failed: 502,
  hetzner_api_failed: 502,
  server_not_ready: 409,
  db_error: 500,
};

export async function POST() {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const supabase = createSupabaseServiceRoleClient();

  try {
    const server = await connectExistingHostingServer({
      supabase,
      createdBy: auth.userId,
    });
    return NextResponse.json({ server });
  } catch (e) {
    if (e instanceof ConnectExistingServerError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: STATUS_BY_CODE[e.code] ?? 500 }
      );
    }
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : 'Failed to connect existing server',
      },
      { status: 500 }
    );
  }
}
