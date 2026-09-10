import 'server-only';
/**
 * The counts behind the client's "Your site" tiles.
 *
 * TENANCY. Every query here runs on the service-role client, which bypasses
 * RLS, so the `workspace_id` filter is the whole of the isolation. There is no
 * unfiltered read in this module and there must never be one: a count query
 * that forgot its filter would not error, it would quietly report the whole
 * platform's numbers to one client. `site-overview-data.test.ts` asserts the
 * filter on every query for that reason.
 *
 * SHAPE. Six head-only counts, issued together. They are counts rather than
 * rows because the page needs six numbers, not six lists, and `head: true`
 * keeps the payload empty.
 *
 * FAILURE. A count that errors comes back as zero rather than throwing. This
 * is a dashboard panel on a page that also carries a client's messages and
 * their outstanding invoice; losing all of that because a tile could not be
 * counted would be the wrong trade.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { startOfUtcMonth } from './edit-credits';

export interface SiteOverviewCounts {
  enquiries: {
    total: number;
    last30Days: number;
    /** Still at the status the capture endpoint writes: nobody has replied. */
    unread: number;
  };
  edits: {
    /** Applied, so "changes you made". */
    appliedThisMonth: number;
    /** Proposed, so "credits spent", whether or not the client kept them. */
    proposedThisMonth: number;
  };
  store: { products: number };
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function loadSiteOverviewCounts(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  now: Date = new Date()
): Promise<SiteOverviewCounts> {
  const monthStart = startOfUtcMonth(now);
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();

  const [total, last30Days, unread, applied, proposed, products] =
    await Promise.all([
      // Spam is excluded everywhere it is counted: it is not an enquiry, and a
      // client told they had 40 enquiries would go looking for 40 people.
      count(
        supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .neq('status', 'spam')
      ),
      count(
        supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .neq('status', 'spam')
          .gte('created_at', thirtyDaysAgo)
      ),
      count(
        supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('status', 'new')
      ),
      count(
        supabase
          .from('project_events')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('kind', 'site_edited')
          .gte('created_at', monthStart)
      ),
      count(
        supabase
          .from('project_events')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('kind', 'site_edit_proposed')
          .gte('created_at', monthStart)
      ),
      count(
        supabase
          .from('commerce_products')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
      ),
    ]);

  return {
    enquiries: { total, last30Days, unread },
    edits: { appliedThisMonth: applied, proposedThisMonth: proposed },
    store: { products },
  };
}

async function count(
  query: PromiseLike<{ count: number | null; error: unknown }>
): Promise<number> {
  try {
    const { count: value, error } = await query;
    if (error) return 0;
    return value ?? 0;
  } catch {
    return 0;
  }
}
