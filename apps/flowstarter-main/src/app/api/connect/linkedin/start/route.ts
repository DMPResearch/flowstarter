/**
 * GET /api/connect/linkedin/start
 *
 * "Use my LinkedIn photo". Binds the round trip to the preview or workspace on
 * the query string, signs that binding into the state, and sends the person to
 * LinkedIn to authorise `openid profile email`. Answers 200 with
 * `available: false` on a deployment with no LinkedIn credentials, so the
 * button can render disabled rather than broken.
 *
 * The behaviour is in `../../connect-flow.ts`, shared with Instagram, so the
 * two providers cannot drift apart on any of the checks.
 */
import type { NextRequest } from 'next/server';

import { startConnect } from '../../connect-flow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (request: NextRequest) => startConnect(request, 'linkedin');
