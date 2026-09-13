/**
 * GET /api/connect/instagram/start
 *
 * "Use my Instagram photo". Binds the round trip to the preview or workspace
 * on the query string, signs that binding into the state, and sends the person
 * to Instagram to authorise `instagram_business_basic`. Business and creator
 * accounts only: a personal account cannot be read by any endpoint since Basic
 * Display was retired, which `portrait-source.ts` reports as its own reason
 * rather than as a failure to retry. Answers 200 with `available: false` when
 * this deployment has no Instagram app configured.
 *
 * The behaviour is in `../../connect-flow.ts`, shared with LinkedIn, so the
 * two providers cannot drift apart on any of the checks.
 */
import type { NextRequest } from 'next/server';

import { startConnect } from '../../connect-flow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (request: NextRequest) => startConnect(request, 'instagram');
