/**
 * GET /api/connect/instagram/callback
 *
 * Where Instagram sends the person back, with a code or with a refusal. A URL
 * anybody can request, so the signed state is verified before anything else is
 * read, and the preview this picture belongs to comes from that state and
 * never from the query string. Always ends in a 302 to a path on our own
 * origin carrying `?portrait=<outcome>&portraitProvider=instagram`.
 *
 * The behaviour is in `../../connect-flow.ts`, shared with LinkedIn.
 */
import type { NextRequest } from 'next/server';

import { finishConnect } from '../../connect-flow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (request: NextRequest) =>
  finishConnect(request, 'instagram');
