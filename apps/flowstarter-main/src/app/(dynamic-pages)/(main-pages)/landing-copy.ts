/** Centralized landing page copy. Edit here instead of JSX. */

export interface HeroCopy {
  headlinePrefix: string;
  headlineHighlight: string;
  subheadlineBold: string;
  subheadline: string;
  primaryCta: string;
  secondaryCta: string;
  trustLine: string;
  guarantee: string;
}

export interface PricingSectionCopy {
  title: string;
  subtitle: string;
  socialProof?: string;
  plans: PricingPlan[];
  note: string;
  relaunchNote?: string;
  guarantee: string;
  secondaryCta?: {
    lead: string;
    label: string;
    href: string;
  };
}

export interface PricingPlan {
  name: string;
  label: string;
  setupPrice: string;
  monthlyPrice: string;
  features: readonly string[];
  cta: string;
  ctaVariant?: 'primary' | 'secondary' | 'outline';
  status: 'available';
  badge?: string;
  recommended?: boolean;
  /** When set, the card uses a non-default CTA target (e.g. inquiry form). */
  kind?: 'custom-inquiry';
  /** Optional sub-note shown under the card (e.g. intake-process disclaimer). */
  note?: string;
}

export interface DifferentiationCard {
  label: string;
  description: string;
  bullets?: string[];
  highlighted?: boolean;
}

