import { resolveBuildCommit } from '@/lib/build-commit';
import { describeSupabaseTarget } from '@/lib/supabase-target';
import { NextResponse } from 'next/server';

/**
 * Liveness probe for Hetzner staging / Docker HEALTHCHECK.
 * Does not touch Supabase or Clerk — those live under /api/health/database.
 *
 * `supabase` is included so the staging deploy script can assert
 * `target === 'local'` before trusting this host: a staging box wired to a
 * hosted Supabase project is misconfigured even if the process is up.
 *
 * `commit`, when known, is what lets a caller waiting on this endpoint (see
 * .github/scripts/wait-for-staging-slot.sh) tell a slot that finished
 * rolling out to the expected commit apart from one still serving the
 * previous build while the new one deploys underneath it -- health alone
 * cannot make that distinction. Omitted rather than faked when unknown: see
 * resolveBuildCommit.
 */
export async function GET() {
  const commit = resolveBuildCommit();
  return NextResponse.json(
    {
      ok: true,
      supabase: describeSupabaseTarget(),
      ...(commit ? { commit } : {}),
    },
    { status: 200 }
  );
}
