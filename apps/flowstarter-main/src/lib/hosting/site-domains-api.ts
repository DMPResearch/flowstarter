import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireTeamAuth } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { CloudflareClient, CloudflareApiError } from './cloudflare';

/**
 * Attaching a client's own domain to their site, once.
 *
 * `/api/admin/projects/[id]/site/domains` and
 * `/api/team/projects/[id]/site/domains` used to be two hand-maintained
 * copies of this file — the same trap `pipeline/api.ts` documents and fixes
 * for the pipeline endpoints. One implementation, two one-line re-exports.
 *
 * The DNS half is intentionally best-effort and split into two outcomes that
 * look nothing alike to an operator reading the response:
 *
 *   - the zone is managed here (Cloudflare, `CLOUDFLARE_API_TOKEN` set, and
 *     the zone or one of its parents is in that account) — the A record is
 *     upserted automatically and `dns.automated` is true;
 *   - it is not (the client's domain lives at whatever registrar they bought
 *     it from — GoDaddy, Namecheap, wherever) — this cannot create anything
 *     over there, so it returns `dns.manualRecord`: the exact record an
 *     operator can read straight into an email or a support ticket, rather
 *     than a bare error string that means "go figure out the DNS yourself."
 *
 * Both outcomes still attach the domain to `workspace_hosts` — a client's
 * ability to see "this domain is attached, pending DNS" must not depend on
 * whether we happen to manage their registrar.
 */

interface AddDomainBody {
  domain?: unknown;
  primary?: unknown;
}

export interface ManualDnsRecord {
  type: 'A';
  name: string;
  value: string;
  ttl: string;
  note: string;
}

