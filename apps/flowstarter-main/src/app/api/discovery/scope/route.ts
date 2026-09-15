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
import { HOLD_COPY } from '@/lib/flowstarter/scope-route';
import { holdNotice, type PolicyLocale } from '@/lib/policy/copy';

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
 * What this endpoint answers when it could not decide.
 *
 * It used to be `self-serve`, described here as "the one fail-open in the
 * feature" on the reasoning that a broken classifier must not stop every
 * visitor reaching a preview. The reasoning was wrong in the one case it
 * mattered, and the showcase recorder filmed it twice on 2026-09-15: a rate
 * limit answered `429 {"route":"self-serve","reason":"unavailable"}`, the
 * wizard believed the `route` field, and a haulage client-portal brief got a
 * generated preview with an invented "Customer Portal" page and a EUR 159.80
 * deposit offer against work that should have been a discovery call.
 *
 * `self-serve` is not a neutral default. It is the single value in this
 * feature's vocabulary that means GENERATE, and handing it out because we
 * could not reach a decision is the same mistake #193 fixed one layer down:
 * a classifier that could not answer is not a classifier that said yes. So
 * the honest answer is `hold` -- #193's own state -- which stops, says so in
 * the visitor's language, mints no booking link and spends no generation
 * (`spendsGenerationBudget('hold')` is false).
 *
 * `reason: 'unavailable'` stays on the body, unchanged, so a browser running
 * an older bundle still has the one word it needs to tell "we could not
 * decide" from a real verdict.
 */
function unavailable(locale: PolicyLocale) {
  return {
    route: 'hold' as const,
    reason: 'unavailable',
    offerCopy: HOLD_COPY,
    policy: holdNotice(locale),
  };
}

/**
 * Nothing to classify: no body, no description, nothing said.
 *
 * Deliberately NOT `hold`. A hold tells a visitor a person is reading their
 * brief, and there is no brief -- telling them to wait for a reply to
 * something they never sent is a worse answer than carrying on. This is the
 * one branch where the product's default really is the honest answer, and it
 * carries its own reason so the browser can tell the two apart.
 */
const NOTHING_TO_CLASSIFY = {
  route: 'self-serve' as const,
  reason: 'no-brief',
};

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
    // The status stays 429 and `Retry-After` stays on it: the browser retries
    // on this clock rather than on a number of its own (see
    // `scopeRetryAfterSeconds` in `useScopeRoute`). What changed is the body,
    // which no longer says `self-serve`.
    //
    // The locale is read from the unparsed request here because the body has
    // not been read yet and must not be: refusing before parsing is what
    // makes an abusive body cheap to turn away.
    return NextResponse.json(unavailable(localeHint(req)), {
      status: 429,
      headers: { 'Retry-After': String(limit.retryAfter) },
    });
  }

  const body = await readJsonCapped(req);
  if (body.status !== 'ok') {
    return NextResponse.json(unavailable(localeHint(req)), { status: 200 });
  }
  const parsed = Schema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(unavailable(localeHint(req)), { status: 200 });
  }
  if (!parsed.data.description.trim()) {
    return NextResponse.json(NOTHING_TO_CLASSIFY, { status: 200 });
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
    //
    // `policy` goes out on `refused` and `hold` for the same reason, and only
    // then: it is the notice `@/lib/policy/copy` already wrote for this
    // verdict, in the visitor's own language, and sending it here is what
    // lets the funnel stop at the gate instead of routing a refused brief
    // onward to the step whose job is to start a generation.
    return NextResponse.json(
      {
        route: result.route,
        scope: result.scope,
        questionKey: result.questionKey,
        bookingUrl: result.bookingUrl,
        offerCopy: result.offerCopy,
        policy: result.notice ?? undefined,
      },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    console.error(
      '[scope] the routing gate failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json(unavailable(parsed.data.locale), { status: 200 });
  }
}

/**
 * The visitor's language when the body has not been parsed, or could not be.
 *
 * `Accept-Language` is the only signal left at that point, and it is only ever
 * used to pick which of two already-written notices to send. Anything that is
 * not Romanian is English, which is the default everywhere else in
 * `@/lib/policy/copy`.
 */
function localeHint(req: NextRequest): PolicyLocale {
  const header = req.headers.get('accept-language') ?? '';
  return /(^|[,\s])ro\b/i.test(header) ? 'ro' : 'en';
}
