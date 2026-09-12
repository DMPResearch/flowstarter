/**
 * API Route Authentication Utilities
 *
 * Provides standardized authentication checks for API routes.
 * Ensures consistent security patterns across all protected endpoints.
 *
 * @module lib/api-auth
 */

import { auth, clerkClient, currentUser } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { createSupabaseServerClient } from '@/supabase-clients/server';

/**
 * Authentication result type
 */
export type AuthResult =
  | {
      authenticated: true;
      userId: string;
      getToken: () => Promise<string | null>;
    }
  | { authenticated: false; response: NextResponse };

/**
 * Standard unauthorized response
 */
export function unauthorizedResponse(message = 'Unauthorized'): NextResponse {
  return NextResponse.json(
    { error: message, code: 'UNAUTHORIZED' },
    { status: 401 }
  );
}

/**
 * Standard forbidden response (authenticated but not authorized)
 */
export function forbiddenResponse(message = 'Forbidden'): NextResponse {
  return NextResponse.json(
    { error: message, code: 'FORBIDDEN' },
    { status: 403 }
  );
}

/**
 * Check authentication for API routes
 *
 * Returns userId and getToken if authenticated, or a 401 response if not.
 * This should be called at the start of every protected API route handler.
 *
 * @example
 * ```ts
 * export async function GET() {
 *   const authResult = await requireAuth();
 *   if (!authResult.authenticated) {
 *     return authResult.response;
 *   }
 *
 *   const { userId } = authResult;
 *   // ... rest of handler
 * }
 * ```
 */
export async function requireAuth(request?: Request): Promise<AuthResult> {
  // ── E2E dev bypass ────────────────────────────────────────────────────────
  // Allows Playwright tests to call protected API routes without a browser
  // session. ONLY active in non-production + correct E2E_SECRET header.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.E2E_SECRET &&
    request
  ) {
    const secret = request.headers.get('x-e2e-secret');
    const userId = request.headers.get('x-e2e-user-id');
    if (secret === process.env.E2E_SECRET && userId) {
      // Do not log user ids — keeps dev logs safe for screenshots / CI artifacts.
      return { authenticated: true, userId, getToken: async () => null };
    }
  }

  try {
    const session = await auth();
    const userId = session?.userId;

    if (!userId) {
      console.warn('[API Auth] No userId found in session');
      return {
        authenticated: false,
        response: unauthorizedResponse('Authentication required'),
      };
    }

    return {
      authenticated: true,
      userId,
      getToken: session.getToken.bind(session),
    };
  } catch (error) {
    console.error('[API Auth] Authentication check failed:', error);
    return {
      authenticated: false,
      response: unauthorizedResponse('Authentication failed'),
    };
  }
}

/**
 * Get authenticated Supabase client or return error response
 *
 * Combines auth check with Supabase client creation.
 * This is the preferred method for API routes that need database access.
 *
 * @example
 * ```ts
 * export async function GET() {
 *   const result = await requireAuthWithSupabase();
 *   if (!result.authenticated) {
 *     return result.response;
 *   }
 *
 *   const { supabase, userId } = result;
 *   const { data } = await supabase.from('projects').select('*');
 *   // ...
 * }
 * ```
 */
type ServerSupabaseClient = ReturnType<typeof createSupabaseServerClient>;

export async function requireAuthWithSupabase(request?: Request): Promise<
  | {
      authenticated: true;
      userId: string;
      supabase: ServerSupabaseClient;
    }
  | { authenticated: false; response: NextResponse }
> {
  const authResult = await requireAuth(request);
  if (!authResult.authenticated) {
    return authResult;
  }

  // ── E2E bypass: use service-role client (no JWT needed) ───────────────────
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.E2E_SECRET &&
    request?.headers.get('x-e2e-secret') === process.env.E2E_SECRET
  ) {
    const { createSupabaseServiceRoleClient } = await import(
      '@/supabase-clients/server'
    );
    return {
      authenticated: true,
      userId: authResult.userId,
      supabase: createSupabaseServiceRoleClient(),
    };
  }

  // Dynamically import to avoid circular dependencies
  const { useServerSupabaseWithAuthStrict } = await import(
    '@/hooks/useServerSupabase'
  );

  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- server-only utility, not a React hook
    const supabase = await useServerSupabaseWithAuthStrict();
    return {
      authenticated: true,
      userId: authResult.userId,
      supabase,
    };
  } catch (error) {
    console.error(
      '[API Auth] Failed to create authenticated Supabase client:',
      error
    );
    return {
      authenticated: false,
      response: unauthorizedResponse(
        'Failed to establish authenticated database connection'
      ),
    };
  }
}

/**
 * Domains whose primary verified email auto-resolves to the `admin` role.
 * Lets new internal hires hit /admin/* without a manual Clerk metadata edit.
 */
const TEAM_EMAIL_DOMAINS = new Set([
  'flowstarter.net',
  'flowstarter.app',
  'flowstarter.dev',
  'flowstarter.com',
]);

