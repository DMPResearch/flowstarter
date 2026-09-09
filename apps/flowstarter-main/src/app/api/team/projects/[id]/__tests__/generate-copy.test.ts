/**
 * POST /api/{team,admin}/projects/[id]/ai/generate-copy.
 *
 * The only route in this group that talks to a model. The model call is the
 * injected seam (`@/lib/ai/site-copy`) and it is mocked here, so nothing
 * reaches OpenRouter: what is proved is the gate in front of it — an
 * unauthenticated or non-operator caller never gets as far as a token, a
 * missing key is a 500 before any database read, and a model failure is a 502
 * rather than a 500 that looks like our fault.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  createFakeSupabase,
  failures,
  resetFakeSupabase,
  seed,
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

// ─── The model seam ─────────────────────────────────────────────────────────
const generateSiteCopy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/site-copy', () => ({ generateSiteCopy }));

import { POST as teamGenerate } from '../ai/generate-copy/route';
import { POST as adminGenerate } from '../../../../admin/projects/[id]/ai/generate-copy/route';

// ─── Helpers ────────────────────────────────────────────────────────────────
const WORKSPACE_ID = '4f9c1a3e-0b7d-4a52-9c31-2f8e6d5b7a01';

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: NextRequest, ctx: Ctx) => Promise<Response>;

const HANDLERS: Array<[string, Handler]> = [
  ['team', teamGenerate as Handler],
  ['admin', adminGenerate as Handler],
];

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

const COPY = {
  hero: {
    headline: 'Coaching that sticks',
    subhead: 'For founders',
    primaryCta: 'Book a call',
  },
  services: {
    sectionTitle: 'What we do',
    items: [{ title: 'Coaching', description: '1:1' }],
  },
  about: { sectionTitle: 'About', paragraph: 'Ten years of practice.' },
  finalCta: { headline: 'Ready?', subhead: 'Start today', button: 'Book' },
};

function seedWorkspace(overrides: Record<string, unknown> = {}) {
  seed('workspaces', {
    id: WORKSPACE_ID,
    name: 'acme-coaching',
    client_business_name: 'Acme Coaching',
    client_name: 'Ana Pop',
    commerce_mode: 'none',
    commerce_product_type: 'none',
    commerce_provider: 'none',
    commerce_notes: null,
    ...overrides,
  });
}

beforeEach(() => {
  resetFakeSupabase();
  authState.userId = 'user_operator';
  authState.role = 'team';
  generateSiteCopy.mockReset();
  generateSiteCopy.mockResolvedValue(COPY);
  vi.unstubAllEnvs();
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test-dummy');
});

describe('generate-copy: who may spend a token', () => {
  it.each(HANDLERS)(
    '%s refuses an unauthenticated caller with 401',
    async (_tree, handler) => {
      authState.userId = null;
      seedWorkspace();

      const res = await handler(
        req({ description: 'A coaching studio' }),
        ctx()
      );
      expect(res.status).toBe(401);
      expect(generateSiteCopy).not.toHaveBeenCalled();
    }
  );

  it.each(HANDLERS)(
    '%s refuses a signed-in caller who is not an operator with 403',
    async (_tree, handler) => {
      authState.userId = 'user_plain_client';
      authState.role = undefined;
      seedWorkspace();

      const res = await handler(
        req({ description: 'A coaching studio' }),
        ctx()
      );
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
      expect(generateSiteCopy).not.toHaveBeenCalled();
    }
  );

  it.each(HANDLERS)(
    '%s stops at 500 when the model key is not configured',
    async (_tree, handler) => {
      vi.stubEnv('OPENROUTER_API_KEY', '');
      seedWorkspace();

      const res = await handler(
        req({ description: 'A coaching studio' }),
        ctx()
      );
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({
        error: 'OPENROUTER_API_KEY is not configured',
      });
      expect(generateSiteCopy).not.toHaveBeenCalled();
    }
  );
});

describe('generate-copy: the workspace it writes for', () => {
  it.each(HANDLERS)(
    '%s returns 500 without leaking credentials when the read fails',
    async (_tree, handler) => {
      failures['workspaces:select'] = {
        message: 'permission denied for table workspaces',
      };

      const res = await handler(
        req({ description: 'A coaching studio' }),
        ctx()
      );
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toMatch(/service_role|OPENROUTER_API_KEY|sk-or-/);
      expect(generateSiteCopy).not.toHaveBeenCalled();
    }
  );

  it.each(HANDLERS)(
    '%s returns 404 for a workspace that does not exist',
    async (_tree, handler) => {
      const res = await handler(
        req({ description: 'A coaching studio' }),
        ctx()
      );
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: 'Workspace not found',
      });
      expect(generateSiteCopy).not.toHaveBeenCalled();
    }
  );
});

describe.each(HANDLERS)(
  'generate-copy (%s): the brief it needs',
  (_tree, handler) => {
    it('treats a body that is not JSON as an empty brief, and asks for one', async () => {
      seedWorkspace();

      const res = await handler(req(), ctx());
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining(
          'businessName and description are required'
        ),
      });
      expect(generateSiteCopy).not.toHaveBeenCalled();
    });

    it('refuses a whitespace-only description', async () => {
      seedWorkspace();

      const res = await handler(req({ description: '   ' }), ctx());
      expect(res.status).toBe(400);
      expect(generateSiteCopy).not.toHaveBeenCalled();
    });

    it('refuses when the workspace has no name to write about', async () => {
      seedWorkspace({ client_business_name: null, name: null });

      const res = await handler(
        req({ description: 'A coaching studio' }),
        ctx()
      );
      expect(res.status).toBe(400);
      expect(generateSiteCopy).not.toHaveBeenCalled();
    });

    it('falls back to the workspace name and to commerce_notes', async () => {
      seedWorkspace({
        client_business_name: null,
        name: 'Studio Nord',
        commerce_notes: 'Sells three online courses to Romanian founders.',
      });

      const res = await handler(req({ businessName: '  ' }), ctx());
      expect(res.status).toBe(200);
      expect(generateSiteCopy).toHaveBeenCalledWith(
        expect.objectContaining({
          businessName: 'Studio Nord',
          description: 'Sells three online courses to Romanian founders.',
        })
      );
    });
  }
);

describe.each(HANDLERS)(
  'generate-copy (%s): the call it makes',
  (_tree, handler) => {
    beforeEach(() => seedWorkspace());

    it('returns the copy and the resolved input', async () => {
      const res = await handler(
        req({
          description: 'A coaching studio for founders',
          industry: ' Coaching ',
          targetAudience: 'Early-stage founders',
          uvp: 'Ten years of practice',
          offerings: 'Group and 1:1',
          goal: 'bookings',
          brandTone: 'friendly',
          locale: 'ro',
        }),
        ctx()
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.copy).toEqual(COPY);
      expect(body.input).toEqual({
        businessName: 'Acme Coaching',
        description: 'A coaching studio for founders',
        industry: 'Coaching',
        targetAudience: 'Early-stage founders',
        uvp: 'Ten years of practice',
        goal: 'bookings',
        brandTone: 'friendly',
        offerings: 'Group and 1:1',
        locale: 'ro',
      });
      expect(generateSiteCopy).toHaveBeenCalledOnce();
    });

    it('falls back to safe defaults for an unknown or non-string option', async () => {
      const res = await handler(
        req({
          description: 'A coaching studio',
          goal: 'conversions',
          brandTone: 42,
          locale: 'fr',
          industry: 99,
        }),
        ctx()
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.input).toMatchObject({
        goal: 'leads',
        brandTone: 'professional',
        locale: 'en',
      });
      // A non-string industry is dropped rather than stringified into the prompt.
      expect(body.input).not.toHaveProperty('industry');
    });

    it('reports a model failure as 502, not 500', async () => {
      generateSiteCopy.mockRejectedValueOnce(new Error('upstream timed out'));

      const res = await handler(
        req({ description: 'A coaching studio' }),
        ctx()
      );
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toEqual({
        error: 'upstream timed out',
      });
    });

    it('reports a non-Error rejection as a generic 502', async () => {
      generateSiteCopy.mockRejectedValueOnce('nope');

      const res = await handler(
        req({ description: 'A coaching studio' }),
        ctx()
      );
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toEqual({
        error: 'AI generation failed',
      });
    });
  }
);
