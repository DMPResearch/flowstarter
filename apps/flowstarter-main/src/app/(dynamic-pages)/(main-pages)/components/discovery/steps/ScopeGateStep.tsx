'use client';

/**
 * What a visitor sees when the intake decides their project is not a site.
 *
 * Three faces, one per state of `useScopeRoute`, and the wizard renders this
 * instead of `PreviewStep` for all three. That substitution is the whole
 * mechanism by which custom work never costs a generation: `PreviewStep` is
 * what starts the build, and it is not on the page.
 *
 * The offer keeps the conversation's voice rather than turning into a landing
 * page. Somebody who has answered four questions in a chat and is then handed a
 * marketing section has been handed off, and it reads like one. So: the same
 * card, the same width, the plain sentence first, the studio named, and one
 * button.
 */
import { useState } from 'react';
import { Button } from '@flowstarter/flow-design-system';
import type { ScopeAnswerKey, ScopeRouteState } from '../useScopeRoute';
import type { PolicyNotice } from '@/lib/policy/copy';
import { POLICY_CARD, PolicyNoticeCard } from './PolicyNoticeCard';

const CARD = POLICY_CARD;

/**
 * The two answers that settle the question, plus an escape hatch.
 *
 * Chips rather than a text box by default, for the same reason the rest of the
 * script uses them: the question exists because the classifier could not tell,
 * and a one-tap answer is more likely to be given than a typed one. The third
 * option opens the composer for the person whose project is neither.
 */
const ANSWERS: readonly { key: ScopeAnswerKey; localeKey: string }[] = [
  { key: 'site', localeKey: 'landing.discovery.scope.answer.site' },
  { key: 'software', localeKey: 'landing.discovery.scope.answer.software' },
];

/**
 * The copy shown when the server did not name any.
 *
 * Deliberately the non-asserting pair. An offer screen that cannot tell which
 * verdict it is rendering must not guess the one that tells a visitor they
 * described something they did not: that guess is exactly the defect this
 * screen shipped with.
 */
const FALLBACK_COPY = {
  titleKey: 'landing.discovery.scope.review.title',
  bodyKey: 'landing.discovery.scope.review.body',
} as const;

/** The same discipline for the hold: if the server named no copy, say the true thing. */
const HOLD_FALLBACK_COPY = {
  titleKey: 'landing.discovery.scope.hold.title',
  bodyKey: 'landing.discovery.scope.hold.body',
} as const;

function Checking({ t }: { t: (key: string) => string }) {
  return (
    <div className={CARD} role="status" aria-live="polite">
      <h3 className="text-lg font-bold text-[var(--fs-ink)]">
        {t('landing.discovery.scope.checking')}
      </h3>
      <p className="mt-1 text-sm text-[var(--fs-ink-faint)]">
        {t('landing.discovery.scope.checkingBody')}
      </p>
    </div>
  );
}

