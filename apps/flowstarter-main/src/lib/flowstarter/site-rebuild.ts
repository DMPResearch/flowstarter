import 'server-only';
/**
 * Enqueueing the build that turns a published edit into a live site.
 *
 * The editor saves an edited *source* manifest, and a source manifest is not
 * something a deploy agent can serve. So publishing does not deploy, it asks
 * for a build: one SITE_REBUILD row in the ledger, which the build worker
 * claims, validates, commits and hands to the same publisher a full build
 * uses. This module owns the enqueue and nothing else, so the route stays a
 * route and the "join or start a new one" rule lives in one place.
 *
 * The worker freezes the manifest it will build at claim time (see
 * job-store.ts claim()), so a `running` job is already building whatever
 * manifest existed when it was claimed. A publish that lands after that can
 * only join a `queued` job, because a queued job's manifest is read fresh
 * when the worker later claims it; joining a `running` job would silently
 * lose the edit. So: join a `queued` job if one exists, otherwise start a new
 * one, even if a `running` job is already in flight for this workspace. At
 * most one job may be queued per workspace at a time, enforced by a partial
 * unique index in the database, not by the read below: two publishes a few
 * milliseconds apart would both read "none queued", and the index is what
 * decides which of them gets the row. The read is only there so the common
 * case does not spend an insert to learn it.
 *
 * This payload deliberately does not carry the `previewIntent` a
 * FULL_SITE_BUILD gets. The two are solving opposite halves of the same
 * problem: a full build seeds from the approved preview and then lets agents
 * expand it, so it needs a record of what must survive that expansion. A
 * rebuild seeds from the manifest the client's own editor just saved and
 * publishes it with no agent pass at all, so "what the client approved" and
 * "what is being built" are the same bytes by construction. Adding an intent
 * here would add a check that can only ever fail a client for editing their
 * own site.
 */
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

type SupabaseServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/** The only status whose manifest has not been frozen yet: safe to join. */
const JOINABLE = ['queued'] as const;

export interface SiteRebuildEnqueueResult {
  jobId: string;
  /** False when a rebuild was already queued and this publish joined it. */
  created: boolean;
}

export async function enqueueSiteRebuild(input: {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  version: number;
  publishedBy: string;
}): Promise<SiteRebuildEnqueueResult> {
  const { supabase, workspaceId } = input;

  const queued = await findQueuedRebuild(supabase, workspaceId);
  if (queued) return { jobId: queued, created: false };

  const now = new Date().toISOString();
  const insert = await supabase
    .from('flowstarter_agent_jobs')
    .insert({
      workspace_id: workspaceId,
      kind: 'SITE_REBUILD',
      status: 'queued',
      payload: {
        trigger: 'client_publish',
        version: input.version,
        publishedBy: input.publishedBy,
      },
      updated_at: now,
    })
    .select('id')
    .single();

  if (insert.error?.code === '23505') {
    // The index refused: another publish won the race a moment ago. That job
    // will build the same manifest this one would have, so joining it is the
    // right answer rather than an error the client can do nothing about.
    const existing = await findQueuedRebuild(supabase, workspaceId);
    if (!existing) {
      throw new Error(
        'A site rebuild is already queued for this workspace but could not be read back'
      );
    }
    return { jobId: existing, created: false };
  }
  if (insert.error || !insert.data) {
    throw insert.error ?? new Error('Could not enqueue the site rebuild');
  }
  return { jobId: insert.data.id, created: true };
}

async function findQueuedRebuild(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('flowstarter_agent_jobs')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'SITE_REBUILD')
    .in('status', JOINABLE as unknown as string[])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}
