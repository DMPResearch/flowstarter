// @vitest-environment node
/**
 * The rules behind "an enquiry from a client's site lands in that client's
 * workspace, and in nobody else's".
 *
 * Four things are defended here:
 *
 *  1. THE TOKEN. It is random, it is URL-safe, it is not the workspace id, and
 *     a minted one can never be mistaken for the preview shape the endpoint
 *     refuses. Rotation replaces it and leaves a ledger row.
 *  2. THE ORIGIN RULE. The set of origins a workspace answers to is derived
 *     from its own slug, its own claimed preview and its own hosts. A test
 *     that only asserted "the right origin passes" would pass for a rule that
 *     let everything through, so the wrong ones are asserted too.
 *  3. WHAT MAY BE STORED. Lengths and shapes by rule, a honeypot that is
 *     reported rather than rejected, and the spam classifier unchanged.
 *  4. TENANCY. Every write and every read goes through `withTenant`, so a lead
 *     carries the workspace it was captured for and a list carries nothing
 *     else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './fake-supabase';
import {
  LEAD_CAPTURE_TOKEN_PATTERN,
  PREVIEW_TOKEN_PREFIX,
  detectSpam,
  ensureLeadCaptureToken,
  insertLead,
  isLeadCaptureToken,
  isPreviewLeadCaptureToken,
  leadCaptureEndpoint,
  leadCaptureOrigins,
  listWorkspaceLeads,
  mintLeadCaptureToken,
  originAllowed,
  parseLeadCaptureBody,
  previewLeadCaptureToken,
  requestOrigin,
  resolveCaptureTenant,
  rotateLeadCaptureToken,
} from '../lead-capture';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';
const PREVIEW_ID = '3a5b7c9d-1e2f-4a3b-8c5d-6e7f8a9b0c1d';

const ENV = { PLATFORM_DOMAIN: 'flowstarter.test' };

const db = createFakeSupabase();
// The facade's types are per-table; the fake implements only the surface these
// functions use, which is the same trade the messaging tests make.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = db.client as any;

beforeEach(() => {
  db.reset();
  db.seed('workspaces', [
    {
      id: WORKSPACE_A,
      slug: 'salon-elena',
      client_email: 'elena@example.com',
      claimed_preview_id: PREVIEW_ID,
      lead_capture_token: 'a'.repeat(43),
    },
    {
      id: WORKSPACE_B,
      slug: 'halden-roe',
      client_email: null,
      claimed_preview_id: null,
      lead_capture_token: 'b'.repeat(43),
    },
  ]);
  db.seed('workspace_hosts', [
    { workspace_id: WORKSPACE_A, hostname: 'salonelena.ro' },
    { workspace_id: WORKSPACE_B, hostname: 'haldenroe.com' },
  ]);
});

// ── The token ──────────────────────────────────────────────────────────────

describe('the token', () => {
  it('is base64url and long enough to be unguessable', () => {
    const token = mintLeadCaptureToken();
    expect(token).toMatch(LEAD_CAPTURE_TOKEN_PATTERN);
    // 32 bytes in base64url with no padding.
    expect(token).toHaveLength(43);
  });

  it('is different every time', () => {
    const minted = new Set(
      Array.from({ length: 50 }, () => mintLeadCaptureToken())
    );
    expect(minted.size).toBe(50);
  });

  it('is never a workspace id', () => {
    expect(isLeadCaptureToken(WORKSPACE_A)).toBe(false);
  });

  it('refuses anything that is not base64url', () => {
    expect(isLeadCaptureToken('short')).toBe(false);
    expect(isLeadCaptureToken(`${'a'.repeat(42)}.`)).toBe(false);
    expect(isLeadCaptureToken(`${'a'.repeat(42)}/x`)).toBe(false);
    expect(isLeadCaptureToken(null)).toBe(false);
  });

  it('cannot collide with a preview token, by shape', () => {
    const preview = previewLeadCaptureToken(PREVIEW_ID);
    expect(preview.startsWith(PREVIEW_TOKEN_PREFIX)).toBe(true);
    expect(isPreviewLeadCaptureToken(preview)).toBe(true);
    // The dot is outside base64url, so no minted token can ever look like one.
    expect(PREVIEW_TOKEN_PREFIX).toContain('.');
    expect(isLeadCaptureToken(preview)).toBe(false);
  });

  it('builds one endpoint, whatever shape the host arrives in', () => {
    const expected = `https://flowstarter.net/api/leads/capture/${'a'.repeat(
      43
    )}`;
    expect(leadCaptureEndpoint('flowstarter.net', 'a'.repeat(43))).toBe(
      expected
    );
    expect(
      leadCaptureEndpoint('https://flowstarter.net/', 'a'.repeat(43))
    ).toBe(expected);
  });
});

describe('ensureLeadCaptureToken', () => {
  it('returns the stored token without writing', async () => {
    const before = db.rows('workspaces')[0]?.['lead_capture_token'];
    const capture = await ensureLeadCaptureToken(client, WORKSPACE_A);
    expect(capture?.token).toBe(before);
    expect(capture?.slug).toBe('salon-elena');
  });

  it('mints and stores one when the row has none', async () => {
    db.rows('workspaces')[0]!['lead_capture_token'] = null;
    const capture = await ensureLeadCaptureToken(client, WORKSPACE_A);
    expect(capture?.token).toMatch(LEAD_CAPTURE_TOKEN_PATTERN);
    expect(db.rows('workspaces')[0]?.['lead_capture_token']).toBe(
      capture?.token
    );
  });

  it('is null for a workspace that does not exist', async () => {
    expect(
      await ensureLeadCaptureToken(
        client,
        '11111111-2222-4333-8444-555555555555'
      )
    ).toBeNull();
  });
});

describe('rotateLeadCaptureToken', () => {
  it('replaces the token and records who did it', async () => {
    const before = db.rows('workspaces')[0]?.['lead_capture_token'];
    const rotated = await rotateLeadCaptureToken(client, {
      workspaceId: WORKSPACE_A,
      actor: 'user_client_a',
    });
    expect(rotated?.token).not.toBe(before);
    expect(rotated?.token).toMatch(LEAD_CAPTURE_TOKEN_PATTERN);
    expect(db.rows('workspaces')[0]?.['lead_capture_token']).toBe(
      rotated?.token
    );

    const event = db.rows('project_events')[0];
    expect(event?.['kind']).toBe('lead_capture_rotated');
    expect(event?.['workspace_id']).toBe(WORKSPACE_A);
    expect(event?.['actor']).toBe('user_client_a');
    // A public value is still not something to leave lying in a ledger row.
    expect(JSON.stringify(event)).not.toContain(rotated?.token);
  });

  it('leaves the other workspace alone', async () => {
    const other = db.rows('workspaces')[1]?.['lead_capture_token'];
    await rotateLeadCaptureToken(client, {
      workspaceId: WORKSPACE_A,
      actor: 'user_client_a',
    });
    expect(db.rows('workspaces')[1]?.['lead_capture_token']).toBe(other);
  });
});

// ── Resolving a tenant ─────────────────────────────────────────────────────

describe('resolveCaptureTenant', () => {
  it('finds the workspace and its own origins', async () => {
    const tenant = await resolveCaptureTenant(client, 'a'.repeat(43), {
      env: ENV,
    });
    expect(tenant?.workspaceId).toBe(WORKSPACE_A);
    expect(tenant?.origins).toContain('https://salon-elena.flowstarter.test');
    expect(tenant?.origins).toContain('https://salonelena.ro');
    expect(tenant?.origins).toContain(
      `https://${PREVIEW_ID}.preview.flowstarter.test`
    );
    // And nothing belonging to anybody else.
    expect(tenant?.origins).not.toContain('https://haldenroe.com');
  });

  it('is null for an unknown token', async () => {
    expect(
      await resolveCaptureTenant(client, 'z'.repeat(43), { env: ENV })
    ).toBeNull();
  });

  it('is null for a token that is not base64url, without querying', async () => {
    expect(await resolveCaptureTenant(client, 'nope', { env: ENV })).toBeNull();
  });
});

// ── The origin rule ────────────────────────────────────────────────────────

describe('leadCaptureOrigins', () => {
  it('is https only', () => {
    const origins = leadCaptureOrigins(
      { slug: 'salon-elena', customHostnames: ['salonelena.ro'] },
      { env: ENV }
    );
    expect(origins.every((origin) => origin.startsWith('https://'))).toBe(true);
  });

  it('drops duplicates and lowercases custom hosts', () => {
    const origins = leadCaptureOrigins(
      {
        slug: 'salon-elena',
        customHostnames: ['SalonElena.ro', 'salonelena.ro', '  '],
      },
      { env: ENV }
    );
    expect(origins.filter((o) => o === 'https://salonelena.ro')).toHaveLength(
      1
    );
  });

  it('yields no origin at all for a slug that cannot make a hostname', () => {
    expect(leadCaptureOrigins({ slug: 'NOT A LABEL' }, { env: ENV })).toEqual(
      []
    );
  });
});

describe('requestOrigin and originAllowed', () => {
  const headers = (values: Record<string, string>) => ({
    get: (name: string) => values[name.toLowerCase()] ?? null,
  });

  it('prefers the Origin header', () => {
    expect(
      requestOrigin(
        headers({
          origin: 'https://salonelena.ro',
          referer: 'https://evil.example/x',
        })
      )
    ).toBe('https://salonelena.ro');
  });

  it('falls back to the referer, reduced to its origin', () => {
    expect(
      requestOrigin(headers({ referer: 'https://salonelena.ro/contact?a=1' }))
    ).toBe('https://salonelena.ro');
  });

  it('is null with neither, and for a literal "null" origin', () => {
    expect(requestOrigin(headers({}))).toBeNull();
    expect(requestOrigin(headers({ origin: 'null' }))).toBeNull();
    expect(requestOrigin(headers({ origin: 'not a url' }))).toBeNull();
  });

  it('refuses an origin that is not the workspace own', () => {
    const allowed = ['https://salonelena.ro'];
    expect(originAllowed('https://salonelena.ro', allowed)).toBe(true);
    expect(originAllowed('https://salonelena.ro.evil.example', allowed)).toBe(
      false
    );
    expect(originAllowed('http://salonelena.ro', allowed)).toBe(false);
    expect(originAllowed(null, allowed)).toBe(false);
    expect(originAllowed('https://salonelena.ro', [])).toBe(false);
  });
});

// ── The body ───────────────────────────────────────────────────────────────

describe('parseLeadCaptureBody', () => {
  const good = {
    name: 'Elena Popescu',
    email: 'elena@salon.ro',
    message: 'Doresc o programare pentru vineri',
  };

  it('accepts the three required fields', () => {
    const result = parseLeadCaptureBody(good);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.phone).toBeNull();
      expect(result.body.page).toBeNull();
      expect(result.body.honeypot).toBe(false);
    }
  });

  it('trims and keeps the optional fields', () => {
    const result = parseLeadCaptureBody({
      ...good,
      phone: ' +40 712 345 678 ',
      page: '/contact',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.phone).toBe('+40 712 345 678');
      expect(result.body.page).toBe('/contact');
    }
  });

  it('refuses a missing name, email or message with a sentence', () => {
    expect(parseLeadCaptureBody({ ...good, name: '  ' })).toEqual({
      ok: false,
      message: 'Add your name.',
    });
    expect(parseLeadCaptureBody({ ...good, email: '' })).toEqual({
      ok: false,
      message: 'Add an email address.',
    });
    expect(parseLeadCaptureBody({ ...good, message: '' })).toEqual({
      ok: false,
      message: 'Add a message.',
    });
  });

  it('refuses an address that is not one', () => {
    const result = parseLeadCaptureBody({ ...good, email: 'not-an-email' });
    expect(result.ok).toBe(false);
  });

  it('refuses anything over its limit', () => {
    expect(parseLeadCaptureBody({ ...good, name: 'a'.repeat(201) }).ok).toBe(
      false
    );
    expect(
      parseLeadCaptureBody({ ...good, message: 'a'.repeat(5001) }).ok
    ).toBe(false);
    expect(parseLeadCaptureBody({ ...good, phone: '0'.repeat(51) }).ok).toBe(
      false
    );
  });

  it('truncates an over-long page rather than refusing the enquiry', () => {
    const result = parseLeadCaptureBody({ ...good, page: '/'.repeat(400) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.page).toHaveLength(300);
  });

  it('reports the honeypot rather than refusing, so the caller can decide', () => {
    const result = parseLeadCaptureBody({
      ...good,
      company_website: 'http://spam.example',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.honeypot).toBe(true);
  });

  it('refuses a body that is not an object', () => {
    expect(parseLeadCaptureBody(null).ok).toBe(false);
    expect(parseLeadCaptureBody('hello').ok).toBe(false);
    expect(parseLeadCaptureBody([good]).ok).toBe(false);
  });
});

// ── Spam ───────────────────────────────────────────────────────────────────

describe('detectSpam', () => {
  it('marks obvious spam with more than one pattern', () => {
    expect(
      detectSpam('Casino King', 'spam@test.com', 'Buy cheap viagra now!')
    ).toBe(true);
    expect(
      detectSpam('', '', 'Click here https://evil.example buy now free money')
    ).toBe(true);
  });

  it('leaves a real Romanian enquiry alone', () => {
    expect(
      detectSpam(
        'Elena Popescu',
        'elena@salon.ro',
        'Doresc o programare pentru vineri'
      )
    ).toBe(false);
  });

  it('does not fire on one pattern alone', () => {
    expect(
      detectSpam('John', 'john@gmail.com', 'I want to buy your service')
    ).toBe(false);
  });
});

// ── The write and the read ─────────────────────────────────────────────────

describe('insertLead', () => {
  const body = {
    name: 'Elena',
    email: 'elena@salon.ro',
    message: 'Hello',
    phone: '+40712',
    page: '/contact',
    honeypot: false,
  };

  it('writes the lead into the workspace it was captured for', async () => {
    const lead = await insertLead(client, {
      workspaceId: WORKSPACE_A,
      body,
      ip: '1.2.3.4',
      userAgent: 'test',
      referrer: 'https://salonelena.ro/contact',
    });
    expect(lead.status).toBe('new');

    const row = db.rows('leads')[0];
    expect(row?.['workspace_id']).toBe(WORKSPACE_A);
    expect(row?.['email']).toBe('elena@salon.ro');
    expect(row?.['source']).toBe('/contact');
    expect(row?.['status']).toBe('new');
  });

  it('stores spam as spam rather than dropping it', async () => {
    const lead = await insertLead(client, {
      workspaceId: WORKSPACE_A,
      body: {
        ...body,
        name: 'Casino King',
        message: 'Buy cheap viagra now https://evil.example',
      },
      ip: null,
      userAgent: null,
      referrer: null,
    });
    expect(lead.status).toBe('spam');
    expect(db.rows('leads')[0]?.['status']).toBe('spam');
  });
});

describe('listWorkspaceLeads', () => {
  beforeEach(() => {
    db.seed('leads', [
      {
        id: 'lead-a1',
        workspace_id: WORKSPACE_A,
        name: 'Elena',
        email: 'elena@salon.ro',
        phone: null,
        message: 'Hello',
        source: '/contact',
        status: 'new',
        created_at: '2026-09-01T10:00:00.000Z',
      },
      {
        id: 'lead-a2',
        workspace_id: WORKSPACE_A,
        name: 'Casino',
        email: 'spam@evil.example',
        phone: null,
        message: 'Buy now',
        source: null,
        status: 'spam',
        created_at: '2026-09-02T10:00:00.000Z',
      },
      {
        id: 'lead-b1',
        workspace_id: WORKSPACE_B,
        name: 'Someone else',
        email: 'other@example.com',
        phone: null,
        message: 'Not yours',
        source: null,
        status: 'new',
        created_at: '2026-09-03T10:00:00.000Z',
      },
    ]);
  });

  it('hides spam by default and never crosses a tenant', async () => {
    const leads = await listWorkspaceLeads(client, WORKSPACE_A);
    expect(leads.map((lead) => lead.id)).toEqual(['lead-a1']);
  });

  it('includes spam when asked, still within the one workspace', async () => {
    const leads = await listWorkspaceLeads(client, WORKSPACE_A, {
      includeSpam: true,
    });
    expect(leads.map((lead) => lead.id)).toEqual(['lead-a2', 'lead-a1']);
  });

  it('is newest first', async () => {
    const leads = await listWorkspaceLeads(client, WORKSPACE_A, {
      includeSpam: true,
    });
    expect(leads[0]?.createdAt > leads[1]!.createdAt).toBe(true);
  });
});
