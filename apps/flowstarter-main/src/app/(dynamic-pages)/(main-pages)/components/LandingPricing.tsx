'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/unified-button';
import { useI18n } from '@/lib/i18n';
import { LANDING_COPY } from '../landing-copy';
import { PreQualModal } from './PreQualModal';

const CARE_PLANS = [
  {
    name: 'Starter care',
    price: 'from €49 / month',
    description: 'Hosting, domain, maintenance, support and guided AI edits.',
  },
  {
    name: 'Pro care',
    price: '€99 / month',
    description:
      'More editor capacity, advanced controls and priority support.',
  },
  {
    name: 'Store care',
    price: '€129 / month',
    description: 'Store operations, product editing and commerce maintenance.',
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

        <div className="ls-payment-terms">
          <div className="ls-payment-milestone">
            <span>No charge</span>
            <strong>Tailored preview</strong>
            <p>Review the creative direction and receive your final quote.</p>
          </div>
          <div className="ls-payment-milestone ls-payment-milestone--accent">
            <span>20%</span>
            <strong>Start the full build</strong>
            <p>The approved direction becomes a complete multi-page site.</p>
          </div>
          <div className="ls-payment-milestone">
            <span>80%</span>
            <strong>Approve and launch</strong>
            <p>Pay the balance only after human QA and your final approval.</p>
          </div>
        </div>

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
                className="ls-care-plan-row"
              >
                <span>
                  <strong>{plan.name}</strong>
                  <small>{plan.description}</small>
                </span>
                <b>{plan.price}</b>
              </button>
            ))}
            <Link href="/custom-inquiry" className="ls-care-custom-row">
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
