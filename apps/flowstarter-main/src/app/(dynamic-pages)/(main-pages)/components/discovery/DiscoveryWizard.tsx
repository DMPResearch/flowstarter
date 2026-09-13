'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@flowstarter/flow-design-system';
import {
  type DiscoveryData,
  type Step,
  type Tier,
  DEMO_STATE_KEY,
  EMPTY_DISCOVERY,
  DEPOSIT_STEP,
  LAST_STEP,
  PREVIEW_STEP,
  STEPS,
  canProceed,
  recommendTier,
  usesDedicatedSubscription,
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
import { IntakePreviewPane } from './steps/IntakePreviewPane';
import { useBrandSignals } from './useBrandSignals';
import { IntakeStage } from './steps/IntakeStage';
import { PreviewStep } from './steps/PreviewStep';
import { RecommendationStep } from './steps/RecommendationStep';
import { SubscriptionStep } from './steps/SubscriptionStep';
import { derivePreviewSkeleton } from './preview-skeleton';

/**
 * The LangGraph HITL intake is the default: the model leads the conversation,
 * reacting to what the visitor said before it asks the next scripted
 * question. `NEXT_PUBLIC_FLOWSTARTER_INTAKE_GRAPH=false` is the kill switch —
 * set it to fall back to the fully scripted conversation, with no model in
 * the loop at all.
 */
const IS_TEST =
  process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

const USE_INTAKE_GRAPH =
  process.env.NEXT_PUBLIC_FLOWSTARTER_INTAKE_GRAPH !== 'false' && !IS_TEST;

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

/**
 * How much room the wizard needs, which is the only thing the host modal has
 * to know about which stage is on screen. Both stages are two panes wide now,
 * but the intake's panes hold a conversation and a skeleton, not a real site
 * in a scaled iframe, so it wants noticeably less than the concierge.
 */
export type WizardStage = 'intake' | 'concierge';

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
  /** Tells the host modal how much room the stage on screen needs. */
  onWideChange?: (stage: WizardStage) => void;
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
  /**
   * An edit asked for from the preview pane's fact list. The nonce is what
   * makes pressing the same pencil twice land in the conversation; see
   * `IntakeConversation`'s `editRequest`.
   */
  const [editRequest, setEditRequest] = useState<{
    id: IntakeQuestionId;
    nonce: number;
  } | null>(null);
  const requestEdit = useCallback((id: IntakeQuestionId) => {
    setEditRequest((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }));
  }, []);

  /**
   * The connect round trip's answer, read off the URL we were sent back to.
   *
   * The provider's callback lands on its own route, files whatever it got, and
   * redirects the browser to `returnTo` with `?portrait=<outcome>` and
   * `?portraitProvider=<provider>` on it. That is the entire channel: no
   * popup, no message passing, no second source of truth.
   *
   * A FULL PAGE REDIRECT IS SAFE HERE BECAUSE THE DRAFT IS NOT IN MEMORY. The
   * wizard autosaves to sessionStorage on every change, so leaving for
   * LinkedIn and coming back restores the answers, the cursor and the step
   * exactly as they were. A popup would buy nothing and would lose the
   * visitors whose in-app browser blocks one.
   *
   * Both params are stripped with `replaceState` the moment they are read, so
   * a refresh does not re-apply a stale answer and a shared URL does not carry
   * somebody else's outcome. Runs once, on mount, because that is the only
   * moment the params can be there.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('portrait');
    const provider = params.get('portraitProvider');
    if (!outcome) return;
    if (provider === 'linkedin' || provider === 'instagram') {
      setData((previous) => ({
        ...previous,
        portraitConnect: { provider, outcome },
      }));
    }
    params.delete('portrait');
    params.delete('portraitProvider');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${
        window.location.hash
      }`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // The quick script running dry is what moves the wizard on, and it moves
    // it straight to the preview. There is no gap-filling interview in front
    // of it any more: the questions that used to be there are asked on the
    // dashboard, after the deposit, where the answers are worth more.
    const target = stepForConversation(data, answered, PREVIEW_STEP);
    if (target !== step) setStep(target);
  }, [answered, data, step]);

  // Every stage is two panes wide now, so the modal is wide from the first
  // question rather than growing under the visitor part-way through. The
  // preview pane the conversation fills in needs the same room the concierge
  // stage needed, and resizing the dialog mid-conversation was always the
  // jarring part of the old behaviour.
  //
  // Re-asserted on the next macrotask as well as immediately: the host modal
  // clears its own `wide` flag when it opens, and React runs this child's
  // effects *before* the parent's, so the wizard would otherwise be reset back
  // to narrow a moment after asking for the room it needs.
  const stage: WizardStage = step >= PREVIEW_STEP ? 'concierge' : 'intake';
  useEffect(() => {
    onWideChange?.(stage);
    const reassert = setTimeout(() => onWideChange?.(stage), 0);
    return () => clearTimeout(reassert);
  }, [stage, onWideChange]);

  /**
   * The preview's shape, derived from the answers so far. Pure, so it is
   * recomputed rather than stored: there is no second source of truth about
   * what the visitor has said.
   */
  const skeleton = useMemo(() => derivePreviewSkeleton(data), [data]);

  /**
   * The colours and the voice, read from the visitor's own profiles.
   *
   * The hook owns when to ask (one link plus their own words about what they
   * offer) and asks once per distinct set of inputs, so answering the rest of
   * the script costs nothing. Disabled under test for the same reason the
   * intake graph is: a unit test of the conversation should not reach the
   * network, and every brand rule it would exercise is tested directly.
   */
  const brand = useBrandSignals(data, { enabled: !IS_TEST });

  /**
   * Files the derived palette and voice into the draft, so the preview request
   * carries what the visitor was shown rather than deriving it a second time.
   *
   * Guarded on a change in the values themselves, not on the object identity:
   * the hook hands back a fresh object on every render and writing it into
   * state unconditionally would be a loop.
   */
  useEffect(() => {
    if (!brand.palette && !brand.tone && !brand.picture) return;
    setData((previous) => {
      const samePalette =
        JSON.stringify(previous.brandPalette ?? null) ===
        JSON.stringify(brand.palette ?? null);
      const sameTone =
        JSON.stringify(previous.brandVoice ?? null) ===
        JSON.stringify(brand.tone ?? null);
      const samePicture =
        JSON.stringify(previous.brandPicture ?? null) ===
        JSON.stringify(brand.picture ?? null);
      if (samePalette && sameTone && samePicture) return previous;
      return {
        ...previous,
        brandPalette: brand.palette,
        brandVoice: brand.tone,
        brandUnavailable: brand.unavailable,
        brandPicture: brand.picture,
      };
    });
  }, [brand.palette, brand.tone, brand.unavailable, brand.picture]);

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
    if (step > PREVIEW_STEP) {
      setStep(PREVIEW_STEP);
      return;
    }
    setAnswered((previous) => previous.slice(0, -1));
    if (step === PREVIEW_STEP) setStep(CONVERSATION_LAST_STEP);
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
              : step === DEPOSIT_STEP
              ? 'landing.discovery.steps.deposit.title'
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
        {talking && (
          <IntakeStage
            answeredCount={skeleton.answeredCount}
            factTotal={skeleton.facts.length}
            t={t}
            preview={
              <IntakePreviewPane
                data={data}
                t={t}
                onEdit={requestEdit}
                brand={{
                  palette: brand.palette,
                  tone: brand.tone,
                  unavailable: brand.unavailable,
                  loading: brand.loading,
                  offerPictureUpload: brand.offerPictureUpload,
                  pictureUploaded: brand.pictureUploaded,
                  onUploadPicture: brand.uploadPicture,
                  // Editing the links question is the honest "Adjust": the
                  // palette is derived, so the way to change it is to change
                  // what it was derived from.
                  onAdjust: () => requestEdit('links'),
                }}
              />
            }
            conversation={
              USE_INTAKE_GRAPH ? (
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
                  editRequest={editRequest}
                  t={t}
                />
              )
            }
          />
        )}
        {/* The preview, and then the money. The visitor has answered four
            questions and gets a real site to look at; the build package and
            the monthly plan are asked against it rather than in front of it. */}
        {step === PREVIEW_STEP && (
          <PreviewStep
            data={data}
            t={t}
            brand={{
              palette: brand.palette,
              tone: brand.tone,
              unavailable: brand.unavailable,
              loading: brand.loading,
              offerPictureUpload: brand.offerPictureUpload,
              pictureUploaded: brand.pictureUploaded,
              onUploadPicture: brand.uploadPicture,
            }}
          />
        )}

        {step === DEPOSIT_STEP && (
          <div className="flex flex-col gap-6">
            <RecommendationStep data={data} update={update} t={t} />
            {!usesDedicatedSubscription(data.selectedTier) && (
              <SubscriptionStep data={data} update={update} t={t} />
            )}
          </div>
        )}
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
