/**
 * POST /api/discovery/scope -- standard site, or custom work?
 *
 * The last thing that happens before generation, and the only thing that can
 * stop it. The wizard calls this once when the four quick questions run out,
 * and at most once more with the visitor's answer to the clarifying question.
 * Until it answers `self-serve` the browser does not call
 * `/api/discovery/preview/live` at all, which is how "custom work never spends
 * generation budget" is true by construction rather than by a check inside the
 * expensive route.
 *
 * Anonymous, like every other endpoint in the funnel at this point: there is no
 * session yet and there never will be for the custom branch. Rate limited per
 * IP for the same reason the live preview route is -- it makes one model call
 * and, on the custom branch, sends two emails.
 *
 * Nothing here decides anything. The handler validates, calls `runScopeGate`,
 * and serialises the answer.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { readJsonCapped } from '@/lib/net/ingress';
import { routeLimiter } from '@/lib/security/route-limits';
import { clientIp } from '@/lib/request-ip';
import { runScopeGate } from '@/lib/flowstarter/scope-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** One model call plus at most one four-second page read, and two emails. */
export const maxDuration = 30;

const Schema = z.object({
  fullName: z.string().max(200).optional().default(''),
  // Not `.email()`: a typo must not turn into a dead end at the one moment the
  // visitor is about to be shown something. The address is used to prefill a
  // booking page and to send a confirmation, and both degrade quietly.
  email: z.string().max(320).optional().default(''),
  description: z.string().max(5_000).optional().default(''),
  instagramUrl: z.string().max(300).optional().default(''),
  linkedinUrl: z.string().max(300).optional().default(''),
  websiteUrl: z.string().max(300).optional().default(''),
  /** Set only on the second pass. Its presence is what "clarified" means. */
  clarification: z.string().max(500).optional(),
  /**
   * The visitor's language, the same field `intake-graph`, `intake-chat` and
   * `business-names` already accept. Read only by the acceptable-use screen
   * inside `runScopeGate`, so a refused or held brief's notice comes back in
   * the visitor's own language rather than always English. Does not touch
   * `decideRoute` or the route table.
   */
  locale: z.enum(['en', 'ro']).optional().default('en'),
  /**
   * Which of the offered answers the visitor tapped, as a key.
   *
   * The key and not the sentence, so the routing rule reads a decided value
   * rather than matching an English label that a second locale would change.
   * Anything that is not one of the three is dropped rather than refused: a
   * stale browser tab posting an older shape must still reach a preview, and
   * a dropped key degrades to exactly the behaviour of a typed answer.
   */
  answerKey: z.enum(['site', 'software', 'other']).optional().catch(undefined),
});

/**
 * What the wizard falls back to when this endpoint cannot answer.
 *
 * `self-serve`, deliberately, and it is the one fail-open in the feature. The
 * alternative is that a broken classifier, a rate limit or a bad deploy stops
 * every visitor from ever reaching a preview, which is the funnel being down.
 * The gate itself already fails closed where it counts -- a classification that
 * throws returns `unclear`, which asks rather than builds -- so this branch is
 * only reached when the handler could not run at all, and at that point the
 * honest default is the product's default.
 */
const FALLBACK = { route: 'self-serve' as const, reason: 'unavailable' };

export async function POST(req: NextRequest) {
  // Per-IP, backed by Arcjet (see `routeLimiter` and
  // docs/security/rate-limits.md). A genuine visitor calls this twice at most
  // per completed intake. Checked before any parsing, so an abusive body is
  // cheap to refuse.
  const limit = await routeLimiter('discovery-scope').check(
    req,
    clientIp(req.headers)
  );
  if (!limit.ok) {
    return NextResponse.json(FALLBACK, {
      status: 429,
      headers: { 'Retry-After': String(limit.retryAfter) },
    });
  }

  const body = await readJsonCapped(req);
  if (body.status !== 'ok') {
    return NextResponse.json(FALLBACK, { status: 200 });
  }
  const parsed = Schema.safeParse(body.value);
  if (!parsed.success || !parsed.data.description.trim()) {
    return NextResponse.json(FALLBACK, { status: 200 });
  }

  try {
    const result = await runScopeGate({
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      description: parsed.data.description,
      instagramUrl: parsed.data.instagramUrl,
      linkedinUrl: parsed.data.linkedinUrl,
      websiteUrl: parsed.data.websiteUrl,
      clarification: parsed.data.clarification,
      locale: parsed.data.locale,
      answerKey: parsed.data.answerKey,
    });
    // `evidence`, `leadId` and the classifier's own verdict stay on the
    // server: the evidence is for the operator's card, the id is an internal
    // handle, and neither is something the visitor's browser has any use for.
    //
    // `offerCopy` goes out because the rule, not the screen, decides which
    // sentence a visitor is shown. A screen that picked its own copy is how
    // "what you have described is software" ended up on top of a recorded
    // scope of `unclear`.
    return NextResponse.json(
      {
        route: result.route,
        scope: result.scope,
        questionKey: result.questionKey,
        bookingUrl: result.bookingUrl,
        offerCopy: result.offerCopy,
      },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    console.error(
      '[scope] the routing gate failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json(FALLBACK, { status: 200 });
  }
}
