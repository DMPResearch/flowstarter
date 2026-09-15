import { probeDatabase } from '@/lib/health/database-probe';
import { NextResponse } from 'next/server';

/**
 * Is the database reachable.
 *
 * This probe used the anon client and counted rows in `workspaces`. It only
 * ever worked because RLS answered an anon caller with an empty set rather
 * than an error, so a reachability check was resting on the exact grant the
 * tenant isolation hardening migration removes: anon now holds no privilege
 * on `workspaces` at all, and the same query would report a healthy database
 * as unhealthy.
 *
 * The actual query now lives in `probeDatabase` (lib/health/database-probe.ts),
 * shared with `/api/health`, which used to echo the Supabase configuration
 * without ever testing a connection — a real outage this route reported
 * correctly went unnoticed at `/api/health`, the endpoint deploy scripts and
 * watchers actually trust. One probe, called from both routes, is what keeps
 * them from disagreeing.
 */

export async function GET() {
  const result = await probeDatabase();

  if (!result.ok) {
    console.error('Database health check failed:', result.message);
    return NextResponse.json(
      {
        status: 'error',
        message: 'Database connection failed',
        error: result.message,
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    status: 'healthy',
    message: 'Database connection successful',
    timestamp: new Date().toISOString(),
    database: 'supabase',
  });
}

// Also support HEAD requests for quick checks
export async function HEAD() {
  const result = await probeDatabase();
  return new NextResponse(null, { status: result.ok ? 200 : 503 });
}
