'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@flowstarter/flow-design-system';
import {
  type DiscoveryData,
  type Step,
  type Tier,
  DEMO_STATE_KEY,
  EMPTY_DISCOVERY,
  INFO_STEP,
  LAST_STEP,
  STEPS,
  canProceed,
  recommendTier,
} from './discovery.logic';
import { DiscoveryStepper } from './DiscoveryStepper';
import {
  type IntakeQuestionId,
  CONVERSATION_LAST_STEP,
  questionById,
  stepForConversation,
} from './intake-script';
import { IntakeConversation } from './steps/IntakeConversation';
import { IntakeGraphConversation } from './steps/IntakeGraphConversation';
import { InfoAgentStep } from './steps/InfoAgentStep';
import { PreviewStep } from './steps/PreviewStep';

/**
 * The LangGraph HITL intake is the default: the model leads the conversation,
 * reacting to what the visitor said before it asks the next scripted
 * question. `NEXT_PUBLIC_FLOWSTARTER_INTAKE_GRAPH=false` is the kill switch —
 * set it to fall back to the fully scripted conversation, with no model in
 * the loop at all.
 */
const USE_INTAKE_GRAPH =
  process.env.NEXT_PUBLIC_FLOWSTARTER_INTAKE_GRAPH !== 'false' &&
  process.env.VITEST !== 'true' &&
  process.env.NODE_ENV !== 'test';

/**
 * Draft autosave. sessionStorage (not localStorage) on purpose: the draft
 * holds PII (name/email), so it should survive a refresh but not linger
 * across browser sessions. Cleared on submit.
 */
const DRAFT_KEY = 'fs-discovery-draft-v1';

interface Draft {
  data: DiscoveryData;
  step: Step;
  /**
   * Which questions the visitor has already dealt with. The conversation's
   * cursor, kept here rather than on `DiscoveryData` because it is wizard
   * bookkeeping — an answer left blank on purpose is indistinguishable from an
   * unasked one in the data alone, and nothing downstream of the preview has
   * any business knowing about it.
   *
   * A v1 draft (saved by the form this replaced) has no cursor, so it restores
   * to the top of the conversation with every answer it captured waiting in
   * its composer — asked again, but never from nothing.
   */
  answered: IntakeQuestionId[];
}

function loadDraft(): Draft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (!parsed || typeof parsed !== 'object' || !parsed.data) return null;
    const stepNum = Number(parsed.step);
    const step = (
      Number.isFinite(stepNum) ? Math.min(LAST_STEP, Math.max(1, stepNum)) : 1
    ) as Step;
    // Drop anything the script no longer recognises, so a renamed question in
    // a newer build cannot leave an old draft stuck on a cursor that is gone.
    const answered = (
      Array.isArray(parsed.answered) ? parsed.answered : []
    ).filter((id): id is IntakeQuestionId => Boolean(questionById(String(id))));
    // Merge over EMPTY so a schema change can't yield missing keys.
    return {
      data: { ...EMPTY_DISCOVERY, ...parsed.data },
      step,
      answered,
    };
  } catch {
    return null;
  }
}

function clearDraft(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
    window.sessionStorage.removeItem(DEMO_STATE_KEY);
  } catch {
    // ignore
  }
}

export interface DiscoveryCompletePayload {
  tier: Tier;
  data: DiscoveryData;
}

