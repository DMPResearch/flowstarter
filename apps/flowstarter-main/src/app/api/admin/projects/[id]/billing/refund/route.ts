import { NextRequest, NextResponse } from 'next/server';
import { handleRefundRequest } from '@/lib/billing/refund-route';

/**
 * POST /api/admin/projects/[id]/billing/refund
 *
 * The operator console's "Refund setup fee" action. Same handler, same auth
 * and same rules as the `/api/team/...` copy: see
 * `src/lib/billing/refund-route.ts` for the body it takes and
 * `src/lib/billing/refund.ts` for what it does with it.
 *
 * The other four billing endpoints exist twice in this tree as two copies of
 * the same file that now differ only in a doc comment. A refund is the one
 * operation here that moves money the wrong way, so both routes call one
 * handler rather than carrying two chances to fix only one of them.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  return handleRefundRequest(req, params);
}
