import nextDynamic from 'next/dynamic';

import { SiteHeader } from '@/components/SiteHeader';
import Footer from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';

import { LandingHero } from './components/LandingHero';
import { BrandIntelligenceSection } from './components/BrandIntelligenceSection';
import { TemplateLibrarySection } from './components/TemplateLibrarySection';
import { EditorShowcase } from './components/EditorShowcase';
import { DifferentiationSection } from './components/DifferentiationSection';
import { TeamSection } from './components/TeamSection';
import { ProcessSection } from './components/ProcessSection';
import { ProofSection } from './components/ProofSection';
import { TestimonialsSection } from './components/TestimonialsSection';
import { ScrollFab } from './components/ScrollFab';
import { BookingModalProvider } from './components/BookingModalProvider';
import { LandingReveal } from './components/LandingReveal';

// Below-the-fold client islands — code-split into separate chunks so they
// don't bloat the initial JS payload. SSR stays on (default).
const LandingPricing = nextDynamic(() =>
  import('./components/LandingPricing').then((m) => ({
    default: m.LandingPricing,
  }))
);
const FAQSection = nextDynamic(() =>
  import('./components/FAQSection').then((m) => ({ default: m.FAQSection }))
);
const FinalCTASection = nextDynamic(() =>
  import('./components/FinalCTASection').then((m) => ({
    default: m.FinalCTASection,
  }))
);
const SupportBot = nextDynamic(() =>
  import('./components/SupportBot').then((m) => ({ default: m.SupportBot }))
);

export default function LandingPage() {
  return (
    <div
      className="flex flex-1 flex-col text-[var(--fs-ink)] font-display relative"
      style={{ overflowX: 'clip' }}
    >
      <SiteHeader mode="landing" />
      <main id="main-content" className="flex-1">
        <LandingHero />
        <BookingModalProvider />
        <hr className="ls-scope ls-section-divider" aria-hidden="true" />
        <BrandIntelligenceSection />
        <hr className="ls-scope ls-section-divider" aria-hidden="true" />
        <TemplateLibrarySection />
        <hr className="ls-scope ls-section-divider" aria-hidden="true" />
        <ProcessSection />
        <hr className="ls-scope ls-section-divider" aria-hidden="true" />
        <DifferentiationSection />
        <hr className="ls-scope ls-section-divider" aria-hidden="true" />
        <TeamSection />
        <hr className="ls-scope ls-section-divider" aria-hidden="true" />
        <EditorShowcase />
        <hr className="ls-scope ls-section-divider" aria-hidden="true" />
        <ProofSection />
        <hr className="ls-scope ls-section-divider" aria-hidden="true" />
        <TestimonialsSection />
        <hr className="ls-scope ls-section-divider" aria-hidden="true" />
        <LandingPricing />
        <hr className="ls-scope ls-section-divider" aria-hidden="true" />
        <FAQSection />
        <FinalCTASection />
      </main>
      <Footer />
      <LandingReveal />
      <CookieConsent />
      <ScrollFab />
      <SupportBot />
    </div>
  );
}