export function DiscoveryWizard({
  initialTier,
  source,
  onComplete,
  onWideChange,
  conversationPaceMs,
  t,
}: {
  initialTier?: Tier | null;
  source: string;
  onComplete: (payload: DiscoveryCompletePayload) => void;
  /** Signals the host modal to widen for the large preview step. */
  onWideChange?: (wide: boolean) => void;
  /** The agent's pause before a new question. Tests pass 0; the default is the conversation's. */
  conversationPaceMs?: number;
  t: (key: string) => string;
}) {
  // Restore an in-progress draft so a refresh doesn't lose the input.
  const [step, setStep] = useState<Step>(() => loadDraft()?.step ?? 1);
  const [data, setData] = useState<DiscoveryData>(() => {
    const draft = loadDraft();
    if (draft) {
      // Keep a pricing-card pre-selection only if the draft didn't set one.
      return draft.data.selectedTier
        ? draft.data
        : { ...draft.data, selectedTier: initialTier ?? '' };
    }
    return { ...EMPTY_DISCOVERY, selectedTier: initialTier ?? '' };
  });
  const [answered, setAnswered] = useState<IntakeQuestionId[]>(
    () => loadDraft()?.answered ?? []
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Persist the draft on every change (cheap; object is small).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ data, step, answered })
      );
    } catch {
      // storage full / disabled — autosave is best-effort
    }
  }, [answered, data, step]);

  /**
   * The conversation moves the wizard, not the other way round.
   *
   * `step` is still the wizard's spine — it decides what is rendered, what the
   * draft restores to, and (through `canProceed`) what counts as passable — but
   * while the intake is being talked through, the step is a *consequence* of
   * which question is on screen rather than something the visitor navigates.
   * The script decides the order; this only follows it. When the script runs
   * out of questions — every applicable required question answered, the two
   * commercial panels included — the conversation is over, and the wizard
   * hands off to the info agent. There is no other way to reach it.
   */
  useEffect(() => {
    if (step > CONVERSATION_LAST_STEP) return;
    const target = stepForConversation(data, answered, INFO_STEP);
    if (target !== step) setStep(target);
  }, [answered, data, step]);

  // The concierge stage — the info agent and the preview it flows into — is
  // two panes wide, so the modal widens one step earlier than it used to and
  // stays wide. Widening at the preview alone would have resized the modal
  // underneath a conversation that never stopped.
  //
  // Re-asserted on the next macrotask as well as immediately: the host modal
  // clears its own `wide` flag when it opens, and React runs this child's
  // effects *before* the parent's, so a wizard that mounts straight onto the
  // concierge stage (a restored draft) would otherwise be reset back to narrow
  // a moment after asking for the room it needs.
  useEffect(() => {
    const wide = step >= INFO_STEP;
    onWideChange?.(wide);
    const reassert = setTimeout(() => onWideChange?.(wide), 0);
    return () => clearTimeout(reassert);
  }, [step, onWideChange]);

  const update = useCallback(
    <K extends keyof DiscoveryData>(key: K, value: DiscoveryData[K]) => {
      setData((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const proceed = canProceed(step, data);
  const talking = step <= CONVERSATION_LAST_STEP;

  const handleNext = useCallback(() => {
    if (!proceed) return;
    setStep((s) => Math.min(LAST_STEP, s + 1) as Step);
  }, [proceed]);

  /**
   * Back, in a conversation, is "unsay the last thing". The question returns
   * to the composer with the old answer in it; the step follows.
   */
  const handleBack = useCallback(() => {
    if (step > INFO_STEP) {
      setStep(INFO_STEP);
      return;
    }
    setAnswered((previous) => previous.slice(0, -1));
    if (step === INFO_STEP) setStep(CONVERSATION_LAST_STEP);
  }, [step]);

  const handleAnswer = useCallback((id: IntakeQuestionId, raw: string) => {
    const question = questionById(id);
    if (!question) return;
    setData((previous) => question.apply(previous, raw));
    setAnswered((previous) =>
      previous.includes(id) ? previous : [...previous, id]
    );
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!proceed) return;
    setSubmitting(true);
    setSubmitError(null);
    const tier = (data.selectedTier as Tier | '') || recommendTier(data).tier;

    // Best-effort lead capture — never block the user from booking.
    try {
      const leadRes = await fetch('/api/discovery/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, selectedTier: tier, source }),
      });
      await leadRes.json().catch(() => ({}));
    } catch {
      // Swallow — capture is non-blocking
    }

    // Submitted — drop the autosaved draft. Payment is deliberately not part
    // of discovery: the exact 20% build deposit is offered only after the
    // generated preview and server-owned final quote are approved.
    clearDraft();
    setSubmitting(false);
    onComplete({ tier: tier as Tier, data });
  }, [data, onComplete, proceed, source]);

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--purple-primary)] mb-2">
          {t('landing.discovery.eyebrow')}
        </p>
        <h2 className="text-xl sm:text-2xl font-bold text-[var(--fs-ink)] leading-tight">
          {t(
            talking
              ? 'landing.discovery.chat.title'
              : step === INFO_STEP
              ? 'landing.discovery.steps.info.title'
              : 'landing.discovery.steps.preview.title'
          )}
        </h2>
      </div>

      <DiscoveryStepper
        steps={STEPS}
        current={step}
        data={data}
        answered={answered}
        t={t}
      />

      {/* Step body. Steps 1–6 are one conversation; the numbered indicator
          they used to sit under went with the form, replaced by the stepper
          above and the quiet progress line it draws while the script runs. */}
      <section>
        {talking &&
          (USE_INTAKE_GRAPH ? (
            <IntakeGraphConversation
              data={data}
              update={update}
              answered={answered}
              onState={({ data: nextData, answered: nextAnswered }) => {
                setData(nextData);
                setAnswered(nextAnswered);
              }}
              t={t}
            />
          ) : (
            <IntakeConversation
              data={data}
              update={update}
              answered={answered}
              onAnswer={handleAnswer}
              paceMs={conversationPaceMs}
              t={t}
            />
          ))}
        {step === INFO_STEP && (
          <InfoAgentStep
            data={data}
            setData={setData}
            // Skipping is a jump to the preview, not a refusal: the wizard
            // treats this step as passed either way (see `canProceed`).
            onSkip={() => setStep(LAST_STEP)}
          />
        )}
        {step === LAST_STEP && <PreviewStep data={data} t={t} />}
      </section>

      {submitError && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-500/30 bg-red-500/[0.07] p-3 text-sm text-red-700 dark:text-red-300"
        >
          {submitError}
        </div>
      )}

      {/* Nav — uses the design-system Button so the radius, height, and weight
          are guaranteed to match every other button on the site. */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-[var(--fs-rule)] pt-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleBack}
          disabled={step === 1 && answered.length === 0}
          icon={
            <svg
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 19l-7-7 7-7"
              />
            </svg>
          }
          iconPosition="left"
        >
          {t('landing.discovery.nav.back')}
        </Button>

        {/* No Continue while the intake is being talked through: the composer
            and the quick replies are the way forward, and a second forward
            button next to them is the form leaking back in. */}
        {talking ? null : step < LAST_STEP ? (
          <Button
            variant="primary"
            size="sm"
            onClick={handleNext}
            disabled={!proceed}
            aria-disabled={!proceed}
            icon={
              <svg
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M17 8l4 4m0 0l-4 4m4-4H3"
                />
              </svg>
            }
            iconPosition="right"
          >
            {t('landing.discovery.nav.continue')}
          </Button>
        ) : (
          <Button
            // The deposit CTA lives in the conversation; this is the quieter
            // route for a visitor who would rather talk first.
            variant="secondary"
            size="sm"
            onClick={handleSubmit}
            disabled={!proceed || submitting}
            aria-disabled={!proceed || submitting}
            loading={submitting}
            icon={
              !submitting ? (
                <svg
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M17 8l4 4m0 0l-4 4m4-4H3"
                  />
                </svg>
              ) : undefined
            }
            iconPosition="right"
          >
            {submitting
              ? t('landing.discovery.nav.submitting')
              : t('landing.discovery.nav.saveAndBook')}
          </Button>
        )}
      </div>
    </div>
  );
}
