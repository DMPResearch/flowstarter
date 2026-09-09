import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
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
 * The service role client is the right caller for this. It is server-only,
 * every other server route already uses it, and the handler returns a status
 * and a timestamp, never a row.
 */

export async function GET() {
  try {
    // Create Supabase client
    const supabase = createSupabaseServiceRoleClient();

    // Simple query to test database connection
    // Using a lightweight query that should work on any Supabase instance
    const { error } = await supabase
      .from('workspaces')
      .select('count', { count: 'exact', head: true });

    if (error) {
      console.error('Database health check failed:', error);
      return NextResponse.json(
        {
          status: 'error',
          message: 'Database connection failed',
          error: error.message,
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
  } catch (error) {
    console.error('Database health check error:', error);

    return NextResponse.json(
      {
        status: 'error',
        message: 'Health check failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}

// Also support HEAD requests for quick checks
export async function HEAD() {
  try {
    const supabase = createSupabaseServiceRoleClient();
    const { error } = await supabase
      .from('workspaces')
      .select('count', { count: 'exact', head: true });

    if (error) {
      return new NextResponse(null, { status: 503 });
    }

    return new NextResponse(null, { status: 200 });
  } catch (error) {
    return new NextResponse(null, { status: 503 });
  }
}
