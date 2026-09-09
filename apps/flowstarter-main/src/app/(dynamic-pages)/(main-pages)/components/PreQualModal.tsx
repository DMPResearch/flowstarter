'use client';

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { EXTERNAL_URLS } from '@/lib/constants';
import { useI18n } from '@/lib/i18n';
import { CalendlyEmbed } from './CalendlyEmbed';
import { DiscoveryWizard } from './discovery/DiscoveryWizard';
import type { DiscoveryData, Tier } from './discovery/discovery.logic';

type Step = 'discovery' | 'calendar' | 'confirmed';

interface PreQualModalProps {
  open: boolean;
  onClose: () => void;
  source?: string;
  /** Pre-select a plan when opened from pricing cards */
  initialPlan?: string | null;
  /**
   * Reopen straight on a later step (used after the Stripe deposit redirect
   * returns the prospect to the site — they resume at the calendar).
   */
  resumeStep?: 'calendar' | null;
}

const VALID_TIERS = new Set<Tier>(['starter', 'pro', 'commerce', 'custom']);

function coerceInitialTier(
  initialPlan: string | null | undefined
): Tier | null {
  if (!initialPlan) return null;
  const lowered = initialPlan.toLowerCase();
  // Map legacy plan names from the pricing cards
  const aliases: Record<string, Tier> = {
    starter: 'starter',
    pro: 'pro',
    commerce: 'commerce',
    ecommerce: 'commerce',
    custom: 'custom',
    essential: 'starter',
    unsure: 'starter',
  };
  const mapped = aliases[lowered];
  return mapped && VALID_TIERS.has(mapped) ? mapped : null;
}

export function PreQualModal({
  open,
  onClose,
  source = 'cta',
  initialPlan,
  resumeStep = null,
}: PreQualModalProps) {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;
  const [step, setStep] = useState<Step>('discovery');
  const [wizardWide, setWizardWide] = useState(false);
  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [discoveryData, setDiscoveryData] = useState<DiscoveryData | null>(
    null
  );

  // Reset on open + lock scroll
  useEffect(() => {
    if (open) {
      setSelectedTier(coerceInitialTier(initialPlan));
      setDiscoveryData(null);
      setWizardWide(false);
      // After a paid deposit we resume at the calendar; otherwise start fresh.
      setStep(resumeStep === 'calendar' ? 'calendar' : 'discovery');
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open, initialPlan, resumeStep]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleDiscoveryComplete = useCallback(
    ({ tier, data }: { tier: Tier; data: DiscoveryData }) => {
      setSelectedTier(tier);
      setDiscoveryData(data);
      setStep('calendar');
    },
    []
  );

  const handleBackToDiscovery = useCallback(() => {
    setStep('discovery');
  }, []);

  const handleEventScheduled = useCallback(() => {
    setStep('confirmed');
  }, []);

  if (!open) return null;
  if (typeof window === 'undefined') return null;

  const calendlyUrl = EXTERNAL_URLS.calendly.discovery;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="bg-black/60 backdrop-blur-sm"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100dvh',
          minHeight: '100vh',
          zIndex: 9998,
        }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        role="dialog"
        data-testid="discovery-dialog"
        aria-modal="true"
        aria-labelledby="prequal-title"
        className="flex items-start sm:items-center justify-center p-4 pt-[max(1rem,env(safe-area-inset-top))]"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100dvh',
          zIndex: 9999,
          overflowY: 'auto',
        }}
      >
        <div
          className={[
            'relative w-full my-auto rounded-2xl border border-white/10 bg-white dark:bg-[#0f1117] shadow-2xl shadow-black/30 p-6 sm:p-8 transition-all duration-300',
            step === 'calendar'
              ? 'max-w-3xl'
              : step === 'discovery' && wizardWide
              ? 'max-w-[min(96vw,1600px)]'
              : 'max-w-2xl',
          ].join(' ')}
        >
          {/* Drag handle — mobile only */}
          <div className="sm:hidden flex justify-center mb-4 -mt-1">
            <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-white/20" />
          </div>

          {/* Close */}
          <button
            onClick={onClose}
            aria-label={t('landing.prequal.close')}
            className="absolute right-4 top-4 rounded-lg p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-white transition-colors z-10"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>

          {/* ─── STEP 1: Discovery wizard ─── */}
          {step === 'discovery' && (
            <DiscoveryWizard
              initialTier={selectedTier}
              source={source}
              onComplete={handleDiscoveryComplete}
              onWideChange={setWizardWide}
              t={t}
            />
          )}

          {/* ─── STEP 2: Calendly inline widget ─── */}
          {step === 'calendar' && (
            <>
              {/* Back button + header */}
              <div className="mb-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleBackToDiscovery}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-[var(--fs-ink)]/50 dark:hover:text-white transition-colors"
                >
                  <svg
                    className="h-4 w-4"
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
                  {t('landing.prequal.calendar.back')}
                </button>
                {selectedTier && (
                  <>
                    <div className="h-4 w-px bg-gray-200 dark:bg-white/10" />
                    <p className="text-sm text-[var(--fs-ink-faint)]">
                      <span className="font-medium text-[var(--purple-primary)]">
                        {t(`landing.discovery.tiers.${selectedTier}.name`)}
                      </span>{' '}
                      {t('landing.prequal.calendar.planSelected')}
                    </p>
                  </>
                )}
              </div>

              <div className="mb-2">
                <h2
                  id="prequal-title"
                  className="text-xl font-bold text-[var(--fs-ink)]"
                >
                  {t('landing.prequal.calendar.title')}
                </h2>
                <p className="mt-1 text-sm text-[var(--fs-ink-faint)]">
                  {t('landing.prequal.calendar.subtitle')}
                </p>
              </div>

              {/* Calendly widget — prefill name/email from the wizard so the
                  visitor doesn't have to type them again. */}
              <div className="rounded-xl overflow-hidden border border-gray-100 dark:border-white/5">
                <CalendlyEmbed
                  url={calendlyUrl}
                  utmContent={`${selectedTier ?? 'unknown'}-plan`}
                  utmSource={source}
                  utmMedium="prequal-modal"
                  prefillName={discoveryData?.fullName?.trim() || undefined}
                  prefillEmail={discoveryData?.email?.trim() || undefined}
                  onEventScheduled={handleEventScheduled}
                />
              </div>
            </>
          )}

          {/* ─── STEP 3: Confirmation ─── */}
          {step === 'confirmed' && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              {/* Checkmark */}
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
                <svg
                  className="h-8 w-8 text-emerald-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>

              <h2 className="text-2xl font-bold text-[var(--fs-ink)] mb-2">
                {t('landing.prequal.confirmed.title')}
              </h2>
              <p className="text-base text-[var(--fs-ink-faint)] max-w-sm">
                {t('landing.prequal.confirmed.body')}
              </p>
              <p className="mt-4 text-sm text-gray-400 dark:text-white/30">
                {t('landing.prequal.confirmed.note')}
              </p>

              <button
                type="button"
                onClick={onClose}
                className="mt-8 inline-flex items-center gap-2 rounded-xl bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-8 py-3 text-base font-semibold text-white shadow-lg shadow-[var(--purple-primary)]/25 hover:opacity-90 transition-opacity"
              >
                {t('landing.prequal.confirmed.cta')}
              </button>
            </div>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}