/**
 * Minimal shape of the fields we read off a Clerk user's primary email
 * address. Kept narrow (rather than importing Clerk's full type) so this
 * rule is trivial to unit test with a plain object.
 */
type PrimaryEmailAddress = {
  emailAddress: string;
  verification?: { status?: string | null } | null;
};

/**
 * Whether a primary email address earns the automatic flowstarter-domain
 * operator role.
 *
 * Rule: the domain must be one of the internal team domains AND Clerk must
 * have verified that address (verification.status === 'verified'). An
 * unverified address on a team domain does NOT elevate — anyone can type
 * `you@flowstarter.dev` into a sign-up form; only Clerk's verification proves
 * the person actually controls that mailbox. `publicMetadata.role` (checked
 * before this ever runs) always stays authoritative over this fallback.
 */
function emailDomainRole(
  email: PrimaryEmailAddress | undefined
): string | undefined {
  if (!email?.emailAddress) return undefined;
  const domain = email.emailAddress.split('@')[1]?.toLowerCase();
  if (!domain || !TEAM_EMAIL_DOMAINS.has(domain)) return undefined;

  if (email.verification?.status !== 'verified') {
    console.warn(
      '[API Auth] Refused domain-based admin elevation: primary email on a team domain is not verified',
      { domain }
    );
    return undefined;
  }

  return 'admin';
}

/**
 * Resolve a Clerk user's effective role.
 *
 * Order: session-claim metadata → publicMetadata.role → flowstarter-domain
 * email fallback (verified primary email only). Returns undefined when the
 * user has no team-level role.
 */
export async function resolveUserRole(
  userId: string
): Promise<string | undefined> {
  const { sessionClaims } = await auth();
  const claimRole = (
    sessionClaims?.metadata as { role?: string } | undefined
  )?.role?.toLowerCase();
  if (claimRole) return claimRole;

  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const metaRole = (
    user.publicMetadata as { role?: string } | undefined
  )?.role?.toLowerCase();
  if (metaRole) return metaRole;

  const primaryEmail = user.emailAddresses.find(
    (e) => e.id === user.primaryEmailAddressId
  );
  return emailDomainRole(primaryEmail);
}

/**
 * Require team-or-admin role for /api/admin/* routes.
 */
export type TeamAuthResult =
  | { authorized: true; userId: string; role: 'team' | 'admin' }
  | { authorized: false; response: NextResponse };

export async function requireTeamAuth(): Promise<TeamAuthResult> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return { authorized: false, response: unauthorizedResponse() };
    }

    const role = await resolveUserRole(userId);
    if (role !== 'team' && role !== 'admin') {
      return {
        authorized: false,
        response: forbiddenResponse('Not a team member'),
      };
    }

    return { authorized: true, userId, role: role as 'team' | 'admin' };
  } catch (error) {
    console.error('[Team Auth] Error:', error);
    return {
      authorized: false,
      response: NextResponse.json({ error: 'Auth failed' }, { status: 500 }),
    };
  }
}

export type WorkspaceAccessResult =
  | {
      authorized: true;
      userId: string;
      workspaceId: string;
      via: 'membership' | 'team';
    }
  | { authorized: false; response: NextResponse };

/**
 * Authorizes a caller for one workspace's data.
 *
 * Service-role queries bypass RLS, so a route that takes a workspace id from
 * the request and queries with that client is only as isolated as the check in
 * front of it. Every route hand-rolled that check, and one of them
 * (`/api/leads/list`) did not have it at all: any signed-in user could read
 * another client's leads by changing a query parameter. This is the single
 * place to get it right.
 *
 * Team and admin roles intentionally pass for any workspace — the operator
 * dashboards are cross-tenant by design.
 *
 * Returns 404 rather than 403 for a workspace the caller cannot see, so the
 * response does not confirm that an id exists.
 */
export async function requireWorkspaceAccess(
  workspaceId: string
): Promise<WorkspaceAccessResult> {
  const authResult = await requireAuth();
  if (!authResult.authenticated) {
    return { authorized: false, response: authResult.response };
  }
  const { userId } = authResult;

  if (!UUID_PATTERN.test(workspaceId)) {
    return {
      authorized: false,
      response: NextResponse.json(
        { error: 'Invalid workspace id', code: 'BAD_REQUEST' },
        { status: 400 }
      ),
    };
  }

  const role = await resolveUserRole(userId);
  if (role === 'team' || role === 'admin') {
    return { authorized: true, userId, workspaceId, via: 'team' };
  }

  const { createSupabaseServiceRoleClient } = await import(
    '@/supabase-clients/server'
  );
  const supabase = createSupabaseServiceRoleClient();
  const { data: membership, error } = await supabase
    .from('workspace_memberships')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('clerk_user_id', userId)
    .maybeSingle();
  if (error) throw error;

  if (!membership) {
    return {
      authorized: false,
      response: NextResponse.json(
        { error: 'Workspace not found', code: 'NOT_FOUND' },
        { status: 404 }
      ),
    };
  }

  return { authorized: true, userId, workspaceId, via: 'membership' };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
