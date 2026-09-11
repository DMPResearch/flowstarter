/**
 * Reading and writing `workspace_bookings`.
 *
 * Two properties are defended, and neither is about the happy path.
 *
 * TENANCY. Every query runs on the service-role client, which bypasses RLS, so
 * the `workspace_id` filter is the whole of the isolation. A recording fake is
 * the only way to assert a filter that was never sent.
 *
 * A WEBHOOK MUST NOT BE ABLE TO FAIL LOUDLY. Cal.com retries a non-2xx, so
 * every database problem in here has to come back as a value rather than a
 * throw, including the one that is not really a problem: the unique index
 * catching two copies of the same delivery that raced past the read.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  listWorkspaceBookings,
  loadBookingRowsForSummary,
  recordCalBooking,
} from '../bookings-data';
import type { CalBookingEvent } from '../cal-webhook';

vi.mock('server-only', () => ({}));

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

interface Recorded {
  table: string;
  mode: 'select' | 'insert' | 'update';
  eq: Array<[string, unknown]>;
  values?: Record<string, unknown>;
  order?: [string, { ascending?: boolean; nullsFirst?: boolean } | undefined];
  limit?: number;
}

type Answer = (query: Recorded) => { data: unknown; error: unknown };

function fakeSupabase(answer: Answer) {
  const queries: Recorded[] = [];
  const client = {
    from(table: string) {
      const query: Recorded = { table, mode: 'select', eq: [] };
      queries.push(query);
      const builder = {
        select() {
          return builder;
        },
        insert(values: Record<string, unknown>) {
          query.mode = 'insert';
          query.values = values;
          return builder;
        },
        update(values: Record<string, unknown>) {
          query.mode = 'update';
          query.values = values;
          return builder;
        },
        eq(column: string, value: unknown) {
          query.eq.push([column, value]);
          return builder;
        },
        order(
          column: string,
          options?: { ascending?: boolean; nullsFirst?: boolean }
        ) {
          query.order = [column, options];
          return builder;
        },
        limit(count: number) {
          query.limit = count;
          return builder;
        },
        maybeSingle() {
          const { data, error } = answer(query);
          return Promise.resolve({
            data: Array.isArray(data) ? data[0] ?? null : data,
            error,
          });
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(resolve(answer(query)));
        },
      };
      return builder;
    },
  };
  return { queries, client: client as unknown as SupabaseClient<Database> };
}

const ok = () => ({ data: null, error: null });

function event(overrides: Partial<CalBookingEvent> = {}): CalBookingEvent {
  return {
    trigger: 'BOOKING_CREATED',
    status: 'booked',
    uid: 'bk_abc123',
    eventTypeSlug: 'intro',
    title: 'Intro call',
    startAt: '2026-09-15T09:30:00.000Z',
    endAt: '2026-09-15T10:00:00.000Z',
    attendeeName: 'Ada Roe',
    attendeeEmail: 'ada@example.com',
    ...overrides,
  };
}

const dbRow = {
  id: 'row-1',
  external_uid: 'bk_abc123',
  event_type_slug: 'intro',
  title: 'Intro call',
  start_at: '2026-09-15T09:30:00.000Z',
  end_at: '2026-09-15T10:00:00.000Z',
  attendee_name: 'Ada Roe',
  attendee_email: 'ada@example.com',
  status: 'booked',
  created_at: '2026-09-01T00:00:00.000Z',
};

describe('recordCalBooking', () => {
  it('inserts a booking nobody has seen before, scoped to the workspace', async () => {
    const db = fakeSupabase(ok);
    const result = await recordCalBooking(db.client, {
      workspaceId: WORKSPACE,
      event: event(),
      payload: { triggerEvent: 'BOOKING_CREATED' },
    });

    expect(result.action).toEqual({ kind: 'insert' });
    expect(result.externalUid).toBe('bk_abc123');

    const insert = db.queries.find((query) => query.mode === 'insert');
    expect(insert?.table).toBe('workspace_bookings');
    expect(insert?.values).toMatchObject({
      workspace_id: WORKSPACE,
      provider: 'cal.com',
      external_uid: 'bk_abc123',
      status: 'booked',
      title: 'Intro call',
      start_at: '2026-09-15T09:30:00.000Z',
      attendee_email: 'ada@example.com',
      payload: { triggerEvent: 'BOOKING_CREATED' },
    });

    // The lookup that decides insert-or-update is itself tenant scoped.
    const read = db.queries[0];
    expect(read.eq).toContainEqual(['workspace_id', WORKSPACE]);
    expect(read.eq).toContainEqual(['external_uid', 'bk_abc123']);
    expect(read.eq).toContainEqual(['provider', 'cal.com']);
  });

  it('does nothing when the same delivery arrives again', async () => {
    const db = fakeSupabase((query) =>
      query.mode === 'select'
        ? { data: { id: 'row-1', status: 'booked' }, error: null }
        : ok()
    );
    const result = await recordCalBooking(db.client, {
      workspaceId: WORKSPACE,
      event: event(),
      payload: {},
    });

    expect(result.action).toEqual({ kind: 'skip', reason: 'replayed' });
    expect(db.queries.filter((query) => query.mode !== 'select')).toHaveLength(
      0
    );
  });

  it('updates in place when the booking moved, and never inserts a second row', async () => {
    const db = fakeSupabase((query) =>
      query.mode === 'select'
        ? { data: { id: 'row-1', status: 'booked' }, error: null }
        : ok()
    );
    const result = await recordCalBooking(db.client, {
      workspaceId: WORKSPACE,
      event: event({ trigger: 'BOOKING_CANCELLED', status: 'cancelled' }),
      payload: {},
    });

    expect(result.action).toEqual({ kind: 'update' });
    const writes = db.queries.filter((query) => query.mode !== 'select');
    expect(writes).toHaveLength(1);
    expect(writes[0].mode).toBe('update');
    expect(writes[0].values).toMatchObject({ status: 'cancelled' });
    // Both the row id and the workspace, so a wrong id cannot reach another
    // tenant's row.
    expect(writes[0].eq).toContainEqual(['id', 'row-1']);
    expect(writes[0].eq).toContainEqual(['workspace_id', WORKSPACE]);
  });

  it('refuses to resurrect a booking the client was told was cancelled', async () => {
    const db = fakeSupabase((query) =>
      query.mode === 'select'
        ? { data: { id: 'row-1', status: 'cancelled' }, error: null }
        : ok()
    );
    const result = await recordCalBooking(db.client, {
      workspaceId: WORKSPACE,
      event: event(),
      payload: {},
    });
    expect(result.action).toEqual({ kind: 'skip', reason: 'superseded' });
  });

  // The race the read cannot see: two copies of one delivery, handled at
  // once. The index wins, and the loser is a no-op rather than a 500 that
  // makes Cal.com send a third copy.
  it('treats a unique violation as the duplicate it is', async () => {
    const db = fakeSupabase((query) =>
      query.mode === 'insert'
        ? { data: null, error: { code: '23505', message: 'duplicate key' } }
        : ok()
    );
    const result = await recordCalBooking(db.client, {
      workspaceId: WORKSPACE,
      event: event(),
      payload: {},
    });
    expect(result.action).toEqual({ kind: 'skip', reason: 'replayed' });
  });

  it('swallows a failed read, a failed insert and a failed update', async () => {
    const failing = { code: '08006', message: 'connection lost' };

    const onRead = fakeSupabase(() => ({ data: null, error: failing }));
    await expect(
      recordCalBooking(onRead.client, {
        workspaceId: WORKSPACE,
        event: event(),
        payload: {},
      })
    ).resolves.toMatchObject({ action: { kind: 'skip' } });

    const onInsert = fakeSupabase((query) =>
      query.mode === 'insert' ? { data: null, error: failing } : ok()
    );
    await expect(
      recordCalBooking(onInsert.client, {
        workspaceId: WORKSPACE,
        event: event(),
        payload: {},
      })
    ).resolves.toMatchObject({ action: { kind: 'skip' } });

    const onUpdate = fakeSupabase((query) => {
      if (query.mode === 'select')
        return { data: { id: 'row-1', status: 'booked' }, error: null };
      return { data: null, error: failing };
    });
    await expect(
      recordCalBooking(onUpdate.client, {
        workspaceId: WORKSPACE,
        event: event({ trigger: 'BOOKING_CANCELLED', status: 'cancelled' }),
        payload: {},
      })
    ).resolves.toMatchObject({ action: { kind: 'skip' } });
  });

  it('stores an empty payload rather than null when none was given', async () => {
    const db = fakeSupabase(ok);
    await recordCalBooking(db.client, {
      workspaceId: WORKSPACE,
      event: event(),
      payload: undefined,
    });
    expect(
      db.queries.find((query) => query.mode === 'insert')?.values?.payload
    ).toEqual({});
  });
});

describe('listWorkspaceBookings', () => {
  it('reads one workspace, newest start first, with a cap', async () => {
    const db = fakeSupabase(() => ({ data: [dbRow], error: null }));
    const rows = await listWorkspaceBookings(db.client, WORKSPACE);

    expect(db.queries[0].eq).toEqual([['workspace_id', WORKSPACE]]);
    expect(db.queries[0].order).toEqual([
      'start_at',
      { ascending: false, nullsFirst: false },
    ]);
    expect(db.queries[0].limit).toBe(200);
    expect(rows).toEqual([
      {
        id: 'row-1',
        externalUid: 'bk_abc123',
        eventTypeSlug: 'intro',
        title: 'Intro call',
        startAt: '2026-09-15T09:30:00.000Z',
        endAt: '2026-09-15T10:00:00.000Z',
        attendeeName: 'Ada Roe',
        attendeeEmail: 'ada@example.com',
        status: 'booked',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
  });

  it('honours a caller’s own cap', async () => {
    const db = fakeSupabase(() => ({ data: [], error: null }));
    await listWorkspaceBookings(db.client, WORKSPACE, 5);
    expect(db.queries[0].limit).toBe(5);
  });

  // The list sits on a page that also carries the client's messages and their
  // invoice. Losing all of it because one query failed is the wrong trade.
  it('returns an empty list rather than taking the page down', async () => {
    const db = fakeSupabase(() => ({
      data: null,
      error: { message: 'permission denied' },
    }));
    await expect(listWorkspaceBookings(db.client, WORKSPACE)).resolves.toEqual(
      []
    );
  });
});

describe('loadBookingRowsForSummary', () => {
  it('asks for one workspace and only the columns the counts need', async () => {
    const db = fakeSupabase(() => ({
      data: [
        {
          id: 'row-1',
          external_uid: 'bk_abc123',
          status: 'cancelled',
          start_at: '2026-09-15T09:30:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
      error: null,
    }));
    const rows = await loadBookingRowsForSummary(db.client, WORKSPACE);

    expect(db.queries[0].eq).toEqual([['workspace_id', WORKSPACE]]);
    expect(rows).toEqual([
      {
        id: 'row-1',
        externalUid: 'bk_abc123',
        eventTypeSlug: null,
        title: null,
        startAt: '2026-09-15T09:30:00.000Z',
        endAt: null,
        attendeeName: null,
        attendeeEmail: null,
        status: 'cancelled',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
  });

  it('reports nothing rather than throwing when the read fails', async () => {
    const db = fakeSupabase(() => ({
      data: null,
      error: { message: 'permission denied' },
    }));
    await expect(
      loadBookingRowsForSummary(db.client, WORKSPACE)
    ).resolves.toEqual([]);
  });
});
