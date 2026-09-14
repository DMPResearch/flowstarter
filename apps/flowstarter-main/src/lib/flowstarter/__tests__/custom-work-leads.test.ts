/**
 * The data layer for `custom_work_leads`, including the two failure modes that
 * matter: an insert that does not work must not fail the visitor, and a read
 * that does not work must fail the operator loudly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  CUSTOM_WORK_LEAD_LIMIT,
  listCustomWorkLeads,
  markConfirmationSent,
  markCustomWorkLeadContacted,
  recordCustomWorkLead,
} from '../custom-work-leads';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Recorded {
  inserted: Array<Record<string, unknown>>;
  updated: Array<Record<string, unknown>>;
  selected: string[];
  ordered: Array<{ column: string; options: unknown }>;
  limited: number[];
  eq: Array<[string, string]>;
}

function fakeClient(
  behaviour: {
    insertError?: unknown;
    selectError?: unknown;
    updateError?: unknown;
    rows?: unknown[];
    updatedRow?: unknown;
  } = {}
): { client: SupabaseClient<Database>; recorded: Recorded } {
  const recorded: Recorded = {
    inserted: [],
    updated: [],
    selected: [],
    ordered: [],
    limited: [],
    eq: [],
  };

  const client = {
    from: () => ({
      insert(values: Record<string, unknown>) {
        recorded.inserted.push(values);
        return {
          select: () => ({
            single: async () => ({
              data: behaviour.insertError ? null : { id: 'lead-1' },
              error: behaviour.insertError ?? null,
            }),
          }),
        };
      },
      select(columns: string) {
        recorded.selected.push(columns);
        return {
          order(column: string, options: unknown) {
            recorded.ordered.push({ column, options });
            return {
              limit: async (n: number) => {
                recorded.limited.push(n);
                return {
                  data: behaviour.rows ?? [],
                  error: behaviour.selectError ?? null,
                };
              },
            };
          },
        };
      },
      update(values: Record<string, unknown>) {
        recorded.updated.push(values);
        return {
          eq: (column: string, value: string) => {
            recorded.eq.push([column, value]);
            const settled = {
              data: behaviour.updatedRow ?? null,
              error: behaviour.updateError ?? null,
            };
            return Object.assign(
              Promise.resolve({ error: behaviour.updateError ?? null }),
              {
                select: () => ({ maybeSingle: async () => settled }),
              }
            );
          },
        };
      },
    }),
  } as any;

  return { client, recorded };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const INPUT = {
  name: 'Sarah Smith',
  email: 'sarah@example.com',
  description: 'A portal my customers log into',
  scope: 'custom' as const,
  confidence: 0.94,
  evidence: ['log into'],
  classifier: 'llm:test',
  route: 'discovery-call' as const,
  routeRule: 'customAboveThreshold',
  source: 'funnel' as const,
  bookingStatus: 'offered' as const,
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('recordCustomWorkLead', () => {
  it('writes the row and returns its id', async () => {
    const { client, recorded } = fakeClient();
    expect(await recordCustomWorkLead({ ...INPUT, supabase: client })).toBe(
      'lead-1'
    );
    expect(recorded.inserted[0]).toMatchObject({
      name: 'Sarah Smith',
      scope: 'custom',
      scope_confidence: 0.94,
      acceptable_use: null,
      link_url: null,
      link_title: null,
      clarification: null,
    });
  });

  it('clamps a confidence outside 0..1 before it reaches the check constraint', async () => {
    const { client, recorded } = fakeClient();
    await recordCustomWorkLead({ ...INPUT, confidence: 5, supabase: client });
    expect(recorded.inserted[0].scope_confidence).toBe(1);
    await recordCustomWorkLead({ ...INPUT, confidence: -5, supabase: client });
    expect(recorded.inserted[1].scope_confidence).toBe(0);
    await recordCustomWorkLead({
      ...INPUT,
      confidence: Number.NaN,
      supabase: client,
    });
    expect(recorded.inserted[2].scope_confidence).toBe(0);
  });

  it('stands in for a name the visitor never gave rather than writing an empty one', async () => {
    const { client, recorded } = fakeClient();
    await recordCustomWorkLead({ ...INPUT, name: '   ', supabase: client });
    expect(recorded.inserted[0].name).toBe('Not given');
  });

  it('trims and caps the free text', async () => {
    const { client, recorded } = fakeClient();
    await recordCustomWorkLead({
      ...INPUT,
      description: `  ${'x'.repeat(20_000)}  `,
      linkTitle: '  Acme  ',
      supabase: client,
    });
    expect(String(recorded.inserted[0].description).length).toBe(5_000);
    expect(recorded.inserted[0].link_title).toBe('Acme');
  });

  it('returns null instead of throwing when the insert fails', async () => {
    const { client } = fakeClient({ insertError: { message: 'nope' } });
    // A visitor who has just been offered a call must still see the calendar.
    expect(
      await recordCustomWorkLead({ ...INPUT, supabase: client })
    ).toBeNull();
  });
});

describe('markConfirmationSent', () => {
  it('stamps the row', async () => {
    const { client, recorded } = fakeClient();
    await markConfirmationSent('lead-1', client);
    expect(recorded.updated[0]).toHaveProperty('confirmation_sent_at');
    expect(recorded.eq[0]).toEqual(['id', 'lead-1']);
  });

  it('swallows a failure: the email was still sent', async () => {
    const { client } = fakeClient({ updateError: { message: 'nope' } });
    await expect(
      markConfirmationSent('lead-1', client)
    ).resolves.toBeUndefined();
  });
});

describe('listCustomWorkLeads', () => {
  it('reads newest first, bounded', async () => {
    const { client, recorded } = fakeClient({ rows: [{ id: 'a' }] });
    const rows = await listCustomWorkLeads(client);
    expect(rows).toHaveLength(1);
    expect(recorded.ordered[0]).toEqual({
      column: 'created_at',
      options: { ascending: false },
    });
    expect(recorded.limited[0]).toBe(CUSTOM_WORK_LEAD_LIMIT);
    expect(recorded.selected[0]).toContain('scope_evidence');
  });

  it('throws so the operator is told, rather than showing an empty lane', async () => {
    const { client } = fakeClient({ selectError: { message: 'down' } });
    await expect(listCustomWorkLeads(client)).rejects.toBeTruthy();
  });

  it('treats a null payload as no leads', async () => {
    const { client } = fakeClient({ rows: undefined });
    expect(await listCustomWorkLeads(client)).toEqual([]);
  });
});

describe('markCustomWorkLeadContacted', () => {
  it('stamps who and when, and returns the row', async () => {
    const { client, recorded } = fakeClient({ updatedRow: { id: 'lead-1' } });
    const row = await markCustomWorkLeadContacted({
      id: 'lead-1',
      by: 'user_abc',
      supabase: client,
    });
    expect(row).toEqual({ id: 'lead-1' });
    expect(recorded.updated[0]).toMatchObject({
      booking_status: 'contacted',
      contacted_by: 'user_abc',
    });
    expect(recorded.updated[0]).toHaveProperty('contacted_at');
  });

  it('returns null for an id that matched nothing', async () => {
    const { client } = fakeClient({ updatedRow: null });
    expect(
      await markCustomWorkLeadContacted({
        id: 'missing',
        by: 'user_abc',
        supabase: client,
      })
    ).toBeNull();
  });

  it('throws when the update fails, so the button does not lie', async () => {
    const { client } = fakeClient({ updateError: { message: 'down' } });
    await expect(
      markCustomWorkLeadContacted({
        id: 'lead-1',
        by: 'user_abc',
        supabase: client,
      })
    ).rejects.toBeTruthy();
  });
});
