import { resolveBuildCommit } from '@/lib/build-commit';
import { getSigmaHealth } from '@/lib/sigma/warm';
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
 *
 * `sigma` reports whether `src/instrumentation.ts`'s startup warm-up of the
 * sigma classifier (`@flowstarter/sigma-flowstarter`) actually found its
 * model cache and loaded it — `'missing'` means every acceptable-use/scope
 * check is silently failing open to human review, which is a deploy defect
 * (see deploy/hetzner-staging/README.md, "Shipping the sigma model"), not a
 * reason to fail this probe: `ok` stays `true` either way, the same way a
 * remote Supabase target on a staging slot is reported, not refused, here.
 */
export async function GET() {
  const commit = resolveBuildCommit();
  return NextResponse.json(
    {
      ok: true,
      supabase: describeSupabaseTarget(),
      sigma: getSigmaHealth(),
      ...(commit ? { commit } : {}),
    },
    { status: 200 }
  );
}
