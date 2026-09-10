import { NextResponse } from 'next/server';

/**
 * Liveness probe for Hetzner staging / Docker HEALTHCHECK.
 * Does not touch Supabase or Clerk — those live under /api/health/database.
 */
export async function GET() {
  return NextResponse.json({ ok: true }, { status: 200 });
}