export async function addWorkspaceDomainHandler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const { id: workspaceId } = await params;
  const body = (await req.json().catch(() => ({}))) as AddDomainBody;

  const domain = sanitizeDomain(body.domain);
  if (!domain) {
    return NextResponse.json(
      { error: 'domain is required and must be a valid hostname' },
      { status: 400 }
    );
  }
  const isPrimary = body.primary === true;

  const supabase = createSupabaseServiceRoleClient();

  const { data: workspace, error: wsErr } = await supabase
    .from('workspaces')
    .select(
      `id, slug, hosting_server_id, cloudflare_zone_id, cloudflare_record_ids`
    )
    .eq('id', workspaceId)
    .maybeSingle();
  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  if (!workspace.hosting_server_id) {
    return NextResponse.json(
      {
        error:
          'Workspace has no allocated server yet. Allocate a hosting server for this project before attaching a domain.',
      },
      { status: 404 }
    );
  }

  const { data: existingHosts, error: hostsErr } = await supabase
    .from('workspace_hosts')
    .select('hostname, is_primary')
    .eq('workspace_id', workspaceId);
  if (hostsErr) {
    return NextResponse.json({ error: hostsErr.message }, { status: 500 });
  }

  if ((existingHosts ?? []).some((h) => h.hostname === domain)) {
    return NextResponse.json(
      { error: `Domain ${domain} is already attached to this workspace` },
      { status: 409 }
    );
  }

  // If the new domain is primary, demote any existing primary first.
  if (isPrimary) {
    const currentPrimary = (existingHosts ?? []).find((h) => h.is_primary);
    if (currentPrimary && currentPrimary.hostname !== domain) {
      const { error: demoteErr } = await supabase
        .from('workspace_hosts')
        .update({ is_primary: false })
        .eq('workspace_id', workspaceId)
        .eq('hostname', currentPrimary.hostname);
      if (demoteErr) {
        return NextResponse.json({ error: demoteErr.message }, { status: 500 });
      }
    }
  }

  // Best-effort DNS upsert. `serverIpv4` is threaded through separately from
  // `dnsResult`/`dnsError` because the manual-record fallback needs it even
  // when nothing was managed or nothing went wrong — it is the value the
  // client's registrar needs regardless of who is doing the pointing.
  let dnsResult: { recordId: string; zoneId: string } | null = null;
  let dnsError: string | null = null;
  let serverIpv4: string | null = null;

  const { data: server } = await supabase
    .from('hosting_servers')
    .select('ipv4')
    .eq('id', workspace.hosting_server_id)
    .maybeSingle();
  serverIpv4 = (server?.ipv4 as string | null | undefined) ?? null;

  if (!process.env.CLOUDFLARE_API_TOKEN) {
    dnsError = 'CLOUDFLARE_API_TOKEN not configured; DNS not automated';
  } else if (!serverIpv4) {
    dnsError =
      'Server has no ipv4 yet; it may still be provisioning. Nothing to point DNS at.';
  } else {
    try {
      const cf = new CloudflareClient({
        token: process.env.CLOUDFLARE_API_TOKEN,
      });
      const zone = await findManagedZone(cf, domain);
      if (zone) {
        const record = await cf.upsertRecord({
          zoneId: zone.id,
          type: 'A',
          name: domain,
          content: serverIpv4,
          ttl: 300,
          proxied: false,
          comment: `flowstarter site ${workspace.slug}`,
        });
        dnsResult = { recordId: record.id, zoneId: zone.id };
      } else {
        dnsError = `${domain} is not in a Cloudflare zone this account manages`;
      }
    } catch (e) {
      if (e instanceof CloudflareApiError) {
        dnsError = `Cloudflare error: ${e.errors
          .map((x) => x.message)
          .join('; ')}`;
      } else {
        dnsError = e instanceof Error ? e.message : 'DNS upsert failed';
      }
    }
  }

  // Insert the host row. The domain is attached whether or not DNS could be
  // automated — a client's dashboard showing "attached, pending DNS" must not
  // wait on us managing their registrar.
  const { error: insertErr } = await supabase.from('workspace_hosts').insert({
    workspace_id: workspaceId,
    hostname: domain,
    is_primary: isPrimary,
  });
  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Track CF record ID on the workspace.
  if (dnsResult) {
    const existingMap = ((workspace.cloudflare_record_ids as Record<
      string,
      unknown
    >) ?? {}) as Record<string, { recordId: string; zoneId: string }>;
    existingMap[domain] = dnsResult;
    await supabase
      .from('workspaces')
      .update({
        cloudflare_record_ids: existingMap,
        cloudflare_zone_id: workspace.cloudflare_zone_id ?? dnsResult.zoneId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', workspaceId);
  }

  const { data: updatedHosts } = await supabase
    .from('workspace_hosts')
    .select('hostname, is_primary')
    .eq('workspace_id', workspaceId);

  return NextResponse.json({
    workspaceId,
    hosts: updatedHosts ?? [],
    domain,
    dns: {
      automated: Boolean(dnsResult),
      recordId: dnsResult?.recordId ?? null,
      zoneId: dnsResult?.zoneId ?? null,
      /**
       * Present exactly when DNS was not automated and we know what record
       * would make this domain resolve — i.e. the server has an IP. This is
       * the scaffolding a client-facing "how do I point my domain" screen or
       * a support reply reads directly off, instead of re-deriving "A record,
       * to what?" from `dnsError` every time.
       */
      manualRecord: !dnsResult ? manualDnsRecord(domain, serverIpv4) : null,
      error: dnsError,
    },
  });
}

export async function removeWorkspaceDomainHandler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const { id: workspaceId } = await params;
  const url = new URL(req.url);
  const domainParam = url.searchParams.get('domain');
  const domain = sanitizeDomain(domainParam);
  if (!domain) {
    return NextResponse.json(
      { error: 'domain query param is required' },
      { status: 400 }
    );
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: workspace, error: wsErr } = await supabase
    .from('workspaces')
    .select('id, cloudflare_record_ids')
    .eq('id', workspaceId)
    .maybeSingle();
  if (wsErr || !workspace) {
    return NextResponse.json(
      { error: wsErr?.message ?? 'Workspace not found' },
      { status: wsErr ? 500 : 404 }
    );
  }

  const recordIds = (workspace.cloudflare_record_ids ?? {}) as Record<
    string,
    { recordId: string; zoneId: string }
  >;
  const cfRef = recordIds[domain];
  let dnsError: string | null = null;
  if (cfRef && process.env.CLOUDFLARE_API_TOKEN) {
    try {
      const cf = new CloudflareClient({
        token: process.env.CLOUDFLARE_API_TOKEN,
      });
      await cf.deleteRecord(cfRef.zoneId, cfRef.recordId);
    } catch (e) {
      dnsError = e instanceof Error ? e.message : 'DNS delete failed';
    }
  }

  const { error: deleteErr } = await supabase
    .from('workspace_hosts')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('hostname', domain);
  if (deleteErr) {
    return NextResponse.json({ error: deleteErr.message }, { status: 500 });
  }

  const newRecordIds = { ...recordIds };
  delete newRecordIds[domain];
  await supabase
    .from('workspaces')
    .update({
      cloudflare_record_ids: newRecordIds,
      updated_at: new Date().toISOString(),
    })
    .eq('id', workspaceId);

  const { data: updatedHosts } = await supabase
    .from('workspace_hosts')
    .select('hostname, is_primary')
    .eq('workspace_id', workspaceId);

  return NextResponse.json({
    workspaceId,
    hosts: updatedHosts ?? [],
    domain,
    dnsError,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sanitizeDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      trimmed
    )
  ) {
    return null;
  }
  if (trimmed.length > 253) return null;
  return trimmed;
}

