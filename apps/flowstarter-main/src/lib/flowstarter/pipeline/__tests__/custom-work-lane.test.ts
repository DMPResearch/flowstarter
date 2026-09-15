/**
 * The lane builder: pure, rows in and cards out, with `now` supplied.
 */
import { describe, expect, it } from 'vitest';
import type { CustomWorkLeadRow } from '@/lib/flowstarter/custom-work-leads';
import {
  CUSTOM_WORK_REPLY_WINDOW_MS,
  buildCustomWorkLane,
  toCustomWorkCard,
} from '../custom-work-lane';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function row(overrides: Partial<CustomWorkLeadRow> = {}): CustomWorkLeadRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Sarah Smith',
    email: 'sarah@example.com',
    description: 'A portal my customers log into',
    link_url: 'https://acme.example.com',
    link_title: 'Acme - Client Portal Login',
    clarification: null,
    scope: 'custom',
    scope_confidence: 0.94,
    scope_evidence: ['customers log into', 'portal'],
    classifier: 'llm:2026-09-14.1',
    route: 'discovery-call',
    route_rule: 'customAboveThreshold',
    acceptable_use: null,
    source: 'funnel',
    booking_status: 'offered',
    booking_reference: null,
    contacted_at: null,
    contacted_by: null,
    confirmation_sent_at: '2026-09-14T11:00:00.000Z',
    created_at: '2026-09-14T11:00:00.000Z',
    updated_at: '2026-09-14T11:00:00.000Z',
    ...overrides,
  };
}

describe('toCustomWorkCard', () => {
  it('carries the brief, the evidence and the rule that routed it', () => {
    const card = toCustomWorkCard(row(), NOW);
    expect(card).toMatchObject({
      name: 'Sarah Smith',
      email: 'sarah@example.com',
      description: 'A portal my customers log into',
      scope: 'custom',
      confidence: 0.94,
      evidence: ['customers log into', 'portal'],
      classifier: 'llm:2026-09-14.1',
      routeRule: 'customAboveThreshold',
      contacted: false,
    });
    expect(card.waitingFor).toBe('1h');
  });

  it('flags a lead nobody has replied to inside the window', () => {
    const stale = row({
      created_at: new Date(
        NOW - CUSTOM_WORK_REPLY_WINDOW_MS - 1000
      ).toISOString(),
    });
    expect(toCustomWorkCard(stale, NOW).needsAttention).toBe(true);
    expect(toCustomWorkCard(row(), NOW).needsAttention).toBe(false);
  });

  it('stops flagging one that has been answered, however long ago', () => {
    const old = new Date(NOW - 30 * 24 * 60 * 60_000).toISOString();
    for (const status of ['contacted', 'booked', 'closed']) {
      const card = toCustomWorkCard(
        row({ created_at: old, booking_status: status }),
        NOW
      );
      expect(card.needsAttention).toBe(false);
    }
    // ... but an untouched one from a month ago is still shouting.
    expect(toCustomWorkCard(row({ created_at: old }), NOW).needsAttention).toBe(
      true
    );
  });

  it('says whether the branded confirmation actually reached them', () => {
    expect(toCustomWorkCard(row(), NOW).confirmationSentAt).not.toBeNull();
    expect(
      toCustomWorkCard(row({ confirmation_sent_at: null }), NOW)
        .confirmationSentAt
    ).toBeNull();
  });

  it('survives evidence that is not an array of strings', () => {
    for (const junk of [null, 'a string', 42, [1, 2, {}], undefined]) {
      expect(
        toCustomWorkCard(
          row({ scope_evidence: junk as CustomWorkLeadRow['scope_evidence'] }),
          NOW
        ).evidence
      ).toEqual([]);
    }
  });

  it('drops a stored fragment that is not actually in the brief', () => {
    // The defensive half of the fix for #191: the classifiers no longer
    // write a reason code into `scope_evidence`, but a row written before
    // that fix keeps whatever it was written with, and a future bug could
    // reintroduce the same shape. This card must never show a fragment that
    // is not the visitor's own words, no matter which write path produced
    // the row.
    const card = toCustomWorkCard(
      row({
        description: 'A portal my customers log into',
        scope_evidence: [
          'confident:scope:custom-work:semantic',
          'customers log into',
        ],
      }),
      NOW
    );
    expect(card.evidence).toEqual(['customers log into']);
  });

  it('is empty, not the reason code, when nothing stored survives the brief check', () => {
    const card = toCustomWorkCard(
      row({
        description: 'A portal my customers log into',
        scope_evidence: ['confident:scope:custom-work:semantic'],
      }),
      NOW
    );
    expect(card.evidence).toEqual([]);
  });

  it('reads `contacted` from the timestamp, not from the status alone', () => {
    const card = toCustomWorkCard(
      row({
        booking_status: 'contacted',
        contacted_at: '2026-09-14T11:30:00.000Z',
        contacted_by: 'user_abc',
      }),
      NOW
    );
    expect(card.contacted).toBe(true);
    expect(card.contactedBy).toBe('user_abc');
  });
});

describe('buildCustomWorkLane', () => {
  it('sorts newest first and counts the ones still waiting', () => {
    const lane = buildCustomWorkLane({
      leads: [
        row({
          id: '22222222-2222-4222-8222-222222222222',
          created_at: '2026-09-14T09:00:00.000Z',
        }),
        row({
          id: '33333333-3333-4333-8333-333333333333',
          created_at: '2026-09-14T11:30:00.000Z',
        }),
        row({
          id: '44444444-4444-4444-8444-444444444444',
          created_at: '2026-09-14T10:00:00.000Z',
          contacted_at: '2026-09-14T10:30:00.000Z',
          booking_status: 'contacted',
        }),
      ],
      now: NOW,
    });

    expect(lane.cards.map((card) => card.id)).toEqual([
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(lane.total).toBe(3);
    // The contacted one stays in the lane and stops being counted.
    expect(lane.waitingCount).toBe(2);
  });

  it('is empty rather than absent when nobody has asked for custom work', () => {
    expect(buildCustomWorkLane({ leads: [], now: NOW })).toEqual({
      cards: [],
      total: 0,
      waitingCount: 0,
    });
  });
});
