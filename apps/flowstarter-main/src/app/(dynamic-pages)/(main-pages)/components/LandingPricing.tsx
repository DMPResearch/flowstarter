'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/unified-button';
import { useI18n } from '@/lib/i18n';
import { LANDING_COPY } from '../landing-copy';
import { PreQualModal } from './PreQualModal';
import type { Tone } from '@flowstarter/flow-design-system/components/surfaces/GlassSurface';
import { StatTile } from '@flowstarter/flow-design-system/components/surfaces/StatTile';

/**
 * The three care plans, each with the tone it wears everywhere else in the
 * product: the entry plan takes the brand indigo, the upgrade takes violet
 * (the same hue the dashboard uses for work the client did themselves) and
 * the shop plan takes green, which is the store's colour on the dashboard
 * tiles. `featured` is the one plan that gets the full toned-tile wash, so a
 * visitor's eye lands on it before they have read a price.
 */
const CARE_PLANS = [
  {
    name: 'Starter care',
    price: 'from €49 / month',
    description: 'Hosting, domain, maintenance, support and guided AI edits.',
    tone: 'accent' as Tone,
    featured: false,
  },
  {
    name: 'Pro care',
    price: '€99 / month',
    description:
      'More editor capacity, advanced controls and priority support.',
    tone: 'violet' as Tone,
    featured: true,
  },
  {
    name: 'Store care',
    price: '€129 / month',
    description: 'Store operations, product editing and commerce maintenance.',
    tone: 'ok' as Tone,
    featured: false,
  },
] as const;

/**
 * The payment terms, said as three numbers rather than three paragraphs. The
 * tones carry the meaning: nothing to pay is the colourless tone, the deposit
 * is the brand indigo, and the balance you only pay after approval is green.
 */
const PAYMENT_MILESTONES = [
  {
    amount: 'No charge',
    title: 'Tailored preview',
    body: 'Review the creative direction and receive your final quote.',
    tone: 'neutral' as Tone,
  },
  {
    amount: '20%',
    title: 'Start the full build',
    body: 'The approved direction becomes a complete multi-page site.',
    tone: 'accent' as Tone,
  },
  {
    amount: '80%',
    title: 'Approve and launch',
    body: 'Pay the balance only after human QA and your final approval.',
    tone: 'ok' as Tone,
  },
] as const;

export function LandingPricing() {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;
  const pricing = LANDING_COPY.pricing;

  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);

  const handlePlanClick = (planName: string) => {
    setSelectedPlan(planName);
    setModalOpen(true);
  };

  return (
    <section id="pricing" className="ls-scope ls-section ls-section--pad">
      <div className="ls-mesh" aria-hidden />
      <div className="ls-orb ls-orb--violet ls-orb--c" aria-hidden />
      <div className="ls-grain" aria-hidden />

      <div className="ls-container">
        <div className="ls-section-intro">
          <h2 className="ls-display" style={{ textWrap: 'balance' }}>
            <span className="line">{t('landing.pricing.headlinePrefix')}</span>
            <span className="line flourish mt-2">
              {t('landing.pricing.headlineFlourish')}
            </span>
          </h2>
          <p className="ls-body ls-body--lead">{pricing.subtitle}</p>
        </div>

        {/* The three numbers a visitor actually wants from this section, said
            as the same tiles the client dashboard uses for their own numbers:
            an eyebrow, the figure, one line of plain English. */}
        <ul className="ls-stat-row">
          {PAYMENT_MILESTONES.map((milestone) => (
            <li key={milestone.title} className="contents">
              <StatTile
                label={milestone.title}
                value={milestone.amount}
                note={milestone.body}
                tone={milestone.tone}
              />
            </li>
          ))}
        </ul>

        <div className="ls-care-pricing">
          <div className="ls-care-pricing-intro">
            <span>After launch</span>
            <h3>One care plan keeps everything operational.</h3>
            <p>
              Choose monthly or yearly billing. Your plan covers the operational
              layer, and your site remains yours.
            </p>
            <Button
              onClick={() => handlePlanClick('starter')}
              className="h-12 w-full sm:w-auto px-7"
            >
              Build my site
            </Button>
          </div>

          <div className="ls-care-plan-list">
            {CARE_PLANS.map((plan) => (
              <button
                type="button"
                key={plan.name}
                onClick={() => handlePlanClick(plan.name.toLowerCase())}
                className={`ls-care-plan-row fs-glass fs-glass--toned fs-glass--interactive fs-glass-ring${
                  plan.featured ? '' : ' fs-glass--plain'
                }`}
                data-tone={plan.tone}
              >
                <span>
                  <strong>{plan.name}</strong>
                  <small>{plan.description}</small>
                </span>
                <b>{plan.price}</b>
              </button>
            ))}
            <Link
              href="/custom-inquiry"
              className="ls-care-custom-row fs-glass fs-glass--toned fs-glass--interactive fs-glass--plain fs-glass-ring"
              data-tone="neutral"
            >
              <span>
                <strong>Custom software</strong>
                <small>
                  Integrations, automations and software beyond the site.
                </small>
              </span>
              <b>Custom quote</b>
            </Link>
          </div>
        </div>

        <p className="ls-price-note ls-price-note--terms">
          {pricing.guarantee}
        </p>
      </div>

      <PreQualModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        source="pricing-section"
        initialPlan={selectedPlan}
      />
    </section>
  );
}
