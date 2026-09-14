/**
 * POST /api/internal/policy/scan
 *
 * The build worker's acceptable-use callback: "here is the text the site I
 * just built would render, is it allowed?"
 *
 * It exists so there is exactly ONE classifier in the system. The worker runs
 * in a different process on a different box, with no access to the policy
 * module, the prompt version or the thresholds. Giving it a second copy of any
 * of those is how a gate drifts: the intake refuses a business on Monday and
 * the build ships it on Friday because one of the two lists was edited. So the
 * worker asks here, and the answer comes from the same `screenAcceptableUse`
 * the intake, the brief and the checkout call.
 *
 * Auth: `Authorization: Bearer <FLOWSTARTER_BUILD_WORKER_SECRET>`, the same
 * secret this app signs its dispatch to the worker with. No user session: the
 * caller is a service.
 *
 * Body: { text, workspaceId?, projectId? }
 * 200:  { decision, categoryId, categoryLabel, evidence, evidenceHash }
 *
 * The scanned text is not stored and not logged. A blocked scan writes the
 * usual `policy_reviews` row, which carries the hash and the classifier's one
 * sentence, and the project lands on the operator board like any other hold.
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  authorizeBuildWorker,
  buildWorkerSecret,
} from '@/lib/hosting/build-worker-deploy';
import { policyLimits } from '@/lib/policy/acceptable-use';
import { screenAcceptableUse } from '@/lib/policy/gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  if (!buildWorkerSecret()) {
    return NextResponse.json(
      {
        error:
          'FLOWSTARTER_BUILD_WORKER_SECRET is not configured (must be at least 32 characters)',
      },
      { status: 503 }
    );
  }
  if (!authorizeBuildWorker(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    text?: unknown;
    workspaceId?: unknown;
    projectId?: unknown;
  };

  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }
  const workspaceId =
    typeof body.workspaceId === 'string' && UUID.test(body.workspaceId)
      ? body.workspaceId
      : null;

  // The worker already caps what it sends; this is the server's own ceiling,
  // because a trusted caller with a bug is still a caller that can hand a
  // classifier a gigabyte.
  const text = body.text.slice(0, policyLimits().scanMaxChars);

  const screening = await screenAcceptableUse({
    surface: 'built_site',
    text,
    workspaceId,
    projectId: workspaceId,
    actor: 'build-worker',
  });

  return NextResponse.json({
    decision: screening.verdict.decision,
    categoryId: screening.verdict.category.id,
    categoryLabel: screening.verdict.category.label,
    evidence: screening.classification.evidence,
    evidenceHash: screening.classification.evidenceHash,
  });
}
