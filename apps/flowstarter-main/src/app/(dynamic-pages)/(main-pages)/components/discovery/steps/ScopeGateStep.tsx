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
import type { ScopeRouteState } from '../useScopeRoute';

const CARD =
  'rounded-2xl border border-[var(--fs-rule)] bg-[var(--fs-surface)] p-6 sm:p-7';

/**
 * The two answers that settle the question, plus an escape hatch.
 *
 * Chips rather than a text box by default, for the same reason the rest of the
 * script uses them: the question exists because the classifier could not tell,
 * and a one-tap answer is more likely to be given than a typed one. The third
 * option opens the composer for the person whose project is neither.
 */
const ANSWER_KEYS = [
  'landing.discovery.scope.answer.site',
  'landing.discovery.scope.answer.software',
] as const;

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
  onAnswer: (answer: string) => void;
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
            onAnswer(draft);
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
          {ANSWER_KEYS.map((key) => (
            <Button
              key={key}
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onAnswer(t(key))}
            >
              {t(key)}
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
}: {
  t: (key: string) => string;
  bookingUrl: string | null;
}) {
  return (
    <div className={CARD}>
      <h3 className="text-lg font-bold text-[var(--fs-ink)]">
        {t('landing.discovery.scope.offer.title')}
      </h3>
      <p className="mt-2 text-sm text-[var(--fs-ink)]">
        {t('landing.discovery.scope.offer.body')}
      </p>
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

export function ScopeGateStep({
  state,
  pending,
  onClarify,
  t,
}: {
  state: ScopeRouteState;
  pending: boolean;
  onClarify: (answer: string) => void;
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
  if (state.status === 'offer') {
    return <Offer t={t} bookingUrl={state.bookingUrl} />;
  }
  return <Checking t={t} />;
}
