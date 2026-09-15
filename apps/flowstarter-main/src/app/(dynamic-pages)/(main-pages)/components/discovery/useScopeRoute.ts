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
 * Fails open to `self-serve`. A network error here must not stand between a
 * visitor and the product; the server side already fails closed where closing
 * is cheap (a classification that throws returns `unclear`, which asks rather
 * than builds), so what is left for the browser to handle is the funnel being
 * unreachable, and the right answer to that is the default product.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PolicyNotice } from '@/lib/policy/copy';
import type { DiscoveryData } from './discovery.logic';

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
    async (clarification?: string, answerKey?: ScopeAnswerKey) => {
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
            ...(clarification ? { clarification } : {}),
            ...(answerKey ? { answerKey } : {}),
          }),
        });
        const json = (await res.json()) as ScopeResponse;
        setState(stateFrom(json));
      } catch {
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
    ]
  );

  useEffect(() => {
    if (!active || classified.current === brief) return;
    classified.current = brief;
    setState({ status: 'checking' });
    void run();
  }, [active, brief, run]);

  const clarify = useCallback(
    (answer: string, answerKey?: ScopeAnswerKey) => {
      const trimmed = answer.trim();
      if (!trimmed || pending) return;
      setState({ status: 'checking' });
      void run(trimmed, answerKey);
    },
    [pending, run]
  );

  return { state, clarify, pending };
}
