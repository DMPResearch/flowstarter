/**
 * GET / PATCH / DELETE /api/{team,admin}/projects/[id].
 *
 * PATCH is the only place an operator can move a project's price, and the
 * value it writes is the one the deposit Checkout and the 20% webhook check
 * read, so every field it accepts is validated here rather than at the
 * database. The two trees are the same handler twice; both are exercised.
 *
 * Clerk and `@supabase/supabase-js` are mocked. Everything else is real,
 * including `requireTeamAuth` and the quote parser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  createFakeSupabase,
  failures,
  resetFakeSupabase,
  rowsOf,
  seed,
  type Row,
} from '../../__tests__/_support/fake-supabase';

vi.mock('server-only', () => ({}));

// ─── Clerk ──────────────────────────────────────────────────────────────────
const authState = vi.hoisted(() => ({
  userId: 'user_operator' as string | null,
  role: 'team' as string | undefined,
  throwOnAuth: false,
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => {
    if (authState.throwOnAuth) throw new Error('clerk unreachable');
    return {
      userId: authState.userId,
      sessionClaims: authState.role
        ? { metadata: { role: authState.role } }
        : {},
      getToken: async () => 'test-token',
    };
  },
  currentUser: async () => null,
  clerkClient: async () => ({
    users: {
      getUser: async () => ({
        publicMetadata: {},
        emailAddresses: [{ id: 'idn_1', emailAddress: 'client@gmail.com' }],
        primaryEmailAddressId: 'idn_1',
      }),
    },
  }),
}));

// ─── Supabase ───────────────────────────────────────────────────────────────
const clientState = vi.hoisted(() => ({ ctorError: null as unknown }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    if (clientState.ctorError) throw clientState.ctorError;
    return buildFake();
  },
}));

function buildFake() {
  return createFakeSupabase();
}

import {
  DELETE as teamDelete,
  GET as teamGet,
  PATCH as teamPatch,
} from '../route';
import {
  DELETE as adminDelete,
  GET as adminGet,
  PATCH as adminPatch,
} from '../../../../admin/projects/[id]/route';

// ─── Helpers ────────────────────────────────────────────────────────────────
const WORKSPACE_ID = '4f9c1a3e-0b7d-4a52-9c31-2f8e6d5b7a01';
const OTHER_WORKSPACE_ID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

type Ctx = { params: Promise<{ id: string }> };

function ctx(id = WORKSPACE_ID): Ctx {
  return { params: Promise.resolve({ id }) };
}

function req(body?: unknown): NextRequest {
  return {
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON');
      return body;
    },
  } as unknown as NextRequest;
}

function seedWorkspaces() {
  seed(
    'workspaces',
    {
      id: WORKSPACE_ID,
      name: 'Acme Coaching',
      slug: 'acme-coaching',
      client_name: 'Ana Pop',
      client_email: 'ana@acme.test',
      client_phone: null,
      client_business_name: 'Acme Coaching',
      concierge_stage: 'intake',
      site_kind: 'astro',
      setup_fee: 799,
      final_value_minor: 79900,
      monthly_fee: 49,
      is_founding: false,
      tier_name: 'essential',
      billing_interval: 'monthly',
      commerce_mode: 'none',
      commerce_product_count: 0,
      commerce_requirements: {},
      commerce_notes: null,
    },
    {
      id: OTHER_WORKSPACE_ID,
      name: 'Another tenant',
      slug: 'another-tenant',
      setup_fee: 1500,
      final_value_minor: 150000,
    }
  );
}

function workspace(id = WORKSPACE_ID): Row | undefined {
  return rowsOf('workspaces').find((row) => row.id === id);
}

type Handler = (request: NextRequest, context: Ctx) => Promise<Response>;

const HANDLERS: Array<[string, Handler]> = [
  ['team GET', teamGet as Handler],
  ['team PATCH', teamPatch as Handler],
  ['team DELETE', teamDelete as Handler],
  ['admin GET', adminGet as Handler],
  ['admin PATCH', adminPatch as Handler],
  ['admin DELETE', adminDelete as Handler],
];

const GETS: Array<[string, Handler]> = [
  ['team', teamGet as Handler],
  ['admin', adminGet as Handler],
];
const PATCHES: Array<[string, Handler]> = [
  ['team', teamPatch as Handler],
  ['admin', adminPatch as Handler],
];
const DELETES: Array<[string, Handler]> = [
  ['team', teamDelete as Handler],
  ['admin', adminDelete as Handler],
];

beforeEach(() => {
  resetFakeSupabase();
  authState.userId = 'user_operator';
  authState.role = 'team';
  authState.throwOnAuth = false;
  clientState.ctorError = null;
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('/api/{team,admin}/projects/[id] — who may call it', () => {
  it.each(HANDLERS)(
    '%s refuses an unauthenticated caller with 401',
    async (_name, handler) => {
      authState.userId = null;
      seedWorkspaces();

      const res = await handler(req({ name: 'Renamed' }), ctx());
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
      // Nothing was read and nothing was written.
      expect(workspace()?.name).toBe('Acme Coaching');
    }
  );

  it.each(HANDLERS)(
    '%s refuses a signed-in caller who is not an operator with 403',
    async (_name, handler) => {
      // The workspace's own client, asking about their own workspace: these
      // endpoints are operator-only, so the answer is still no.
      authState.userId = 'user_plain_client';
      authState.role = undefined;
      seedWorkspaces();

      const res = await handler(req({ name: 'Renamed' }), ctx());
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
      expect(workspace()?.name).toBe('Acme Coaching');
    }
  );

  it.each(HANDLERS)(
    '%s fails closed when Clerk is unreachable',
    async (_name, handler) => {
      authState.throwOnAuth = true;
      seedWorkspaces();

      const res = await handler(req({ name: 'Renamed' }), ctx());
      expect(res.status).toBe(500);
      expect(workspace()?.name).toBe('Acme Coaching');
    }
  );
});

describe('GET /api/{team,admin}/projects/[id]', () => {
  it.each(GETS)(
    '%s returns any workspace, member or not',
    async (_tree, handler) => {
      seedWorkspaces();

      const res = await handler(req(), ctx(OTHER_WORKSPACE_ID));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project).toMatchObject({
        id: OTHER_WORKSPACE_ID,
        name: 'Another tenant',
      });
    }
  );

  it.each(GETS)(
    '%s answers 404 for an id that does not exist',
    async (_tree, handler) => {
      seedWorkspaces();

      const res = await handler(
        req(),
        ctx('11111111-2222-4333-8444-555555555555')
      );
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'Project not found' });
    }
  );

  it.each(GETS)(
    '%s returns a generic 500 when the client cannot be built',
    async (_tree, handler) => {
      clientState.ctorError = new Error(
        'supabaseKey is required: sk_secret_abc'
      );

      const res = await handler(req(), ctx());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to fetch project');
      expect(JSON.stringify(body)).not.toMatch(/sk_secret_abc/);
    }
  );
});

describe('DELETE /api/{team,admin}/projects/[id]', () => {
  it.each(DELETES)(
    '%s deletes only the workspace named in the path',
    async (_tree, handler) => {
      seedWorkspaces();

      const res = await handler(req(), ctx());
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true });
      expect(workspace()).toBeUndefined();
      expect(workspace(OTHER_WORKSPACE_ID)).toBeDefined();
    }
  );

  it.each(DELETES)(
    '%s answers 404 rather than deleting nothing quietly',
    async (_tree, handler) => {
      seedWorkspaces();

      const res = await handler(
        req(),
        ctx('11111111-2222-4333-8444-555555555555')
      );
      expect(res.status).toBe(404);
      expect(rowsOf('workspaces')).toHaveLength(2);
    }
  );

  it.each(DELETES)(
    '%s returns 500 without leaking credentials when the delete fails',
    async (_tree, handler) => {
      seedWorkspaces();
      failures['workspaces:delete'] = {
        message: 'update or delete on table "workspaces" violates foreign key',
      };

      const res = await handler(req(), ctx());
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|eyJ/);
      expect(workspace()).toBeDefined();
    }
  );

  it.each(DELETES)(
    '%s returns a generic 500 when the client cannot be built',
    async (_tree, handler) => {
      clientState.ctorError = new Error(
        'supabaseKey is required: sk_secret_abc'
      );

      const res = await handler(req(), ctx());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to delete project');
      expect(JSON.stringify(body)).not.toMatch(/sk_secret_abc/);
    }
  );
});

describe('PATCH /api/{team,admin}/projects/[id] — the money fields', () => {
  it.each(PATCHES)(
    '%s stores the typed price in minor units and mirrors it',
    async (_tree, handler) => {
      seedWorkspaces();

      const res = await handler(req({ setup_fee: '1999,50' }), ctx());
      expect(res.status).toBe(200);
      const body = await res.json();
      // final_value_minor is what the deposit Checkout reads; setup_fee stays
      // the readable mirror in euros.
      expect(body.project).toMatchObject({
        final_value_minor: 199950,
        setup_fee: 1999.5,
      });
    }
  );

  it.each(PATCHES)(
    '%s refuses a price that is not a number',
    async (_tree, handler) => {
      seedWorkspaces();

      const res = await handler(req({ setup_fee: 'about two grand' }), ctx());
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'Project value must be a number',
      });
      expect(workspace()?.final_value_minor).toBe(79900);
    }
  );

  it.each(PATCHES)('%s refuses a negative price', async (_tree, handler) => {
    seedWorkspaces();

    const res = await handler(req({ setup_fee: -1 }), ctx());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Project value cannot be negative',
    });
  });

  it.each(PATCHES)(
    '%s refuses a price above the allowed maximum',
    async (_tree, handler) => {
      seedWorkspaces();

      const res = await handler(req({ setup_fee: 1_000_000 }), ctx());
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'Project value is above the allowed maximum',
      });
    }
  );

  it.each(PATCHES)(
    '%s coerces an unusable monthly_fee to zero rather than storing NaN',
    async (_tree, handler) => {
      seedWorkspaces();

      const res = await handler(req({ monthly_fee: 'free' }), ctx());
      expect(res.status).toBe(200);
      expect(workspace()?.monthly_fee).toBe(0);

      await handler(req({ monthly_fee: '129' }), ctx());
      expect(workspace()?.monthly_fee).toBe(129);
    }
  );

  it.each(PATCHES)(
    '%s writes is_founding as a boolean',
    async (_tree, handler) => {
      seedWorkspaces();

      await handler(req({ is_founding: 'yes' }), ctx());
      expect(workspace()?.is_founding).toBe(true);
    }
  );
});

describe.each(PATCHES)(
  'PATCH /api/%s/projects/[id] — the text fields',
  (_tree, handler) => {
    beforeEach(seedWorkspaces);

    it('trims a new name and refuses an empty one', async () => {
      const ok = await handler(req({ name: '  Acme Studio  ' }), ctx());
      expect(ok.status).toBe(200);
      expect(workspace()?.name).toBe('Acme Studio');

      for (const bad of ['   ', 42]) {
        const res = await handler(req({ name: bad }), ctx());
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
          error: 'Name cannot be empty',
        });
      }
      expect(workspace()?.name).toBe('Acme Studio');
    });

    it('trims client contact details and clears them when blanked', async () => {
      await handler(
        req({
          client_name: '  Ana Pop  ',
          client_email: ' ana@acme.test ',
          client_phone: ' +40 700 000 000 ',
          client_business_name: ' Acme Coaching SRL ',
        }),
        ctx()
      );
      expect(workspace()).toMatchObject({
        client_name: 'Ana Pop',
        client_email: 'ana@acme.test',
        client_phone: '+40 700 000 000',
        client_business_name: 'Acme Coaching SRL',
      });

      await handler(
        req({
          client_name: '',
          client_email: '   ',
          client_phone: null,
          client_business_name: 7,
        }),
        ctx()
      );
      expect(workspace()).toMatchObject({
        client_name: null,
        client_email: null,
        client_phone: null,
        client_business_name: null,
      });
    });

    it('trims commerce notes and clears them when blanked', async () => {
      await handler(req({ commerce_notes: '  Ships from Cluj  ' }), ctx());
      expect(workspace()?.commerce_notes).toBe('Ships from Cluj');

      await handler(req({ commerce_notes: '  ' }), ctx());
      expect(workspace()?.commerce_notes).toBeNull();
    });

    it('requires commerce_requirements to be a plain object', async () => {
      for (const bad of [['S', 'M'], 'sizes', null]) {
        const res = await handler(req({ commerce_requirements: bad }), ctx());
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
          error: 'commerce_requirements must be an object',
        });
      }

      const ok = await handler(
        req({ commerce_requirements: { sizes: ['S', 'M'] } }),
        ctx()
      );
      expect(ok.status).toBe(200);
      expect(workspace()?.commerce_requirements).toEqual({ sizes: ['S', 'M'] });
    });
  }
);

describe.each(PATCHES)(
  'PATCH /api/%s/projects/[id] — the enum fields',
  (_tree, handler) => {
    beforeEach(seedWorkspaces);

    it('accepts every enum the dashboard can send', async () => {
      const res = await handler(
        req({
          site_kind: 'shopify_liquid',
          concierge_stage: 'client_review',
          tier_name: 'commerce',
          billing_interval: 'annual',
          commerce_mode: 'managed_storefront',
          commerce_product_type: 'physical',
          commerce_provider: 'shopify',
          commerce_status: 'configured',
          commerce_product_count: '12.9',
        }),
        ctx()
      );

      expect(res.status).toBe(200);
      expect(workspace()).toMatchObject({
        site_kind: 'shopify_liquid',
        concierge_stage: 'client_review',
        tier_name: 'commerce',
        billing_interval: 'annual',
        commerce_mode: 'managed_storefront',
        commerce_product_type: 'physical',
        commerce_provider: 'shopify',
        commerce_status: 'configured',
        commerce_product_count: 12,
      });
    });

    it.each([
      ['site_kind', 'wordpress'],
      ['concierge_stage', 'shipped'],
      ['tier_name', 'enterprise'],
      ['billing_interval', 'weekly'],
      ['commerce_mode', 'barter'],
      ['commerce_product_type', 'vapourware'],
      ['commerce_provider', 'paypal'],
      ['commerce_status', 'maybe'],
    ])(
      'refuses an unknown %s with 400 and writes nothing',
      async (field, value) => {
        const res = await handler(req({ [field]: value }), ctx());
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
          error: `Invalid ${field}`,
        });
        expect(workspace()?.concierge_stage).toBe('intake');
      }
    );

    it.each([
      ['site_kind', 42],
      ['commerce_mode', { mode: 'none' }],
    ])('refuses a non-string %s with 400', async (field, value) => {
      const res = await handler(req({ [field]: value }), ctx());
      expect(res.status).toBe(400);
    });

    it('clears tier_name when it is explicitly nulled or blanked', async () => {
      await handler(req({ tier_name: null }), ctx());
      expect(workspace()?.tier_name).toBeNull();

      await handler(req({ tier_name: 'pro' }), ctx());
      await handler(req({ tier_name: '' }), ctx());
      expect(workspace()?.tier_name).toBeNull();
    });

    it('refuses a negative or unparseable commerce_product_count', async () => {
      for (const bad of [-1, 'a dozen']) {
        const res = await handler(req({ commerce_product_count: bad }), ctx());
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
          error: 'commerce_product_count must be a non-negative number',
        });
      }
      expect(workspace()?.commerce_product_count).toBe(0);
    });
  }
);

describe('PATCH /api/{team,admin}/projects/[id] — persistence', () => {
  it.each(PATCHES)(
    '%s touches only the workspace in the path',
    async (_tree, handler) => {
      seedWorkspaces();

      await handler(req({ name: 'Renamed' }), ctx());
      expect(workspace()?.name).toBe('Renamed');
      expect(workspace(OTHER_WORKSPACE_ID)?.name).toBe('Another tenant');
    }
  );

  it.each(PATCHES)(
    '%s stamps updated_at on every accepted patch',
    async (_tree, handler) => {
      seedWorkspaces();

      await handler(req({ name: 'Renamed' }), ctx());
      expect(String(workspace()?.updated_at)).toMatch(
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/
      );
    }
  );

  it.each(PATCHES)(
    '%s returns 500 without leaking credentials when the update fails',
    async (_tree, handler) => {
      seedWorkspaces();
      failures['workspaces:update'] = {
        message: 'permission denied for table workspaces',
      };

      const res = await handler(req({ name: 'Renamed' }), ctx());
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|eyJ/);
    }
  );

  it.each(PATCHES)(
    '%s answers a body that is not JSON with a 500 (see report)',
    async (_tree, handler) => {
      // Documented divergence, not an endorsement: PATCH calls `request.json()`
      // without the `.catch(() => ({}))` its sibling handlers use, so a
      // malformed body lands in the catch-all and reads as a server fault
      // rather than the 400 it is. Pinned so the behaviour cannot drift
      // unnoticed; the fix belongs in the handler.
      seedWorkspaces();

      const res = await handler(req(), ctx());
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({
        error: 'Failed to update project',
      });
      expect(workspace()?.name).toBe('Acme Coaching');
    }
  );
});
