import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { publicAppOrigin } from '@flowstarter/platform-config';
import { depositAmountMinor } from '@flowstarter/agentic-codegen/src/flowstarter/state-machine';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { requireAuth } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { STRIPE_API_VERSION } from '@/lib/billing/stripe';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Creates the client-facing Stripe Checkout session for the exact 20% build
 * deposit. Price, currency, ownership and lifecycle state are server-owned;
 * no monetary value is accepted from the browser.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const { id: workspaceId } = await params;
  if (!UUID.test(workspaceId)) {
    return NextResponse.json(
      { error: 'Invalid workspace id' },
      { status: 400 }
    );
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return NextResponse.json(
      { error: 'Stripe is not configured' },
      { status: 503 }
    );
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: membership, error: membershipError } = await supabase
    .from('workspace_memberships')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('clerk_user_id', auth.userId)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const { data: workspace, error } = await supabase
    .from('workspaces')
    .select(
      'id, client_email, client_business_name, project_state, final_value_minor, billing_currency, deposit_status'
    )
    .eq('id', workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  if (workspace.project_state !== ProjectState.PREVIEW_READY) {
    return NextResponse.json(
      { error: 'The preview must be approved before paying the deposit' },
      { status: 409 }
    );
  }
  if (workspace.deposit_status === 'paid') {
    return NextResponse.json(
      { error: 'Deposit is already paid' },
      { status: 409 }
    );
  }
  if (!workspace.final_value_minor || workspace.final_value_minor <= 0) {
    return NextResponse.json(
      { error: 'The project quote is not configured' },
      { status: 409 }
    );
  }

  const amountMinor = depositAmountMinor(workspace.final_value_minor);
  const currency = workspace.billing_currency.toLowerCase();
  const origin = publicAppOrigin(undefined, request.nextUrl.origin);
  const stripe = new Stripe(secret, { apiVersion: STRIPE_API_VERSION });
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: workspace.client_email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountMinor,
          product_data: {
            name: `${
              workspace.client_business_name ?? 'Flowstarter website'
            }: 20% build deposit`,
            description:
              'Locks the approved preview and starts the full website build.',
          },
        },
      },
    ],
    metadata: {
      kind: 'flowstarter_deposit',
      workspaceId,
    },
    payment_intent_data: {
      metadata: {
        kind: 'flowstarter_deposit',
        workspaceId,
      },
    },
    success_url: `${origin}/dashboard/projects/${workspaceId}?deposit=paid`,
    cancel_url: `${origin}/dashboard/projects/${workspaceId}?deposit=cancelled`,
  });

  if (!session.url) throw new Error('Stripe did not return a Checkout URL');
  return NextResponse.json({
    url: session.url,
    amountMinor,
    currency,
    depositPercent: 20,
  });
}
