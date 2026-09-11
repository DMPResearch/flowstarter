/**
 * The counts behind the client's site tiles.
 *
 * The assertion that matters is the boring one: every query carries a
 * `workspace_id` filter. These run on the service-role client, which bypasses
 * RLS, so a missing filter is not a wrong number on a dashboard, it is one
 * client being shown another client's enquiries. A recording fake is the only
 * way to assert a filter that was never sent.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadSiteOverviewCounts } from '../site-overview-data';

vi.mock('server-only', () => ({}));

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const NOW = new Date('2026-09-10T12:00:00Z');

interface RecordedQuery {
  table: string;
  eq: Array<[string, unknown]>;
  neq: Array<[string, unknown]>;
  gte: Array<[string, string]>;
  head: boolean;
}

/**
 * Answers each query with a count keyed by the shape of the query, so the six
 * numbers can be told apart in the result without pretending to be Postgres.
 */
function fakeSupabase(
  answer: (query: RecordedQuery) => { count: number | null; error?: unknown }
) {
  const queries: RecordedQuery[] = [];

  const client = {
    from(table: string) {
      const query: RecordedQuery = {
        table,
        eq: [],
        neq: [],
        gte: [],
        head: false,
      };
      queries.push(query);
      const builder = {
        select(_columns: string, options?: { head?: boolean }) {
          query.head = Boolean(options?.head);
          return builder;
        },
        eq(column: string, value: unknown) {
          query.eq.push([column, value]);
          return builder;
        },
        neq(column: string, value: unknown) {
          query.neq.push([column, value]);
          return builder;
        },
        gte(column: string, value: string) {
          query.gte.push([column, value]);
          return builder;
        },
        then(resolve: (value: unknown) => unknown) {
          const { count, error } = answer(query);
          return Promise.resolve(resolve({ count, error: error ?? null }));
        },
      };
      return builder;
    },
  };

  return {
    queries,
    client: client as unknown as SupabaseClient<Database>,
  };
}

/** Every query answered with a distinct number, keyed by what it asks for. */
function byShape(query: RecordedQuery): { count: number } {
  const kind = query.eq.find(([column]) => column === 'kind')?.[1];
  if (query.table === 'commerce_products') return { count: 4 };
  if (query.table === 'project_events') {
    return { count: kind === 'site_edited' ? 6 : 9 };
  }
  if (query.eq.some(([column]) => column === 'status')) return { count: 3 };
  if (query.gte.length > 0) return { count: 5 };
  return { count: 12 };
}

describe('loadSiteOverviewCounts', () => {
  it('scopes every single query to the one workspace', async () => {
    const db = fakeSupabase(byShape);
    await loadSiteOverviewCounts(db.client, WORKSPACE, NOW);

    expect(db.queries).toHaveLength(7);
    for (const query of db.queries) {
      expect(query.eq).toContainEqual(['workspace_id', WORKSPACE]);
    }
  });

  // Six of the seven are head-only counts. The seventh is the bookings read,
  // which cannot be: the tile needs the time of the next booking, and a count
  // has no time in it.
  it('counts rather than fetching them, except where a time is needed', async () => {
    const db = fakeSupabase(byShape);
    await loadSiteOverviewCounts(db.client, WORKSPACE, NOW);
    const counting = db.queries.filter(
      (query) => query.table !== 'workspace_bookings'
    );
    expect(counting).toHaveLength(6);
    expect(counting.every((query) => query.head)).toBe(true);
  });

  it('reads the tables the tiles claim to read, and nothing else', async () => {
    const db = fakeSupabase(byShape);
    await loadSiteOverviewCounts(db.client, WORKSPACE, NOW);

    const tables = db.queries.map((query) => query.table).sort();
    expect(tables).toEqual([
      'commerce_products',
      'leads',
      'leads',
      'leads',
      'project_events',
      'project_events',
      'workspace_bookings',
    ]);
  });

  it('keeps spam out of the enquiry counts', async () => {
    const db = fakeSupabase(byShape);
    await loadSiteOverviewCounts(db.client, WORKSPACE, NOW);

    const totals = db.queries.filter(
      (query) =>
        query.table === 'leads' &&
        !query.eq.some(([column]) => column === 'status')
    );
    expect(totals).toHaveLength(2);
    for (const query of totals) {
      expect(query.neq).toContainEqual(['status', 'spam']);
    }
  });

  it('counts the enquiries nobody has replied to by their real status', async () => {
    const db = fakeSupabase(byShape);
    await loadSiteOverviewCounts(db.client, WORKSPACE, NOW);

    const unread = db.queries.find(
      (query) =>
        query.table === 'leads' &&
        query.eq.some(([column]) => column === 'status')
    );
    expect(unread?.eq).toContainEqual(['status', 'new']);
  });

  it('windows the edit counts on the UTC month and the enquiries on 30 days', async () => {
    const db = fakeSupabase(byShape);
    await loadSiteOverviewCounts(db.client, WORKSPACE, NOW);

    const events = db.queries.filter(
      (query) => query.table === 'project_events'
    );
    for (const query of events) {
      expect(query.gte).toContainEqual([
        'created_at',
        '2026-09-01T00:00:00.000Z',
      ]);
    }

    const recent = db.queries.find(
      (query) => query.table === 'leads' && query.gte.length > 0
    );
    expect(recent?.gte).toContainEqual([
      'created_at',
      '2026-08-11T12:00:00.000Z',
    ]);
  });

  it('separates proposed edits from applied ones', async () => {
    const db = fakeSupabase(byShape);
    const counts = await loadSiteOverviewCounts(db.client, WORKSPACE, NOW);

    expect(counts).toEqual({
      enquiries: { total: 12, last30Days: 5, unread: 3 },
      edits: { appliedThisMonth: 6, proposedThisMonth: 9 },
      store: { products: 4 },
      bookings: { upcoming: 0, nextAt: null, last30Days: 0, total: 0 },
    });
  });

  it('reports zero rather than taking the whole page down with it', async () => {
    const db = fakeSupabase((query) =>
      query.table === 'leads'
        ? { count: null, error: { message: 'permission denied' } }
        : byShape(query)
    );
    const counts = await loadSiteOverviewCounts(db.client, WORKSPACE, NOW);

    expect(counts.enquiries).toEqual({ total: 0, last30Days: 0, unread: 0 });
    expect(counts.store.products).toBe(4);
  });
});
