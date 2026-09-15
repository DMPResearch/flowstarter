'use client';

/**
 * The routing gate, as the browser sees it.
 *
 * It runs once, at the moment the quick conversation runs dry and before
 * anything mounts `PreviewStep`. That ordering is the feature: `PreviewStep`
 * is what POSTs to `/api/discovery/preview/live`, so as long as it is not
 * mounted until this hook says `self-serve`, a custom work brief cannot spend
 * a generation. There is no second check inside the expensive route to keep in
 * sync, because there is no way to reach the expensive route.
 *
 * Three outcomes, mirroring `decideRoute`:
 *
 *   self-serve   the preview continues exactly as it did before this existed
 *   question     one clarifying question, asked in the conversation's own
 *                voice, answered once, and then this hook runs a second and
 *                final time with the answer attached
 *   offer        the discovery call, and no generation
 *
 * Fails open to `self-serve` when the funnel is UNREACHABLE -- the request
 * threw, there was no answer at all. A network error must not stand between a
 * visitor and the product, and the right answer to a dead route is the default
 * product.
 *
 * It does NOT fail open when the route ANSWERS and says it could not decide.
 * That distinction is finding 2 from the 2026-09-15 showcase run and it is the
 * whole of the second fix below. `/api/discovery/scope` answers a rate limit
 * with `429 {"route":"self-serve","reason":"unavailable"}` and a `Retry-After`
 * header; this hook read the `route` field, took `self-serve` at face value,
 * mounted `PreviewStep`, and generated a preview for a haulage client-portal
 * brief -- an invented "Customer Portal" page, the simpler-preview copy and a
 * EUR 159.80 deposit offer against work that should have been a discovery
 * call with no price on it. Twice, on film.
 *
 * A gate that could not answer is not a gate that said yes (#193). So a
 * response carrying `reason: 'unavailable'`, or any non-OK status, is a
 * `hold`: the visitor reads the hold copy, nothing generates, and the hook
 * retries on the server's own clock a bounded number of times.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalI18n } from '@/lib/i18n';
import type { PolicyLocale, PolicyNotice } from '@/lib/policy/copy';
import type { DiscoveryData } from './discovery.logic';

/**
 * How many times a held brief re-asks, and how long it waits.
 *
 * Named, and here rather than at the call site, because "retry after the
 * server's `Retry-After`" is a rule and a magic `60` buried in a `setTimeout`
 * is not one an operator can find.
 *
 * `SCOPE_RETRY_ATTEMPTS` is the bound. Three re-asks over roughly three
 * minutes covers the one-minute sliding window the route's limiter advertises
 * twice over; past that the visitor is genuinely waiting on a person, which is
 * exactly what the hold copy already tells them, and an unbounded retry would
 * be this browser tab quietly turning itself into the load that caused the
 * rate limit.
 */
export const SCOPE_RETRY_ATTEMPTS = 3;
/** Used when the response carried no usable `Retry-After`. */
export const SCOPE_RETRY_DEFAULT_SECONDS = 60;
/**
 * A ceiling on what we will honour from a header. A route that asks for an
 * hour is either wrong or hostile, and either way a visitor is not sitting in
 * front of a spinner for it; the hold copy has already promised them a person,
 * so we stop retrying rather than wait.
 */
export const SCOPE_RETRY_MAX_SECONDS = 300;

/**
 * The server said it could not decide, in the one word every route in the
 * funnel uses for it. `FALLBACK` in `src/app/api/discovery/scope/route.ts`
 * sends it; nothing else does.
 */
const UNAVAILABLE = 'unavailable';

/**
 * Seconds to wait before re-asking, from the response the route actually sent.
 *
 * Exported for its own test: `Retry-After` is defined as either a delta in
 * seconds or an HTTP date, and a browser that guessed wrong would either
 * hammer the route or strand the visitor. Anything unparseable, negative or
 * past the ceiling falls back to the documented default rather than to zero.
 */
export function scopeRetryAfterSeconds(header: string | null): number {
  if (!header) return SCOPE_RETRY_DEFAULT_SECONDS;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return SCOPE_RETRY_DEFAULT_SECONDS;
    return Math.min(Math.ceil(seconds), SCOPE_RETRY_MAX_SECONDS);
  }
  const at = Date.parse(header);
  if (!Number.isFinite(at)) return SCOPE_RETRY_DEFAULT_SECONDS;
  const delta = Math.ceil((at - Date.now()) / 1000);
  if (delta <= 0) return SCOPE_RETRY_DEFAULT_SECONDS;
  return Math.min(delta, SCOPE_RETRY_MAX_SECONDS);
}

