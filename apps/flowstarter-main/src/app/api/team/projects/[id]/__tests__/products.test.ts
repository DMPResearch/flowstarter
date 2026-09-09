/**
 * The commerce catalogue endpoints, in both trees:
 *
 *   GET  /api/{team,admin}/projects/[id]/products
 *   POST /api/{team,admin}/projects/[id]/products
 *   PATCH  /api/{team,admin}/projects/[id]/products/[productId]
 *   DELETE /api/{team,admin}/projects/[id]/products/[productId]
 *
 * These write rows another tenant pays for, with the service-role key, so the
 * `workspace_id` filter on every statement is the isolation. The fake client
 * honours `.eq()`, so a handler that dropped that filter would reach the other
 * workspace's product here and the test would fail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  createFakeSupabase,
  failures,
  nullData,
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
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: authState.role ? { metadata: { role: authState.role } } : {},
    getToken: async () => 'test-token',
  }),
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
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => buildFake(),
}));

function buildFake() {
  return createFakeSupabase();
}

import { GET as teamList, POST as teamCreate } from '../products/route';
import {
  GET as adminList,
  POST as adminCreate,
} from '../../../../admin/projects/[id]/products/route';
import {
  DELETE as teamDelete,
  PATCH as teamPatch,
} from '../products/[productId]/route';
import {
  DELETE as adminDelete,
  PATCH as adminPatch,
} from '../../../../admin/projects/[id]/products/[productId]/route';

// ─── Helpers ────────────────────────────────────────────────────────────────
const WORKSPACE_ID = '4f9c1a3e-0b7d-4a52-9c31-2f8e6d5b7a01';
const OTHER_WORKSPACE_ID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const PRODUCT_ID = 'prod_ours';
const OTHER_PRODUCT_ID = 'prod_theirs';

type ListCtx = { params: Promise<{ id: string }> };
type ItemCtx = { params: Promise<{ id: string; productId: string }> };

function ctx(id = WORKSPACE_ID): ListCtx {
  return { params: Promise.resolve({ id }) };
}

function itemCtx(productId = PRODUCT_ID, id = WORKSPACE_ID): ItemCtx {
  return { params: Promise.resolve({ id, productId }) };
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
    { id: WORKSPACE_ID, slug: 'acme', commerce_product_count: 0 },
    { id: OTHER_WORKSPACE_ID, slug: 'other', commerce_product_count: 1 }
  );
}

function seedProducts() {
  seed(
    'commerce_products',
    {
      id: PRODUCT_ID,
      workspace_id: WORKSPACE_ID,
      name: 'Starter course',
      slug: 'starter-course',
      product_type: 'digital',
      status: 'draft',
      currency: 'EUR',
      price_amount: 4900,
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'prod_ours_2',
      workspace_id: WORKSPACE_ID,
      name: 'Workbook',
      slug: 'workbook',
      product_type: 'digital',
      status: 'active',
      currency: 'EUR',
      price_amount: 900,
      created_at: '2026-02-01T00:00:00.000Z',
    },
    {
      id: OTHER_PRODUCT_ID,
      workspace_id: OTHER_WORKSPACE_ID,
      name: "Another tenant's product",
      slug: 'their-product',
      product_type: 'physical',
      status: 'active',
      currency: 'EUR',
      price_amount: 1000,
      created_at: '2026-01-15T00:00:00.000Z',
    }
  );
}

function products(workspaceId = WORKSPACE_ID): Row[] {
  return rowsOf('commerce_products').filter(
    (row) => row.workspace_id === workspaceId
  );
}

type AnyHandler = (req: NextRequest, ctx: never) => Promise<Response>;

const ALL: Array<[string, AnyHandler, ListCtx | ItemCtx]> = [
  ['team GET', teamList as AnyHandler, ctx()],
  ['team POST', teamCreate as AnyHandler, ctx()],
  ['team PATCH', teamPatch as AnyHandler, itemCtx()],
  ['team DELETE', teamDelete as AnyHandler, itemCtx()],
  ['admin GET', adminList as AnyHandler, ctx()],
  ['admin POST', adminCreate as AnyHandler, ctx()],
  ['admin PATCH', adminPatch as AnyHandler, itemCtx()],
  ['admin DELETE', adminDelete as AnyHandler, itemCtx()],
];

const LISTS: Array<[string, AnyHandler]> = [
  ['team', teamList as AnyHandler],
  ['admin', adminList as AnyHandler],
];
const CREATES: Array<[string, AnyHandler]> = [
  ['team', teamCreate as AnyHandler],
  ['admin', adminCreate as AnyHandler],
];
const PATCHES: Array<[string, AnyHandler]> = [
  ['team', teamPatch as AnyHandler],
  ['admin', adminPatch as AnyHandler],
];
const DELETES: Array<[string, AnyHandler]> = [
  ['team', teamDelete as AnyHandler],
  ['admin', adminDelete as AnyHandler],
];

const VALID_PRODUCT = {
  name: '  Deep work sprint  ',
  product_type: 'digital',
  status: 'active',
  short_description: 'Four weeks, one habit.',
  price_amount: '14900',
  currency: 'eur',
  checkout_url: 'https://buy.stripe.com/test_123',
  fulfillment_type: 'download',
  inventory_policy: 'not_tracked',
  metadata: { cohort: 'autumn' },
};

beforeEach(() => {
  resetFakeSupabase();
  authState.userId = 'user_operator';
  authState.role = 'team';
});

describe('products: who may touch the catalogue', () => {
  it.each(ALL)(
    '%s refuses an unauthenticated caller with 401',
    async (_name, handler, context) => {
      authState.userId = null;
      seedWorkspaces();
      seedProducts();

      const res = await handler(req(VALID_PRODUCT), context as never);
      expect(res.status).toBe(401);
      expect(rowsOf('commerce_products')).toHaveLength(3);
    }
  );

  it.each(ALL)(
    '%s refuses a signed-in caller who is not an operator with 403',
    async (_name, handler, context) => {
      authState.userId = 'user_plain_client';
      authState.role = undefined;
      seedWorkspaces();
      seedProducts();

      const res = await handler(req(VALID_PRODUCT), context as never);
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
      expect(rowsOf('commerce_products')).toHaveLength(3);
    }
  );
});

describe.each(LISTS)('GET /api/%s/projects/[id]/products', (_tree, handler) => {
  it('lists only this workspace, oldest first', async () => {
    seedWorkspaces();
    seedProducts();

    const res = await handler(req(), ctx() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products.map((p: Row) => p.id)).toEqual([
      PRODUCT_ID,
      'prod_ours_2',
    ]);
  });

  it('returns an empty list rather than null when the driver returns nothing', async () => {
    seedWorkspaces();
    nullData.add('commerce_products:select');

    const res = await handler(req(), ctx() as never);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ products: [] });
  });

  it('returns 500 without leaking credentials when the read fails', async () => {
    failures['commerce_products:select'] = {
      message: 'permission denied for table commerce_products',
    };

    const res = await handler(req(), ctx() as never);
    expect(res.status).toBe(500);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|eyJ/);
  });
});

describe.each(CREATES)(
  'POST /api/%s/projects/[id]/products',
  (_tree, handler) => {
    it('creates the product against the workspace in the path', async () => {
      seedWorkspaces();

      const res = await handler(req(VALID_PRODUCT), ctx() as never);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.product).toMatchObject({
        workspace_id: WORKSPACE_ID,
        name: 'Deep work sprint',
        slug: 'deep-work-sprint',
        product_type: 'digital',
        status: 'active',
        currency: 'EUR',
        price_amount: 14900,
      });

      // The workspace's product count is kept in step with the catalogue.
      const ws = rowsOf('workspaces').find((w) => w.id === WORKSPACE_ID);
      expect(ws?.commerce_product_count).toBe(1);
      // ...and only that workspace's.
      expect(
        rowsOf('workspaces').find((w) => w.id === OTHER_WORKSPACE_ID)
          ?.commerce_product_count
      ).toBe(1);
    });

    it('rejects an invalid body with 400 and the field errors', async () => {
      seedWorkspaces();

      const res = await handler(
        req({ name: '   ', product_type: 'vapourware', status: 'someday' }),
        ctx() as never
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation failed');
      expect(body.errors.map((e: { field: string }) => e.field)).toEqual(
        expect.arrayContaining(['name', 'product_type', 'status'])
      );
      expect(rowsOf('commerce_products')).toHaveLength(0);
    });

    it('treats a body that is not JSON as empty, and answers 400 not 500', async () => {
      seedWorkspaces();

      const res = await handler(req(), ctx() as never);
      expect(res.status).toBe(400);
      expect(rowsOf('commerce_products')).toHaveLength(0);
    });

    it('answers 404 for a workspace that does not exist', async () => {
      const res = await handler(req(VALID_PRODUCT), ctx() as never);
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: 'Workspace not found',
      });
      expect(rowsOf('commerce_products')).toHaveLength(0);
    });

    it('maps a duplicate slug to 409, not 500', async () => {
      seedWorkspaces();
      failures['commerce_products:insert'] = {
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      };

      const res = await handler(req(VALID_PRODUCT), ctx() as never);
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: 'A product with that slug already exists for this workspace',
      });
    });

    it('returns 500 without leaking credentials on any other insert failure', async () => {
      seedWorkspaces();
      failures['commerce_products:insert'] = {
        code: '42501',
        message: 'permission denied for table commerce_products',
      };

      const res = await handler(req(VALID_PRODUCT), ctx() as never);
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|eyJ/);
    });
  }
);

describe.each(PATCHES)(
  'PATCH /api/%s/projects/[id]/products/[productId]',
  (_tree, handler) => {
    it('updates one field in place', async () => {
      seedWorkspaces();
      seedProducts();

      const res = await handler(
        req({ status: 'active', price_amount: 5900 }),
        itemCtx() as never
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.product).toMatchObject({
        id: PRODUCT_ID,
        status: 'active',
        price_amount: 5900,
        name: 'Starter course',
      });
    });

    it('rejects an invalid partial body with 400', async () => {
      seedWorkspaces();
      seedProducts();

      const res = await handler(req({ status: 'someday' }), itemCtx() as never);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'Validation failed',
      });
      expect(products()[0].status).toBe('draft');
    });

    it('refuses an empty patch with 400 rather than writing nothing', async () => {
      seedWorkspaces();
      seedProducts();

      const res = await handler(req({}), itemCtx() as never);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'No valid fields to update',
      });
    });

    it('treats a body that is not JSON as empty, and answers 400 not 500', async () => {
      seedWorkspaces();
      seedProducts();

      const res = await handler(req(), itemCtx() as never);
      expect(res.status).toBe(400);
    });

    it("will not reach another workspace's product", async () => {
      seedWorkspaces();
      seedProducts();

      // Correct product id, wrong workspace: the statement filters on both, so
      // no row matches and the other tenant's row is untouched.
      const res = await handler(
        req({ name: 'Hijacked' }),
        itemCtx(OTHER_PRODUCT_ID) as never
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(
        rowsOf('commerce_products').find((p) => p.id === OTHER_PRODUCT_ID)?.name
      ).toBe("Another tenant's product");
    });

    it('maps a duplicate slug to 409, not 500', async () => {
      seedWorkspaces();
      seedProducts();
      failures['commerce_products:update'] = {
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      };

      const res = await handler(req({ slug: 'workbook' }), itemCtx() as never);
      expect(res.status).toBe(409);
    });

    it('returns 500 without leaking credentials on any other update failure', async () => {
      seedWorkspaces();
      seedProducts();
      failures['commerce_products:update'] = {
        code: '42501',
        message: 'permission denied for table commerce_products',
      };

      const res = await handler(req({ name: 'Renamed' }), itemCtx() as never);
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|eyJ/);
    });

    it('answers 404 when the driver returns no row and no error', async () => {
      seedWorkspaces();
      seedProducts();
      nullData.add('commerce_products:update');

      const res = await handler(req({ name: 'Renamed' }), itemCtx() as never);
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'Product not found' });
    });
  }
);

describe.each(DELETES)(
  'DELETE /api/%s/projects/[id]/products/[productId]',
  (_tree, handler) => {
    it('removes the product and resyncs the count', async () => {
      seedWorkspaces();
      seedProducts();

      const res = await handler(req(), itemCtx() as never);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true });
      expect(products().map((p) => p.id)).toEqual(['prod_ours_2']);
      expect(
        rowsOf('workspaces').find((w) => w.id === WORKSPACE_ID)
          ?.commerce_product_count
      ).toBe(1);
    });

    it("will not delete another workspace's product", async () => {
      seedWorkspaces();
      seedProducts();

      const res = await handler(req(), itemCtx(OTHER_PRODUCT_ID) as never);
      // The statement is scoped to both ids, so it deletes nothing and says so
      // without confirming that the other tenant's id exists.
      expect(res.status).toBe(200);
      expect(products(OTHER_WORKSPACE_ID)).toHaveLength(1);
    });

    it('returns 500 without leaking credentials when the delete fails', async () => {
      seedWorkspaces();
      seedProducts();
      failures['commerce_products:delete'] = {
        message: 'permission denied for table commerce_products',
      };

      const res = await handler(req(), itemCtx() as never);
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|eyJ/);
      expect(products()).toHaveLength(2);
    });
  }
);
