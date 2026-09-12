/**
 * GET /api/admin/contact-submissions
 *
 * Admin-only. Lists `/contact` form submissions (newest first), the same
 * auth guard as `/api/admin/custom-inquiries`. This is the "surface
 * `contact_submissions` in admin" half of the MVP readiness review's "Lead
 * capture" finding: the table had an insert and nothing that ever read it.
 *
 * `contact_submissions` is not tenant-scoped (see
 * `scripts/verify-rls-local.mjs`'s `SERVER_ONLY_TABLES`), so this reads with
 * the service role behind Clerk team auth, same as custom inquiries.
 */
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { resolveUserRole } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const role = await resolveUserRole(userId);
    if (role !== 'team' && role !== 'admin') {
      return NextResponse.json({ error: 'Not a team member' }, { status: 403 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return NextResponse.json({ submissions: [], total: 0 });
    }
    const supabase = createClient(url, key, {
      auth: { persistSession: false },
    });

    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get('unread') === '1';
    const page = Math.max(1, Number(searchParams.get('page') || '1'));
    const pageSize = 20;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from('contact_submissions')
      .select(
        'id, created_at, name, email, subject, message, read_at, responded_at, notes',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(from, to);

    if (unreadOnly) query = query.is('read_at', null);

    const { data, error, count } = await query;
    if (error) {
      console.error('[admin/contact-submissions] db error', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      submissions: data ?? [],
      total: count ?? 0,
      page,
      pageSize,
    });
  } catch (err) {
    console.error('[admin/contact-submissions] error', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