/** The answers the question offers, as the keys the rule reads. */
export type ScopeAnswerKey = 'site' | 'software' | 'other';

/** Which copy the offer screen may show. The server decides; this carries it. */
export interface ScopeOfferCopy {
  titleKey: string;
  bodyKey: string;
}

export type ScopeRouteState =
  | { status: 'checking' }
  | { status: 'self-serve' }
  | { status: 'question'; questionKey: string }
  | {
      status: 'offer';
      bookingUrl: string | null;
      /** Absent when an older response shape arrives. See `ScopeGateStep`. */
      copy?: ScopeOfferCopy;
    }
  /**
   * Nothing could classify the brief, so a person will read it.
   *
   * Its own state and not a flavour of `offer`, because the offer screen
   * names Darius's studio and shows a calendar, and neither belongs on a
   * brief nobody has read. Carries no `bookingUrl` by construction: the type
   * is the guarantee that this screen cannot render one.
   */
  | { status: 'hold'; copy?: ScopeOfferCopy; policy?: PolicyNotice }
  /**
   * Refused at the gate, with the sentence the policy wrote.
   *
   * Like `hold`, this exists so the wizard never mounts `PreviewStep` for a
   * brief the gate has already answered. It used to fall through to
   * `self-serve` and let the preview route say no a screen later, which meant
   * a refused brief was handed to the component that starts generations and
   * stopped only by a SECOND classifier call over different text.
   */
  | { status: 'refused'; policy?: PolicyNotice };

interface ScopeResponse {
  route?: string;
  questionKey?: string;
  bookingUrl?: string | null;
  offerCopy?: ScopeOfferCopy;
  /** Present on `refused` and `hold`. Written by `@/lib/policy/copy`. */
  policy?: PolicyNotice;
  /**
   * The route's own admission that nothing decided this. Set alongside
   * `route: 'self-serve'` on a rate limit, an unreadable body and a handler
   * that threw. The word, not the status code, is what this hook reads --
   * a 200 carrying it means exactly what the 429 carrying it means.
   */
  reason?: string;
}

/**
 * True when the route answered without deciding anything.
 *
 * Read BEFORE `route`, always. The body on all three of these branches says
 * `self-serve`, which is the one value that lets a brief through to a
 * generation, and the `reason` beside it is the route telling us not to
 * believe it. A non-OK status is included on its own so a future failure mode
 * that forgets the field -- a proxy's own 429 page, a 502 from in front of the
 * app -- cannot become a preview either.
 */
function cannotDecide(ok: boolean, json: ScopeResponse): boolean {
  return !ok || json.reason === UNAVAILABLE;
}

function stateFrom(json: ScopeResponse): ScopeRouteState {
  if (json.route === 'discovery-call') {
    return {
      status: 'offer',
      bookingUrl: json.bookingUrl ?? null,
      copy: json.offerCopy,
    };
  }
  // Checked before the question and before the default. These are the two
  // routes the browser may NOT fail open on: falling through to `self-serve`
  // here would mount `PreviewStep`, and `PreviewStep` starts a generation on
  // mount. The `bookingUrl` the server sends is deliberately absent on both
  // and is not read even if a stale deploy sends one.
  if (json.route === 'refused') {
    return { status: 'refused', policy: json.policy };
  }
  if (json.route === 'hold') {
    return { status: 'hold', copy: json.offerCopy, policy: json.policy };
  }
  if (json.route === 'ask-one-more-question' && json.questionKey) {
    return { status: 'question', questionKey: json.questionKey };
  }
  return { status: 'self-serve' };
}

export interface UseScopeRouteResult {
  state: ScopeRouteState;
  /**
   * Answer the clarifying question. Re-classifies once and never asks again.
   *
   * `answerKey` is what the rule decides on, and it is sent separately from
   * the text because the text is a translated sentence. The version of this
   * that sent only the sentence is the version where an explicit answer
   * changed the route and not the verdict.
   */
  clarify: (answer: string, answerKey?: ScopeAnswerKey) => void;
  /** True while a request is in flight, for the composer's disabled state. */
  pending: boolean;
}

