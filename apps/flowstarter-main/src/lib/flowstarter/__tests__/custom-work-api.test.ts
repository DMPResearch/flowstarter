/**
 * The operator handlers. Both are operator-only and neither takes an id on
 * trust.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));

const auth = { authorized: true, userId: 'user_operator', role: 'admin' };
vi.mock('@/lib/api-auth', () => ({
  requireTeamAuth: async () =>
    auth.authorized
      ? auth
      : {
          authorized: false,
          response: NextResponse.json(
            { error: 'Unauthorized' },
            { status: 401 }
          ),
        },
}));

const listCustomWorkLeads = vi.fn();
const markCustomWorkLeadContacted = vi.fn();
vi.mock('../custom-work-leads', () => ({
  listCustomWorkLeads: (...args: unknown[]) => listCustomWorkLeads(...args),
  markCustomWorkLeadContacted: (...args: unknown[]) =>
    markCustomWorkLeadContacted(...args),
}));

import {
  customWorkLaneHandler,
  markContactedHandler,
} from '../custom-work-api';

const UUID = '11111111-1111-4111-8111-111111111111';

const ROW = {
  id: UUID,
  name: 'Sarah Smith',
  email: 'sarah@example.com',
  description: 'A portal my customers log into',
  link_url: null,
  link_title: null,
  clarification: null,
  scope: 'custom',
  scope_confidence: 0.9,
  scope_evidence: ['log into'],
  classifier: 'llm:test',
  route: 'discovery-call',
  route_rule: 'customAboveThreshold',
  acceptable_use: null,
  source: 'funnel',
  booking_status: 'offered',
  booking_reference: null,
  contacted_at: null,
  contacted_by: null,
  confirmation_sent_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const req = () =>
  new NextRequest('https://flowstarter.net/api/admin/custom-work-leads', {
    method: 'POST',
  });

beforeEach(() => {
  auth.authorized = true;
  listCustomWorkLeads.mockReset();
  markCustomWorkLeadContacted.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('customWorkLaneHandler', () => {
  it('returns the lane, never cached', async () => {
    listCustomWorkLeads.mockResolvedValue([ROW]);
    const res = await customWorkLaneHandler();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const json = await res.json();
    expect(json.total).toBe(1);
    expect(json.cards[0].evidence).toEqual(['log into']);
  });

  it('refuses anybody who is not an operator', async () => {
    auth.authorized = false;
    expect((await customWorkLaneHandler()).status).toBe(401);
    expect(listCustomWorkLeads).not.toHaveBeenCalled();
  });

  it('says it could not load rather than showing an empty lane', async () => {
    listCustomWorkLeads.mockRejectedValue(new Error('database is down'));
    expect((await customWorkLaneHandler()).status).toBe(500);
  });
});

describe('markContactedHandler', () => {
  it('stamps the lead with the operator who pressed it', async () => {
    markCustomWorkLeadContacted.mockResolvedValue({
      ...ROW,
      booking_status: 'contacted',
      contacted_at: new Date().toISOString(),
      contacted_by: 'user_operator',
    });
    const res = await markContactedHandler(req(), ctx(UUID));
    expect(res.status).toBe(200);
    expect(markCustomWorkLeadContacted).toHaveBeenCalledWith({
      id: UUID,
      by: 'user_operator',
    });
    expect((await res.json()).lead.contacted).toBe(true);
  });

  it('refuses anybody who is not an operator', async () => {
    auth.authorized = false;
    expect((await markContactedHandler(req(), ctx(UUID))).status).toBe(401);
    expect(markCustomWorkLeadContacted).not.toHaveBeenCalled();
  });

  it('refuses an id that is not one', async () => {
    for (const bad of ['../../etc', 'lead-1', '', 'x'.repeat(40)]) {
      expect((await markContactedHandler(req(), ctx(bad))).status).toBe(400);
    }
    expect(markCustomWorkLeadContacted).not.toHaveBeenCalled();
  });

  it('is a 404 when the id matched nothing', async () => {
    markCustomWorkLeadContacted.mockResolvedValue(null);
    expect((await markContactedHandler(req(), ctx(UUID))).status).toBe(404);
  });

  it('is a 500 when the update itself failed', async () => {
    markCustomWorkLeadContacted.mockRejectedValue(new Error('down'));
    expect((await markContactedHandler(req(), ctx(UUID))).status).toBe(500);
  });
});
