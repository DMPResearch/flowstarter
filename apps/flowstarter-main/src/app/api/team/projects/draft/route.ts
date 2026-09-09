import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireTeamAuth } from '@/lib/api-auth';
import {
  inferCommercePlanFromText,
  normalizeCommercePlan,
  type CommercePlanInput,
} from '@/lib/commerce';

interface ClientInfo {
  name?: string;
  email?: string;
  phone?: string;
  businessName?: string;
}

interface DraftBody {
  projectConfig?: {
    name?: string;
    siteKind?: 'astro' | 'shopify_liquid';
    clientInfo?: ClientInfo;
    commerceInfo?: CommercePlanInput;
    userInput?: string;
    businessInfo?: { summary?: string };
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function uniqueSlug(base: string): string {
  const root = slugify(base) || 'workspace';
  // 6-char random suffix to avoid collisions on the workspaces.slug unique index.
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${root}-${suffix}`;
}

/**
 * POST /api/team/projects/draft
 *
 * Creates a new workspace seeded with the discovery-call client info.
 */
export async function POST(req: Request) {
  try {
    // `requireTeamAuth`, not a bare `auth()` check. This route creates a
    // workspace and writes the caller into `workspace_memberships` as its
    // admin, so a signed-in check alone let any client of any workspace mint
    // one for themselves. Its twin at /api/admin/projects/draft always did
    // this; the two are the same surface under two names and must not drift.
    const authResult = await requireTeamAuth();
    if (!authResult.authorized) {
      return authResult.response;
    }
    const { userId } = authResult;

    const body: DraftBody = await req.json().catch(() => ({}));
    const clientInfo = body?.projectConfig?.clientInfo;
    const projectName = clientInfo?.businessName
      ? clientInfo.businessName
      : clientInfo?.name
      ? `${clientInfo.name}'s Project`
      : body?.projectConfig?.name || 'Untitled Project';

    const commerceSourceText = [
      projectName,
      body?.projectConfig?.businessInfo?.summary,
      body?.projectConfig?.userInput,
    ]
      .filter(Boolean)
      .join('\n');
    const inferredCommerce = inferCommercePlanFromText(commerceSourceText);
    const commerceInfo = body?.projectConfig?.commerceInfo;
    const commercePlan = normalizeCommercePlan({
      mode: commerceInfo?.mode ?? inferredCommerce.commerce_mode,
      productType:
        commerceInfo?.productType ?? inferredCommerce.commerce_product_type,
      provider: commerceInfo?.provider ?? inferredCommerce.commerce_provider,
      status: commerceInfo?.status ?? inferredCommerce.commerce_status,
      productCount:
        commerceInfo?.productCount ?? inferredCommerce.commerce_product_count,
      requirements:
        commerceInfo?.requirements ?? inferredCommerce.commerce_requirements,
      notes: commerceInfo?.notes ?? inferredCommerce.commerce_notes,
    });

    // Default to astro (Service tier) unless caller specifies otherwise.
    // Commerce-tier workspaces use shopify_liquid.
    const siteKind =
      body?.projectConfig?.siteKind === 'shopify_liquid'
        ? 'shopify_liquid'
        : 'astro';

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );

    const { data, error } = await supabase
      .from('workspaces')
      .insert({
        slug: uniqueSlug(projectName),
        name: projectName,
        site_kind: siteKind,
        client_name: clientInfo?.name || null,
        client_email: clientInfo?.email || null,
        client_phone: clientInfo?.phone || null,
        client_business_name: clientInfo?.businessName || null,
        concierge_stage: 'intake',
        ...commercePlan,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[Draft API] Error creating workspace:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Record the team member as an admin on the workspace so workspace_memberships
    // reflects who owns/manages it. Best-effort — failure here doesn't void the workspace.
    const { error: membershipError } = await supabase
      .from('workspace_memberships')
      .insert({ workspace_id: data.id, clerk_user_id: userId, role: 'admin' });
    if (membershipError) {
      console.warn(
        '[Draft API] Failed to attach team membership:',
        membershipError.message
      );
    }

    console.log('[Draft API] Workspace created:', data.id);
    return NextResponse.json({ id: data.id, projectId: data.id });
  } catch (error) {
    console.error('[Draft API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to create draft project' },
      { status: 500 }
    );
  }
}