export function useScopeRoute(input: {
  data: DiscoveryData;
  /** Only true once the conversation is over. Nothing runs before that. */
  active: boolean;
}): UseScopeRouteResult {
  const [state, setState] = useState<ScopeRouteState>({ status: 'checking' });
  const [pending, setPending] = useState(false);
  const { data, active } = input;

  /**
   * The visitor's language, for the gate's notice only.
   *
   * `useOptionalI18n` rather than a prop: the wizard threads `t` down but no
   * locale, and until this was sent the refusal and hold notices -- which
   * `@/lib/policy/copy` writes in both languages -- always came back English,
   * because the route defaults an absent `locale` to `'en'`. A Romanian
   * visitor read a Romanian conversation and an English refusal.
   */
  const pageLocale = useOptionalI18n()?.locale;
  const locale: PolicyLocale = pageLocale === 'ro' ? 'ro' : 'en';

  /**
   * The pending re-ask, so a visitor who edits their brief or unmounts the
   * wizard does not have an old one fire underneath them.
   */
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRetry = useCallback(() => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);
  const scheduleRetry = useCallback(
    (again: () => void, seconds: number) => {
      cancelRetry();
      retryTimer.current = setTimeout(again, seconds * 1000);
    },
    [cancelRetry]
  );
  useEffect(() => cancelRetry, [cancelRetry]);

  /**
   * What was last classified, so the gate runs once per brief rather than once
   * per render. `data` is a new object on every change anywhere in the wizard,
   * so an effect keyed on it would re-classify, re-bill and re-file a lead
   * constantly.
   *
   * It is the brief and not a boolean because a visitor can go back from the
   * offer, change what their business does, and come forward again. That is a
   * different brief and it deserves a different answer; a `started` flag would
   * have shown them the old verdict for the rest of the session.
   */
  const brief = [
    data.description,
    data.instagramUrl,
    data.linkedinUrl,
    data.websiteUrl ?? '',
  ].join('\x00');
  const classified = useRef<string | null>(null);

  const run = useCallback(
    async (
      clarification?: string,
      answerKey?: ScopeAnswerKey,
      attempt = 1
    ): Promise<void> => {
      setPending(true);
      try {
        const res = await fetch('/api/discovery/scope', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName: data.fullName,
            email: data.email,
            description: data.description,
            instagramUrl: data.instagramUrl,
            linkedinUrl: data.linkedinUrl,
            websiteUrl: data.websiteUrl ?? '',
            locale,
            ...(clarification ? { clarification } : {}),
            ...(answerKey ? { answerKey } : {}),
          }),
        });
        // Read before the body is parsed: a 429's headers are the only part of
        // it that carries a clock, and a body that fails to parse must not
        // lose it.
        const retryAfter = scopeRetryAfterSeconds(
          res.headers?.get?.('Retry-After') ?? null
        );
        const json = (await res.json()) as ScopeResponse;

        if (cannotDecide(res.ok, json)) {
          // Not `stateFrom(json)`, which would read `route` and believe it.
          // The body says `self-serve` and the body is wrong: nothing
          // classified this brief, so nobody may act on it -- the same rule
          // #193 wrote into the server for an unavailable classifier, applied
          // to an unavailable ROUTE.
          //
          // The notice and the copy still come across when the server sent
          // them (it does now: see `unavailable()` in the route), so the
          // screen says the sentence `@/lib/policy/copy` wrote, in the
          // visitor's language, rather than the locale-key fallback. An older
          // deploy sends neither, and `ScopeGateStep`'s hold face handles
          // that on its own.
          setState({
            status: 'hold',
            copy: json.offerCopy,
            policy: json.policy,
          });
          if (attempt < SCOPE_RETRY_ATTEMPTS) {
            scheduleRetry(
              () => void run(clarification, answerKey, attempt + 1),
              retryAfter
            );
          }
          return;
        }
        setState(stateFrom(json));
      } catch {
        // No answer at all, as opposed to an answer that could not decide.
        // See the module doc: an unreachable funnel is the one thing the
        // browser still fails open on.
        setState({ status: 'self-serve' });
      } finally {
        setPending(false);
      }
    },
    [
      data.fullName,
      data.email,
      data.description,
      data.instagramUrl,
      data.linkedinUrl,
      data.websiteUrl,
      locale,
      scheduleRetry,
    ]
  );

  useEffect(() => {
    if (!active || classified.current === brief) return;
    classified.current = brief;
    // A different brief deserves a fresh answer, not the re-ask queued
    // against the old one.
    cancelRetry();
    setState({ status: 'checking' });
    void run();
  }, [active, brief, run, cancelRetry]);

  const clarify = useCallback(
    (answer: string, answerKey?: ScopeAnswerKey) => {
      const trimmed = answer.trim();
      if (!trimmed || pending) return;
      cancelRetry();
      setState({ status: 'checking' });
      void run(trimmed, answerKey);
    },
    [pending, run, cancelRetry]
  );

  return { state, clarify, pending };
}
