import { describeSupabaseTarget } from '@/lib/supabase-target';
import { NextResponse } from 'next/server';

/**
 * Liveness probe for Hetzner staging / Docker HEALTHCHECK.
 * Does not touch Supabase or Clerk — those live under /api/health/database.
 *
 * `supabase` is included so the staging deploy script can assert
 * `target === 'local'` before trusting this host: a staging box wired to a
 * hosted Supabase project is misconfigured even if the process is up.
 */
export async function GET() {
  return NextResponse.json(
    { ok: true, supabase: describeSupabaseTarget() },
    { status: 200 }
  );
}
