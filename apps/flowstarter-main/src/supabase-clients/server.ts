import type { Database } from '@/lib/database.types';
import { ensureSupabaseTargetAllowed } from '@/lib/supabase-target';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Module-level singletons. In serverless, the same Lambda instance is reused
// across invocations within its warm window — caching the client here avoids
// re-running the auth/headers setup on every request after the cold start.
let cachedAnonClient: SupabaseClient<Database> | null = null;
let cachedServiceRoleClient: SupabaseClient<Database> | null = null;

// Super simple server-side client with no auth persistence
// Will work in both pages and app directory, but won't maintain auth state
export const createSupabaseClient = (): SupabaseClient<Database> => {
  ensureSupabaseTargetAllowed();
  if (cachedAnonClient) return cachedAnonClient;
  cachedAnonClient = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: false,
      },
    }
  );
  return cachedAnonClient;
};

// Export an alias that makes the purpose clearer
export const createSupabaseServerClient = createSupabaseClient;

// Create a server-side client that authenticates with a JWT (e.g., Clerk -> Supabase)
// NOTE: never cached — the JWT is per-request and must not leak across users.
export const createSupabaseServerClientWithAuth = (
  jwt: string
): SupabaseClient<Database> => {
  ensureSupabaseTargetAllowed();
  // Debug breadcrumb (no secrets)
  console.info(
    `[Auth] createSupabaseServerClientWithAuth url=${process.env.NEXT_PUBLIC_SUPABASE_URL}`
  );
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      },
      auth: {
        persistSession: false,
      },
    }
  );
};

// Server-only Service Role client (bypasses RLS). Use ONLY in server routes.
export const createSupabaseServiceRoleClient = (): SupabaseClient<Database> => {
  ensureSupabaseTargetAllowed();
  if (cachedServiceRoleClient) return cachedServiceRoleClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
  cachedServiceRoleClient = createClient<Database>(url, serviceKey, {
    auth: { persistSession: false },
  });
  return cachedServiceRoleClient;
};
