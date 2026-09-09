import { auth, currentUser } from '@clerk/nextjs/server';
import { requireTeamAuth } from '@/lib/api-auth';
import {
  InvalidQuoteError,
  parseQuoteInputToMinor,
} from '@/lib/flowstarter/quote';
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import {
  COMMERCE_MODES,
  COMMERCE_PRODUCT_TYPES,
  COMMERCE_PROVIDERS,
  COMMERCE_STATUSES,
} from '@/lib/commerce';

const CONCIERGE_STAGES = [
  'intake',
  'brief',
  'build',
  'internal_review',
  'client_review',
  'launched',
  'care',
] as const;

const TIER_NAMES = ['essential', 'pro', 'commerce', 'custom'] as const;
const BILLING_INTERVALS = ['monthly', 'annual'] as const;

function assignEnumField(
  updateData: Record<string, unknown>,
  field: string,
  value: unknown,
  allowed: readonly string[],
  { allowNull = false }: { allowNull?: boolean } = {}
): { ok: true } | { ok: false; response: NextResponse<{ error: string }> } {
  if (value === undefined) return { ok: true };
  if (allowNull && (value === null || value === '')) {
    updateData[field] = null;
    return { ok: true };
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Invalid ${field}` },
        { status: 400 }
      ),
    };
  }
  updateData[field] = value;
  return { ok: true };
}

function assignNonNegativeIntegerField(
  updateData: Record<string, unknown>,
  field: string,
  value: unknown
): { ok: true } | { ok: false; response: NextResponse<{ error: string }> } {
  if (value === undefined) return { ok: true };
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `${field} must be a non-negative number` },
        { status: 400 }
      ),
    };
  }
  updateData[field] = Math.floor(numberValue);
  return { ok: true };
}

/**
 * DELETE /api/team/projects/[id]
 * Delete any workspace (team members bypass RLS).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCheck = await requireTeamAuth();
  if (!authCheck.authorized) {
    return authCheck.response;
  }

  try {
    const { id } = await params;

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );

    const { data: workspace, error: fetchError } = await supabaseAdmin
      .from('workspaces')
      .select('id, name')
      .eq('id', id)
      .single();

    if (fetchError || !workspace) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const { error: deleteError } = await supabaseAdmin
      .from('workspaces')
      .delete()
      .eq('id', id);

    if (deleteError) {
      console.error('[Team Projects] Delete error:', deleteError);
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    console.info('[Team Projects] Deleted workspace', {
      workspaceId: id,
      name: workspace.name,
      deletedBy: authCheck.userId,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Team Projects] Delete error:', error);
    return NextResponse.json(
      { error: 'Failed to delete project' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/team/projects/[id]
 * Update workspace fields (rename, pricing, status, commerce, etc.).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCheck = await requireTeamAuth();
  if (!authCheck.authorized) {
    return authCheck.response;
  }

  try {
    const { id } = await params;
    // A body that is not JSON is the caller's mistake, so say 400. Read
    // straight, it threw into the catch-all below and answered 500 "Failed to
    // update project", which reads as our fault and tells the caller nothing.
    // Every sibling handler in this group already guards the parse.
    const body = await request.json().catch(() => null);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }
    const {
      name,
      site_kind,
      tier_name,
      is_founding,
      billing_interval,
      setup_fee,
      monthly_fee,
      client_name,
      client_email,
      client_phone,
      client_business_name,
      concierge_stage,
      commerce_mode,
      commerce_product_type,
      commerce_provider,
      commerce_status,
      commerce_product_count,
      commerce_requirements,
      commerce_notes,
    } = body;

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return NextResponse.json(
          { error: 'Name cannot be empty' },
          { status: 400 }
        );
      }
      updateData.name = name.trim();
    }

    if (setup_fee !== undefined) {
      // Stored in minor units, which is what the deposit Checkout and the
      // 20% webhook check read; setup_fee stays as the legacy mirror.
      try {
        const minor = parseQuoteInputToMinor(setup_fee);
        updateData.final_value_minor = minor;
        updateData.setup_fee = minor / 100;
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof InvalidQuoteError
                ? error.message
                : 'Invalid project value',
          },
          { status: 400 }
        );
      }
    }

    if (monthly_fee !== undefined) {
      updateData.monthly_fee = Number(monthly_fee) || 0;
    }

    if (is_founding !== undefined) {
      updateData.is_founding = Boolean(is_founding);
    }

    if (client_name !== undefined) {
      updateData.client_name =
        typeof client_name === 'string' && client_name.trim().length > 0
          ? client_name.trim()
          : null;
    }

    if (client_email !== undefined) {
      updateData.client_email =
        typeof client_email === 'string' && client_email.trim().length > 0
          ? client_email.trim()
          : null;
    }

    if (client_phone !== undefined) {
      updateData.client_phone =
        typeof client_phone === 'string' && client_phone.trim().length > 0
          ? client_phone.trim()
          : null;
    }

    if (client_business_name !== undefined) {
      updateData.client_business_name =
        typeof client_business_name === 'string' &&
        client_business_name.trim().length > 0
          ? client_business_name.trim()
          : null;
    }

    if (commerce_requirements !== undefined) {
      if (
        !commerce_requirements ||
        typeof commerce_requirements !== 'object' ||
        Array.isArray(commerce_requirements)
      ) {
        return NextResponse.json(
          { error: 'commerce_requirements must be an object' },
          { status: 400 }
        );
      }
      updateData.commerce_requirements = commerce_requirements;
    }

    if (commerce_notes !== undefined) {
      updateData.commerce_notes =
        typeof commerce_notes === 'string' && commerce_notes.trim().length > 0
          ? commerce_notes.trim()
          : null;
    }

    const enumResults = [
      assignEnumField(updateData, 'site_kind', site_kind, [
        'shopify_liquid',
        'astro',
      ]),
      assignEnumField(
        updateData,
        'concierge_stage',
        concierge_stage,
        CONCIERGE_STAGES
      ),
      assignEnumField(updateData, 'tier_name', tier_name, TIER_NAMES, {
        allowNull: true,
      }),
      assignEnumField(
        updateData,
        'billing_interval',
        billing_interval,
        BILLING_INTERVALS
      ),
      assignEnumField(
        updateData,
        'commerce_mode',
        commerce_mode,
        COMMERCE_MODES
      ),
      assignEnumField(
        updateData,
        'commerce_product_type',
        commerce_product_type,
        COMMERCE_PRODUCT_TYPES
      ),
      assignEnumField(
        updateData,
        'commerce_provider',
        commerce_provider,
        COMMERCE_PROVIDERS
      ),
      assignEnumField(
        updateData,
        'commerce_status',
        commerce_status,
        COMMERCE_STATUSES
      ),
      assignNonNegativeIntegerField(
        updateData,
        'commerce_product_count',
        commerce_product_count
      ),
    ];
    for (const result of enumResults) {
      if (!result.ok) return result.response;
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );

    const { data: project, error } = await supabaseAdmin
      .from('workspaces')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('[Team Projects] Update error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ project });
  } catch (error) {
    console.error('[Team Projects] Update error:', error);
    return NextResponse.json(
      { error: 'Failed to update project' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/team/projects/[id]
 * Get any workspace details (team members bypass RLS).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCheck = await requireTeamAuth();
  if (!authCheck.authorized) {
    return authCheck.response;
  }

  try {
    const { id } = await params;

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );

    const { data: project, error } = await supabaseAdmin
      .from('workspaces')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json({ project });
  } catch (error) {
    console.error('[Team Projects] Get error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch project' },
      { status: 500 }
    );
  }
}