export const LANDING_COPY = {
  hero: {
    headlinePrefix: 'Your business already has a brand',
    headlineHighlight: 'We turn it into a website',
    subheadlineBold: '',
    subheadline:
      'Tell us about the business and share the public profiles that already sound like you. We turn that voice and visual identity into a tailored site preview, then build and care for the real thing.',
    primaryCta: 'Build my site',
    secondaryCta: 'See the process',
    trustLine:
      'For coaches, consultants, therapists, freelancers and founders, whether you are launching for the first time or finally fixing the site you have.',
    guarantee:
      'First month is free. If you are not happy within 30 days, we refund half your setup fee and you keep the work.',
  },
  brandIntelligence: {
    headline: 'We start with what is already true',
    headlineFlourish: 'Then make it useful',
    intro:
      'Your answers and public profiles reveal how the business sounds, looks and earns trust. The agent turns those clues into a clear direction for your website.',
    inputs: [
      { label: 'Business', value: 'Independent therapy practice' },
      { label: 'Location', value: 'Cluj-Napoca, Romania' },
      { label: 'Public profiles', value: 'Website, Instagram and LinkedIn' },
    ],
    sourceQuote:
      'I help people find a calmer way through change, without making the work feel clinical or distant.',
    direction: 'Calm, credible and personal',
    voice: [
      { label: 'Warm', value: 88 },
      { label: 'Direct', value: 66 },
      { label: 'Expert', value: 79 },
    ],
    palette: ['#19352D', '#F3EEE5', '#B36A44', '#FFFFFF'],
    privacyNote:
      'Only the public profiles you choose are analyzed. You review the result before it becomes your preview.',
  },
  templateLibrary: {
    headline: 'The right starting point is selected',
    headlineFlourish: 'Then the agent makes it yours',
    intro:
      'The design agent reviews our approved starting designs and chooses the one that best fits your offer, your customers and what you want visitors to do.',
    explainer:
      'We add your words, colors and images, then reshape the sections and buttons until the preview feels specific to your business.',
    templates: [
      {
        name: 'Coach & Expert',
        status: 'Selected for this brief',
        reason:
          'Trust-led proof, a clear offer and a natural consultation path.',
        thumbnail: '/showcase/ux-journey.png',
      },
      {
        name: 'Local Commerce',
        status: 'Alternative',
        reason: 'A stronger fit when products and local credibility lead.',
        thumbnail: '/showcase/lebadusul.png',
      },
      {
        name: 'Creative Portfolio',
        status: 'Alternative',
        reason: 'More expressive pacing for visual personal brands.',
        thumbnail: '/showcase/dorin-portfolio.png',
      },
    ],
  },
  process: {
    title: 'Preview first. Commitment second',
    steps: [
      {
        number: 'PREVIEW FIRST',
        title: 'Meet your first direction',
        description:
          'Share the essentials and, if you choose, your public Instagram or LinkedIn profile. Our agent learns how your business sounds and looks, picks the best starting design, and prepares a tailored preview before you pay.',
      },
      {
        number: '20% TO START',
        title: 'Approve the direction',
        description:
          'You review the direction and the final quote. When it feels right, a 20% deposit locks the approved preview and starts the complete multi-page build.',
      },
      {
        number: 'BUILD + REVIEW',
        title: 'We build the complete site',
        description:
          'The site-building agent adds every agreed page and connects the services you need. Our team then checks the words, spacing, mobile experience, search visibility and every last detail.',
      },
      {
        number: '80% + CARE',
        title: 'Launch without the loose ends',
        description:
          'After approval, you pay the remaining 80% and choose monthly or yearly care. We keep the site, domain and maintenance running, while your AI editor handles small wording changes and sends bigger requests to us.',
      },
    ],
  },
  problem: {
    title: 'You know how this usually goes',
    pains: [
      {
        icon: 'sparkles',
        title: 'AI drafts feel generic',
        body: 'AI generators draft a site in seconds, but the structure is thin. The pages read like everyone else who used the same tool.',
      },
      {
        icon: 'wallet',
        title: 'Heavy and slow',
        body: "Bigger builds take months. Small changes after launch wait for someone else's schedule.",
      },
      {
        icon: 'puzzle',
        title: 'You stay dependent',
        body: 'The site lives in a system you did not build. Every tweak needs the person who set it up.',
      },
    ],
    closing:
      'Flowstarter is a new way to build sites and custom software. Specific to your business, then yours to change yourself.',
  },
  included: {
    title: 'Set up before you touch a thing',
    cards: [
      {
        icon: 'globe',
        title: 'A site designed and built for you',
        description:
          'Designed around your offer, connected to your web address and ready for customers. We handle the setup for you.',
      },
      {
        icon: 'calendar',
        title: 'Online booking, already connected',
        description:
          'Clients pick a time without the back-and-forth email. Your calendar and availability are ready from day one.',
      },
      {
        icon: 'briefcase',
        title: 'Newsletter ready to send',
        description:
          'Your list and your first send are ready on launch day. No extra software for you to figure out.',
      },
      {
        icon: 'sparkles',
        title: 'Lead capture from the start',
        description:
          'New enquiries arrive in one organized place, ready for you to follow up.',
      },
      {
        icon: 'layout',
        title: 'Your editor, part of the subscription',
        description:
          'Change wording whenever you want. The editor, maintenance and support are all included. Cancel anytime and the site can keep running without us.',
      },
      {
        icon: 'layers',
        title: 'Domain and professional email',
        description:
          'Your web address and professional email are set up in your name and ready before your first visitor arrives.',
      },
    ],
  },
  pricing: {
    title: 'Pay for progress. Stay for the care',
    subtitle:
      'Every project gets a final quote after the preview. The build is paid in two milestones, then your monthly or yearly plan keeps the site fully operational.',
    socialProof:
      'We only open a handful of new builds each month, so nothing turns into conveyor-belt work.',
    note: 'Care is billed monthly or yearly. Relaunches, online stores and custom software are priced around the services you need connected and the ongoing support involved.',
    plans: [
      {
        name: 'STARTER',
        label: 'Get your professional presence online',
        setupPrice: 'Setup starting from €799',
        monthlyPrice: '+ monthly plan from €49',
        features: [
          'Custom-built website (5 to 7 pages)',
          'Hosting and domain included',
          'Smart editor access included',
          'Discovery call and ongoing support',
        ],
        cta: 'Get my custom plan',
        status: 'available',
      },
      {
        name: 'PRO',
        label: 'For service businesses that are growing',
        setupPrice: 'Setup starting from €1,199',
        monthlyPrice: '+ monthly plan from €49',
        features: [
          'Everything in Starter',
          'More pages and connected services',
          'Take payments for digital products or sessions',
          'More ways to update your site yourself',
          'Priority support',
        ],
        cta: 'Get my custom plan',
        badge: 'Most Popular',
        recommended: true,
        status: 'available',
      },
      {
        name: 'ECOMMERCE',
        label: 'A full storefront, ready to sell',
        setupPrice: 'Setup starting from €1,499',
        monthlyPrice: '+ €129 / month store plan',
        features: [
          'A complete online store, built for you',
          'Physical and digital products',
          'Inventory, shipping and tax handled',
          'Order emails and customer notifications',
          'Secure online checkout',
          'Dedicated store plan with product and collection editing',
        ],
        cta: 'Get my custom plan',
        status: 'available',
      },
      {
        name: 'CUSTOM SOLUTIONS',
        label: 'Real software, built around your business',
        setupPrice: 'Get your custom quote',
        monthlyPrice: '',
        features: [
          'When your business needs more than a marketing site',
          'Booking, smart assistants, time-saving workflows and connected services',
          'Fixed quote up front, agreed before we start',
          'Connects to the tools you already use',
          'The finished product and your business data are yours',
          'Direct line to the people who built it',
        ],
        cta: 'Get my custom solution',
        kind: 'custom-inquiry',
        note: 'We stay on after launch.',
        status: 'available',
      },
    ],
    secondaryCta: {
      lead: 'We also build custom software when these tiers are not enough.',
      label: 'Get a custom quote',
      href: '/custom-inquiry',
    },
    guarantee:
      'No payment during intake. Pay 20% after the preview is approved, then 80% after the complete site passes our review and yours.',
  },
  differentiation: {
    title: 'Automation with a human finish',
    cards: [
      {
        label: 'Specialists, not one generic bot',
        description:
          'Your brand researcher, design matcher, site builder and care assistant each handle the work they do best. They can keep moving 24/7 without bypassing human review.',
        highlighted: true,
      },
      {
        label: 'Services connected properly',
        description:
          'Booking, payments, lead capture, analytics, email and the specialist tools your business depends on are connected and tested before launch.',
      },
      {
        label: 'Easy to find and easy to use',
        description:
          'Clear pages, search setup, fast loading, mobile checks and readable colors are included from the start.',
      },
      {
        label: 'A care agent after handoff',
        description:
          'Your monthly or yearly plan keeps hosting, domain, maintenance and support with the same team. The care agent handles small requests any time. Bigger work comes back to us.',
      },
    ],
  },
  /**
   * The team, named. Every agent here maps to a real stage of the pipeline,
   * and each card says what that agent may not do — the boundaries are the
   * reassuring part, not the automation.
   */
  team: {
    agents: [
      {
        role: 'Brand analyst',
        does: 'Reads your answers, your public profiles and your photos, then settles the palette, the type pairing and the voice the site will speak in.',
        limit: 'Every claim has to trace back to something you actually said.',
      },
      {
        role: 'Design matcher',
        does: 'Picks the starting design from our approved library by how your business is shaped: the pages you need, not the colours you like.',
        limit: 'It can only choose a design we already build and maintain.',
      },
      {
        role: 'Site builder',
        does: 'Writes your site into that design: the words, the images, the colours, page by page.',
        limit:
          'It edits content and styling only. It cannot touch the code that makes the design work.',
      },
      {
        role: 'Honesty editor',
        does: 'Rereads the whole site in your voice and strips anything invented: clients you never had, numbers nobody measured, filler nobody would say out loud.',
        limit:
          'If a section has no true content, it says less rather than making something up.',
      },
      {
        role: 'Build checker',
        does: 'Builds the finished site and reads it back in a real browser, checking that it works on a phone and that the text is legible.',
        limit:
          'A site that fails here is repaired and rebuilt before anyone sees it.',
      },
      {
        role: 'Care assistant',
        does: 'Stays with you after launch. Ask for a change in plain words and it makes it.',
        limit: 'Bigger design or structural work comes to us instead.',
      },
    ],
    humans: [
      {
        name: 'Darius',
        role: 'Build & reliability',
        does: 'Owns the pipeline, the hosting and everything that has to keep working after launch.',
      },
      {
        name: 'Dorin',
        role: 'Design & craft',
        does: 'Owns how the work looks and reads, and decides when a site is good enough to send.',
      },
    ],
  },
  audience: {
    title: 'For small businesses across Europe, service or store',
    items: [
      { icon: 'users', label: 'Coaches' },
      { icon: 'mic', label: 'Consultants' },
      { icon: 'check', label: 'Therapists' },
      { icon: 'sparkles', label: 'Photographers' },
      { icon: 'briefcase', label: 'Independent professionals' },
      { icon: 'store', label: 'Online stores' },
      { icon: 'store', label: 'Makers and retailers' },
      { icon: 'store', label: 'Small product sellers' },
    ],
  },
  proof: {
    libraryUrl: '/library',
    items: [
      {
        slug: 'ux-journey',
        title: 'UX Journey',
        meta: 'Coaching · Live · 2026',
        kicker:
          'A senior UX coaching practice. Copy, calendar and credibility, all on one domain.',
        thumbnail: '/showcase/ux-journey.png',
        thumbnailDark: null,
        placeholder: 'ux-journey.com',
        href: 'https://ux-journey.com/',
        external: true,
        status: 'live' as const,
      },
      {
        slug: 'lebadusul',
        title: 'Lebădușul',
        meta: 'Retail · Live · 2026',
        kicker:
          'A Danube-side tackle shop. Catalog, checkout and logistics copy written for serious anglers.',
        thumbnail: '/showcase/lebadusul.png',
        thumbnailDark: null,
        placeholder: 'lebadusularticoledepescuit.ro',
        href: 'https://lebadusularticoledepescuit.ro/',
        external: true,
        status: 'live' as const,
      },
      {
        slug: 'dorin-portfolio',
        title: 'Creative Portfolio',
        meta: 'Portfolio · Starter · Live',
        kicker:
          "Dorin's portfolio starter. Pull it from the library when you need to launch something credible fast.",
        thumbnail: '/showcase/dorin-portfolio.png',
        thumbnailDark: null,
        href: '/library/templates/dorin-portfolio',
        external: false,
        status: 'live' as const,
      },
    ],
  },
  testimonials: {
    title: 'In their words',
    items: [
      {
        slug: 'lebadusul',
        quote:
          'I sell fishing tackle, so I needed the site to be practical: products easy to find, checkout working, and prices I can change without calling someone. That is what they built. I still spend most days with customers or on the water, but orders can come in without me sitting at the computer.',
        name: 'Daniel Draga',
        role: 'Owner, Lebădușul',
        href: 'https://lebadusularticoledepescuit.ro/',
      },
    ],
  },
  faq: {
    title: 'Questions we get asked a lot',
    items: [
      {
        question: 'When do I pay the deposit?',
        answer:
          'There is no payment during the intake. First you see a tailored preview and receive the final quote. If you approve that direction, you pay exactly 20% to start the complete build. The remaining 80% is due only after our final review and your approval.',
      },
      {
        question: 'How long does it take to build my site?',
        answer:
          'We set a realistic timeline together on the discovery call and keep you posted the whole way. Most builds move in weeks, not months, but we are not going to rush the parts that matter.',
      },
      {
        question: 'Do I own my website?',
        answer:
          'Completely. It runs on your own web address and you can move it whenever you want. No lock-in and no platform taking a cut.',
      },
      {
        question: 'What if I want to make changes after launch?',
        answer:
          'For a small wording change, click the exact text and describe what you want in plain English. The editor changes only that part. New sections, visual changes and connected services go to our team through your care plan, so the site stays consistent and reliable.',
      },
      {
        question: 'What does the care plan include?',
        answer:
          'Hosting, domain renewal, maintenance, support and your editor allowance. Choose monthly or yearly billing. Starter includes 50 edits and Pro includes 150, with add-on packs available if you need more.',
      },
      {
        question: 'What if I already have a website?',
        answer:
          'We do relaunches too. We look at what you have, keep the content that is worth keeping, and rebuild the rest properly. Mention your current site on the discovery call and we will quote it.',
      },
      {
        question: 'Can you handle e-commerce or selling courses?',
        answer:
          'Yes. Pro can take payments for courses, bookings, memberships and other digital offers. If you need a complete store with stock, shipping and tax, choose Ecommerce. Tell us what you sell and we will plan the right setup.',
      },
      {
        question: 'Why limit how many clients you take on?',
        answer:
          'Because it is the two of us, Darius and Dorin, with AI doing the heavy lifting and us responsible for the result. A small number of projects a month is the only way each one gets real attention. We would rather do fewer well.',
      },
      {
        question: 'What if I need more editor changes than my plan includes?',
        answer:
          'There are add-on packs: €15 a month for another 25 edits, up to €45 a month for 100 more. We will sort the right setup with you on the call, or later if your needs grow.',
      },
    ],
  },
};