/**
 * The Cloudflare zone that manages `domain`, or null when this account manages
 * none of its suffixes.
 *
 * "No zone" and "we could not ask" are different answers and used to look the
 * same: every per-attempt failure was swallowed, so an invalid or expired
 * `CLOUDFLARE_API_TOKEN` reached the operator as "acme.example.com is not in a
 * Cloudflare zone this account manages" and sent them looking at the client's
 * registrar. A `CloudflareApiError` now propagates, and the caller's existing
 * handler at the top of this module turns it into an explicit error naming the
 * status. Only a transport-level failure on one candidate is still tolerated,
 * because a longer suffix may still answer.
 */
async function findManagedZone(
  cf: CloudflareClient,
  domain: string
): Promise<{ id: string; name: string } | null> {
  const labels = domain.split('.');
  let transportFailure: unknown = null;

  for (let i = 0; i + 1 < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    try {
      const zone = await cf.findZoneByName(candidate);
      if (zone) return { id: zone.id, name: zone.name };
    } catch (e) {
      // Cloudflare answered and refused: a bad token, a revoked scope, a rate
      // limit. Asking about a longer suffix will be refused the same way.
      if (e instanceof CloudflareApiError) throw e;
      transportFailure = e;
    }
  }

  // Never reached Cloudflare at all for any candidate. Saying "not managed"
  // here would be a guess.
  if (transportFailure !== null) throw transportFailure;

  return null;
}

/**
 * The exact record a client's registrar (GoDaddy, Namecheap, whoever) needs,
 * whenever we know the target IP but cannot create the record ourselves.
 * Null only when there is nothing to point at yet (no server IP) — a manual
 * record with no value would be worse than no instructions at all.
 */
function manualDnsRecord(
  domain: string,
  serverIpv4: string | null
): ManualDnsRecord | null {
  if (!serverIpv4) return null;
  return {
    type: 'A',
    name: domain,
    value: serverIpv4,
    ttl: 'automatic (or 300s if the registrar asks for one)',
    note:
      `At your domain registrar (GoDaddy, Namecheap, or wherever ${domain} is ` +
      `registered), add an A record for "${domain}" pointing to ${serverIpv4}. ` +
      'No CNAME and no proxy, just a plain A record. It can take up to a few hours to ' +
      'propagate after you save it.',
  };
}
