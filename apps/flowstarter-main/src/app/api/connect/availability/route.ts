/**
 * GET /api/connect/availability
 *
 * Which connect buttons this deployment can offer, and for the ones it cannot,
 * the names of the environment variables that are missing. The intake asks
 * before it paints the row, so a deployment without credentials renders a
 * disabled button with a reason instead of a button that leads nowhere.
 *
 * Always 200. "Neither provider is configured" is an answer, not an error, and
 * a non-200 here would make the intake treat a correctly reported absence as a
 * fetch failure and show nothing at all.
 *
 * No rate limit: the handler reads a few environment variables and touches
 * nothing else, so there is nothing here to exhaust. No secrets in the body
 * either, which is a property of `portraitProviderAvailability` rather than of
 * this file: it returns env var names and never values.
 */
import { NextResponse } from 'next/server';

import { portraitProviderAvailability } from '@/lib/flowstarter/portrait-availability';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ providers: portraitProviderAvailability() });
}