function Question({
  t,
  questionKey,
  pending,
  onAnswer,
}: {
  t: (key: string) => string;
  questionKey: string;
  pending: boolean;
  onAnswer: (answer: string, answerKey?: ScopeAnswerKey) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');

  return (
    <div className={CARD}>
      <h3 className="text-lg font-bold text-[var(--fs-ink)]">
        {t(questionKey)}
      </h3>

      {typing ? (
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            // A typed answer names neither option, so it goes to the
            // classifier as evidence rather than to the rule as an answer.
            onAnswer(draft, 'other');
          }}
        >
          <label className="sr-only" htmlFor="scope-clarification">
            {t(questionKey)}
          </label>
          <textarea
            id="scope-clarification"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            maxLength={500}
            placeholder={t('landing.discovery.scope.answerPlaceholder')}
            className="w-full rounded-xl border border-[var(--fs-rule)] bg-transparent p-3 text-sm text-[var(--fs-ink)] outline-none"
          />
          <div>
            <Button type="submit" disabled={pending || !draft.trim()}>
              {t('landing.discovery.scope.send')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {ANSWERS.map((answer) => (
            <Button
              key={answer.key}
              type="button"
              variant="outline"
              disabled={pending}
              // The key travels with the sentence. The sentence is what the
              // classifier reads; the key is what the routing rule decides on.
              onClick={() => onAnswer(t(answer.localeKey), answer.key)}
            >
              {t(answer.localeKey)}
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setTyping(true)}
          >
            {t('landing.discovery.scope.answer.other')}
          </Button>
        </div>
      )}
    </div>
  );
}

function Offer({
  t,
  bookingUrl,
  copy,
}: {
  t: (key: string) => string;
  bookingUrl: string | null;
  copy?: { titleKey: string; bodyKey: string };
}) {
  // The server's rule chose these from the scope it actually settled. This
  // component never picks between them, which is the point: it used to hold
  // one sentence asserting the visitor had described software, and it showed
  // that sentence to people the gate had recorded as `unclear`.
  const { titleKey, bodyKey } = copy ?? FALLBACK_COPY;
  return (
    <div className={CARD}>
      <h3 className="text-lg font-bold text-[var(--fs-ink)]">{t(titleKey)}</h3>
      <p className="mt-2 text-sm text-[var(--fs-ink)]">{t(bodyKey)}</p>
      <p className="mt-3 text-sm text-[var(--fs-ink-faint)]">
        {t('landing.discovery.scope.offer.studio')}
      </p>

      {bookingUrl ? (
        <>
          {/*
            The calendar itself, not a link to it. A visitor who has just been
            told their project needs a different process should not also be
            asked to navigate somewhere to act on it. `title` rather than a
            label element because an iframe is the control here.
          */}
          <iframe
            title={t('discoveryCall.bookingTitle')}
            src={`${bookingUrl}${
              bookingUrl.includes('?') ? '&' : '?'
            }embed=true`}
            className="mt-5 h-[560px] w-full rounded-xl border border-[var(--fs-rule)]"
            loading="lazy"
          />
          <p className="mt-3 text-xs text-[var(--fs-ink-faint)]">
            {t('landing.discovery.scope.offer.prefilled')}{' '}
            {t('landing.discovery.scope.offer.emailed')}
          </p>
          <div className="mt-3">
            <Button asChild variant="outline">
              <a href={bookingUrl} target="_blank" rel="noreferrer">
                {t('landing.discovery.scope.offer.cta')}
              </a>
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-5 rounded-xl border border-[var(--fs-rule)] p-4">
          <p className="text-sm font-semibold text-[var(--fs-ink)]">
            {t('landing.discovery.scope.offer.fallbackTitle')}
          </p>
          <p className="mt-1 text-sm text-[var(--fs-ink-faint)]">
            {t('landing.discovery.scope.offer.fallbackBody')}
          </p>
          <p className="mt-3 text-xs text-[var(--fs-ink-faint)]">
            {t('landing.discovery.scope.offer.emailed')}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The hold: nothing could classify this brief, so a person reads it.
 *
 * A fourth face rather than a variant of `Offer`, and the differences are the
 * reason. `Offer` names DMPResearch and renders a calendar, both of which are
 * a sales motion; this brief has been read by nobody, so there is nothing to
 * sell and nobody has decided it is custom work. There is no CTA at all,
 * which is correct: the next move is ours, not the visitor's.
 *
 * Nor does it reuse the review copy. Telling somebody their business "sits
 * close enough to our acceptable-use policy that a person checks it" when in
 * truth our classifier timed out is a claim about their business we have no
 * basis for. `HOLD_COPY` in `scope-route.ts` says what happened instead.
 */
function Hold({
  t,
  copy,
  policy,
}: {
  t: (key: string) => string;
  copy?: { titleKey: string; bodyKey: string };
  policy?: PolicyNotice;
}) {
  // The server's notice wins when it sent one: it is already in the visitor's
  // language and it is the same sentence the preview route would have shown.
  // The locale keys are the fallback for a response that carried none.
  const { titleKey, bodyKey } = copy ?? HOLD_FALLBACK_COPY;
  return (
    <div className={CARD} role="status" aria-live="polite">
      <h3 className="text-lg font-bold text-[var(--fs-ink)]">
        {policy?.title ?? t(titleKey)}
      </h3>
      <p className="mt-2 text-sm text-[var(--fs-ink)]">
        {policy?.message ?? t(bodyKey)}
      </p>
      <p className="mt-3 text-sm text-[var(--fs-ink-faint)]">
        {policy?.next ?? t('landing.discovery.scope.hold.next')}
      </p>
    </div>
  );
}

/**
 * The refusal, said here rather than one screen later.
 *
 * Every word comes from `@/lib/policy/copy` through the server, which is the
 * house rule for this copy and the reason there are no locale keys in here:
 * the policy owns the sentence, the category label inside it, and the
 * language it is written in. This component owns the card it sits in.
 *
 * The card itself is `PolicyNoticeCard`, shared with the intake conversation:
 * both surfaces stop a visitor on the same verdict from the same gate, and
 * two near-identical refusal cards are how two screens come to disagree about
 * what the policy said. It renders nothing at all if the notice is missing,
 * which is deliberate -- inventing a refusal sentence in the browser is how a
 * screen ends up asserting something the gate never decided.
 */
function Refused({ policy }: { policy?: PolicyNotice }) {
  return <PolicyNoticeCard policy={policy} testId="scope-policy-notice" />;
}

export function ScopeGateStep({
  state,
  pending,
  onClarify,
  t,
}: {
  state: ScopeRouteState;
  pending: boolean;
  onClarify: (answer: string, answerKey?: ScopeAnswerKey) => void;
  t: (key: string) => string;
}) {
  if (state.status === 'question') {
    return (
      <Question
        t={t}
        questionKey={state.questionKey}
        pending={pending}
        onAnswer={onClarify}
      />
    );
  }
  if (state.status === 'refused') {
    return <Refused policy={state.policy} />;
  }
  if (state.status === 'hold') {
    return <Hold t={t} copy={state.copy} policy={state.policy} />;
  }
  if (state.status === 'offer') {
    return <Offer t={t} bookingUrl={state.bookingUrl} copy={state.copy} />;
  }
  return <Checking t={t} />;
}
