/**
 * POST /api/admin/contact-submissions/[id]/read
 *
 * Admin action. Marks one contact-form submission read (`read_at`), the
 * "read state" the admin list at `/admin/dashboard/contact-messages` shows.
 * Same auth guard as the rest of `/api/admin/*`. Idempotent: setting
 * `read_at` on an already-read row just overwrites the timestamp.
 */
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { resolveUserRole } from '@/lib/api-auth';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const role = await resolveUserRole(userId);
    if (role !== 'team' && role !== 'admin') {
      return NextResponse.json({ error: 'Not a team member' }, { status: 403 });
    }

    const { id } = await params;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return NextResponse.json({ error: 'Not configured' }, { status: 500 });
    }
    const supabase = createClient(url, key, {
      auth: { persistSession: false },
    });

    const { error } = await supabase
      .from('contact_submissions')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[admin/contact-submissions/read] error', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
