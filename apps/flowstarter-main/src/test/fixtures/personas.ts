/**
 * Nine people, as data.
 *
 * The product broke on one real brief: a two-sentence offer, three one-line
 * projects, no portrait, no story, and a business name that was the
 * platform's. Every gate passed. The lesson was not "add a gate", it was
 * "nothing in the suite had ever run a whole person through the funnel", and
 * a single happy-path fixture with the right answers in it would have taught
 * us the same nothing.
 *
 * `darius-portfolio` and `hendry-motors` are the second incident, not the
 * first: a visitor who owns his site, gave his own name, and then answered
 * all eleven person and activity questions was still named after his
 * hostname, because the naming rule checked the owned site before it checked
 * whether the person section had anything in it. `hendry-motors` is the
 * control for that fix the same way `orchard-plumbing` is the control for the
 * first one -- a company that owns its site and was never asked about a
 * person has to keep today's hostname-derived name exactly.
 *
 * So the fixtures are people rather than payloads. Each one is a different
 * trade, a different language, a different amount of material and a different
 * expected verdict, and the suites walk all nine through the same path:
 *
 *   which questions the intake asks them, and in what order
 *   the brief each one produces
 *   what the readiness rule says about it
 *   what the site is named
 *   what the codegen mapping hands the agent
 *   what the PERSON_ABSENT gate says about a built site
 *
 * The three cases that matter most are deliberately not the happy path:
 * `maria-avocat` has a story and no photograph, `tom-trainer` has a
 * photograph and no story, and `nadia-accountant` has neither and must block
 * with an ask rather than ship a site about nobody.
 *
 * DATA ONLY. Nothing here imports a test runner, and nothing here asserts
 * anything, so the showcase recorder under `e2e/support/` can read the same
 * six scenarios to film them without pulling a suite into a browser.
 */
import type { BriefPerson } from '@flowstarter/agentic-codegen/src/flowstarter/person';
import {
  EMPTY_DISCOVERY,
  type DiscoveryData,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';

/** What a suite expects of one persona, stated next to the persona. */
export interface PersonaExpectations {
  /** What the intake classifier should make of them. */
  siteKind: 'portfolio' | 'services';
  /** Whether the person block is offered at all. */
  asksPersonQuestions: boolean;
  /** The name the generated site is introduced with. */
  businessName: string;
  /** True when the readiness rule must let a build start. */
  briefReady: boolean;
  /** Codes the readiness rule must report as blocking, in order. */
  blockingCodes: readonly string[];
}

export interface Persona {
  /** Stable id. Used by suite names and by the showcase recorder. */
  id: string;
  /** One line for a human reading a failure message. */
  summary: string;
  locale: 'en' | 'ro';
  /** The answers they give the intake, over `EMPTY_DISCOVERY`. */
  discovery: DiscoveryData;
  /**
   * The person section their brief carries, or null when they were never
   * asked. Null is a real state and one persona is in it.
   */
  person: BriefPerson | null;
  /** What they wrote in the brief's offer field. */
  offer: string;
  /** Real work, as the brief holds it. */
  projects: ReadonlyArray<{ name: string; line: string }>;
  /** True when they answered "I have no past work to show". */
  noProjects: boolean;
  /** Site-rooted path of their portrait, or '' when they sent none. */
  portraitPath: string;
  expect: PersonaExpectations;
}

function discovery(answers: Partial<DiscoveryData>): DiscoveryData {
  return { ...EMPTY_DISCOVERY, ...answers };
}

function person(fields: Partial<BriefPerson>): BriefPerson {
  return {
    name: '',
    headline: '',
    story: '',
    howIWork: '',
    values: '',
    feel: '',
    toneWords: [],
    links: [],
    proudestWork: '',
    activity: { what: '', who: '', typical: '', knownFor: '', years: '' },
    sourcedBio: null,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// The six
// ---------------------------------------------------------------------------

/**
 * A wedding photographer in Bucharest, writing in Romanian.
 *
 * The full case: a trade the classifier recognises on its own, a story, a
 * portrait, tone words, and an activity section. Her brief should sail
 * through and her about page should be made of her sentences.
 */
const IOANA: Persona = {
  id: 'ioana-fotograf',
  summary: 'Bucharest wedding photographer, Romanian, full material',
  locale: 'ro',
  discovery: discovery({
    fullName: 'Ioana Petrescu',
    email: 'ioana@example.com',
    description:
      'Fotografiez nunti in Bucuresti si in imprejurimi, de noua ani, mai ales cununii mici.',
    industry: 'Photography',
    instagramUrl: 'https://instagram.com/ioana.fotograf',
    personStory:
      'Am inceput sa fotografiez nunti pentru ca mi-a placut sa privesc oamenii cand uita ca sunt priviti. Nu regizez nimic si nu cer nimanui sa zambeasca la comanda.',
    personHowIWork:
      'Vin devreme, stau in spate si astept. Livrez in trei saptamani, fara filtre grele.',
    personFeel: 'Linistit, ca si cum ar rasfoi un album de familie.',
    personProudest:
      'O cununie de douazeci de oameni intr-o curte din Cotroceni, unde nu am scos blitul o data.',
    personToneWords: 'cald, linistit, sincer',
    activityWhat: 'Fotografie de nunta, documentara, fara poze regizate.',
    activityWho: 'Cupluri care vor nunti mici',
    activityTypical:
      'O zi intreaga cu cuplul, de dimineata pana dupa primul dans, si un album in trei saptamani.',
    activityKnownFor: 'Fotografii de cununii mici, in curte',
    activityYears: 'noua ani',
  }),
  person: person({
    name: 'Ioana Petrescu',
    headline: 'Fotograf de nunta in Bucuresti',
    story:
      'Am inceput sa fotografiez nunti pentru ca mi-a placut sa privesc oamenii cand uita ca sunt priviti. Nu regizez nimic si nu cer nimanui sa zambeasca la comanda.',
    howIWork:
      'Vin devreme, stau in spate si astept. Livrez in trei saptamani, fara filtre grele.',
    feel: 'Linistit, ca si cum ar rasfoi un album de familie.',
    toneWords: ['cald', 'linistit', 'sincer'],
    proudestWork:
      'O cununie de douazeci de oameni intr-o curte din Cotroceni, unde nu am scos blitul o data.',
    links: [
      {
        kind: 'instagram',
        url: 'https://instagram.com/ioana.fotograf',
        consented: true,
      },
    ],
    activity: {
      what: 'Fotografie de nunta, documentara, fara poze regizate.',
      who: 'Cupluri care vor nunti mici',
      typical:
        'O zi intreaga cu cuplul, de dimineata pana dupa primul dans, si un album in trei saptamani.',
      knownFor: 'Fotografii de cununii mici, in curte',
      years: 'noua ani',
    },
  }),
  offer:
    'Fotografiez nunti mici, documentar, o zi intreaga cu cuplul si un album livrat in trei saptamani. Lucrez fara poze regizate si fara filtre grele.',
  projects: [
    { name: 'Cununia din Cotroceni', line: 'Douazeci de oameni, o curte.' },
  ],
  noProjects: false,
  portraitPath: '/flowstarter-media/ioana-portrait.jpg',
  expect: {
    siteKind: 'portfolio',
    asksPersonQuestions: true,
    businessName: 'Ioana Petrescu',
    briefReady: true,
    blockingCodes: [],
  },
};

/**
 * A freelance product designer, English, with work to show.
 *
 * The classifier catches "design" on its own, and the projects list means the
 * invented-project gate has names to check against as well.
 */
const SAM: Persona = {
  id: 'sam-ux',
  summary: 'Freelance UX designer, English, story and portrait',
  locale: 'en',
  discovery: discovery({
    fullName: 'Sam Okafor',
    email: 'sam@example.com',
    description:
      'I am a freelance product designer. I work with small software teams on the parts of a product people actually get stuck on.',
    industry: 'Creative & design',
    linkedinUrl: 'https://linkedin.com/in/samokafor',
    personStory:
      'I spent six years inside product teams before going out on my own, which is why I would rather sit in a support queue for an afternoon than run a workshop about personas.',
    personHowIWork:
      'I start with whatever is already shipped, find the three screens people get stuck on, and fix those before anyone talks about a redesign.',
    personFeel: 'That someone has finally read the support tickets.',
    personProudest:
      'A scheduling flow that cut a support queue in half without adding a single feature.',
    personToneWords: 'plain, direct, warm',
    activityWhat:
      'Product and interface design for software teams that already have users.',
    activityWho: 'Small software teams, usually five to thirty people',
    activityTypical:
      'Four to six weeks: a week reading tickets and watching sessions, then screens, then a week sitting with the engineers while it ships.',
    activityKnownFor: 'Untangling onboarding and checkout flows',
    activityYears: 'eleven years, four of them freelance',
  }),
  person: person({
    name: 'Sam Okafor',
    headline: 'Freelance product designer',
    story:
      'I spent six years inside product teams before going out on my own, which is why I would rather sit in a support queue for an afternoon than run a workshop about personas.',
    howIWork:
      'I start with whatever is already shipped, find the three screens people get stuck on, and fix those before anyone talks about a redesign.',
    values: 'No redesign for its own sake, and no research theatre.',
    feel: 'That someone has finally read the support tickets.',
    toneWords: ['plain', 'direct', 'warm'],
    proudestWork:
      'A scheduling flow that cut a support queue in half without adding a single feature.',
    links: [
      {
        kind: 'linkedin',
        url: 'https://linkedin.com/in/samokafor',
        consented: true,
      },
      { kind: 'github', url: 'https://github.com/samokafor', consented: true },
    ],
    activity: {
      what: 'Product and interface design for software teams that already have users.',
      who: 'Small software teams, usually five to thirty people',
      typical:
        'Four to six weeks: a week reading tickets and watching sessions, then screens, then a week sitting with the engineers while it ships.',
      knownFor: 'Untangling onboarding and checkout flows',
      years: 'eleven years, four of them freelance',
    },
  }),
  offer:
    'I redesign the parts of a product people get stuck on: onboarding, checkout, the settings nobody can find. Four to six week engagements, working alongside the team that ships it.',
  projects: [
    { name: 'Havenly', line: 'Rebuilt the scheduling flow.' },
    { name: 'Otterly', line: 'Onboarding, cut from nine screens to four.' },
  ],
  noProjects: false,
  portraitPath: '/flowstarter-media/sam-portrait.jpg',
  expect: {
    siteKind: 'portfolio',
    asksPersonQuestions: true,
    businessName: 'Sam Okafor',
    briefReady: true,
    blockingCodes: [],
  },
};

/**
 * A family lawyer in Cluj, Romanian, with a story and no photograph.
 *
 * "Lawyer" is on nobody's portfolio-signal list, so she is a portfolio only
 * because she is the whole business, which is exactly the branch
 * `visitorIsTheBusiness` exists for. Her brief is ready: a story alone
 * satisfies the person rule, and the missing portrait stays a `degrades`.
 */
const MARIA: Persona = {
  id: 'maria-avocat',
  summary: 'Family lawyer in Cluj, Romanian, story but no portrait',
  locale: 'ro',
  discovery: discovery({
    fullName: 'Maria Ionescu',
    email: 'maria@example.com',
    description:
      'Sunt avocat de dreptul familiei in Cluj. Lucrez singura, mai ales pe divorturi si custodie.',
    linkedinUrl: 'https://linkedin.com/in/mariaionescu',
    personStory:
      'Lucrez numai dreptul familiei pentru ca aici conteaza cel mai mult cine sta in fata ta. Le spun oamenilor de la inceput ce sanse au, chiar daca asta inseamna sa nu ma angajeze.',
    personHowIWork:
      'O prima discutie de o ora, gratuita, si un onorariu fix pe etape, ca sa stie oamenii de la inceput cat costa.',
    personFeel: 'Ca au in sfarsit pe cineva care le spune adevarul.',
    personToneWords: 'calm, clar, direct',
    activityWhat: 'Dreptul familiei: divorturi, custodie, partaje.',
    activityWho: 'Parinti care trec printr-un divort',
    activityKnownFor: 'Custodie si mediere',
    activityYears: 'paisprezece ani',
  }),
  person: person({
    name: 'Maria Ionescu',
    headline: 'Avocat de dreptul familiei, Cluj',
    story:
      'Lucrez numai dreptul familiei pentru ca aici conteaza cel mai mult cine sta in fata ta. Le spun oamenilor de la inceput ce sanse au, chiar daca asta inseamna sa nu ma angajeze.',
    howIWork:
      'O prima discutie de o ora, gratuita, si un onorariu fix pe etape, ca sa stie oamenii de la inceput cat costa.',
    feel: 'Ca au in sfarsit pe cineva care le spune adevarul.',
    toneWords: ['calm', 'clar', 'direct'],
    links: [
      {
        kind: 'linkedin',
        url: 'https://linkedin.com/in/mariaionescu',
        consented: false,
      },
    ],
    activity: {
      what: 'Dreptul familiei: divorturi, custodie, partaje.',
      who: 'Parinti care trec printr-un divort',
      typical: '',
      knownFor: 'Custodie si mediere',
      years: 'paisprezece ani',
    },
  }),
  offer:
    'Reprezint parinti in divorturi si in dosare de custodie, cu onorariu fix pe etape si o prima discutie gratuita de o ora. Lucrez singura, asa ca vorbiti tot timpul cu mine.',
  projects: [],
  noProjects: true,
  portraitPath: '',
  expect: {
    siteKind: 'portfolio',
    asksPersonQuestions: true,
    businessName: 'Maria Ionescu',
    briefReady: true,
    blockingCodes: [],
  },
};

/**
 * A personal trainer, English, with a photograph and no story.
 *
 * The mirror of Maria, and the reason the rule is "no portrait AND no story"
 * rather than "no story". A face is something of them, so his build runs.
 */
const TOM: Persona = {
  id: 'tom-trainer',
  summary: 'Personal trainer, English, portrait but no story',
  locale: 'en',
  discovery: discovery({
    fullName: 'Tom Brennan',
    email: 'tom@example.com',
    description:
      'Personal trainer. I coach people who have not trained in years, mostly in a small gym in Leeds.',
    instagramUrl: 'https://instagram.com/tombrennanpt',
    activityWhat: 'Strength coaching for beginners.',
    activityWho: 'People coming back after a long break',
    activityYears: 'six years',
  }),
  person: person({
    name: 'Tom Brennan',
    headline: 'Strength coach, Leeds',
    // Asked, and skipped. This is the state that must not look like "nobody
    // asked": his brief still builds, because he sent a photograph.
    story: '',
    links: [
      {
        kind: 'instagram',
        url: 'https://instagram.com/tombrennanpt',
        consented: true,
      },
    ],
    activity: {
      what: 'Strength coaching for beginners.',
      who: 'People coming back after a long break',
      typical: '',
      knownFor: '',
      years: 'six years',
    },
  }),
  offer:
    'One to one strength coaching for people who have not trained in years. Twelve week blocks, two sessions a week, in a small gym in Leeds.',
  projects: [],
  noProjects: true,
  portraitPath: '/flowstarter-media/tom-portrait.jpg',
  expect: {
    siteKind: 'portfolio',
    asksPersonQuestions: true,
    businessName: 'Tom Brennan',
    briefReady: true,
    blockingCodes: [],
  },
};

/**
 * An independent accountant, English, with neither a photograph nor a story.
 *
 * The persona this whole change exists for, and the only one whose brief must
 * NOT be ready. She has been asked (her person section exists and is empty),
 * she is the whole business, and there is nothing of her to put on a site
 * about her. The build waits with `brief_person_missing` and its ask.
 */
const NADIA: Persona = {
  id: 'nadia-accountant',
  summary: 'Independent accountant, English, asked and skipped everything',
  locale: 'en',
  discovery: discovery({
    fullName: 'Nadia Halim',
    email: 'nadia@example.com',
    description: 'Accountant. I do books and VAT for small limited companies.',
    websiteUrl: 'https://example-accounts.co.uk',
    websiteIsOwnSite: 'no',
  }),
  // Asked, and every answer skipped. Not `null`: the difference is the whole
  // reason the gate can block her and cannot block a brief taken last month.
  person: person({}),
  offer:
    'Bookkeeping, VAT returns and year end accounts for small limited companies. Fixed monthly fee, and I do the filing myself rather than passing it on.',
  projects: [],
  noProjects: true,
  portraitPath: '',
  expect: {
    siteKind: 'portfolio',
    asksPersonQuestions: true,
    businessName: 'Nadia Halim',
    briefReady: false,
    blockingCodes: ['brief_person_missing'],
  },
};

/**
 * A ceramicist in Iasi with a small shop, Romanian.
 *
 * "Maker" is a portfolio signal, and she has a trading name, so she is the
 * case where the site is a portfolio and the business name is NOT her own:
 * the derivation must read "Lut si Foc" out of her own sentence and leave her
 * name for the about page.
 */
const ELENA: Persona = {
  id: 'elena-ceramica',
  summary: 'Ceramics maker with a shop, Romanian, trading name of her own',
  locale: 'ro',
  discovery: discovery({
    fullName: 'Elena Dobre',
    email: 'elena@example.com',
    description:
      'Lut si Foc, un atelier mic de ceramica in Iasi. Fac vase de bucatarie, arse cu lemn.',
    industry: 'Creative & design',
    websiteUrl: 'https://lutsifoc.ro',
    websiteIsOwnSite: 'yes',
    personStory:
      'Fac ceramica de opt ani, in acelasi atelier de langa Copou. Fiecare vas iese putin altfel si asta imi place la el.',
    personHowIWork:
      'Lucrez in serii mici, ard cu lemn o data la sase saptamani, si nu fac doua vase identice.',
    personToneWords: 'cald, simplu, mestesugit',
    activityWhat: 'Ceramica de bucatarie, arsa cu lemn, in serii mici.',
    activityWho: 'Oameni care gatesc acasa si restaurante mici',
    activityTypical:
      'O serie de treizeci de piese la sase saptamani, plus comenzi pentru restaurante.',
    activityKnownFor: 'Boluri si farfurii arse cu lemn',
    activityYears: 'opt ani',
  }),
  person: person({
    name: 'Elena Dobre',
    headline: 'Ceramista, atelierul Lut si Foc, Iasi',
    story:
      'Fac ceramica de opt ani, in acelasi atelier de langa Copou. Fiecare vas iese putin altfel si asta imi place la el.',
    howIWork:
      'Lucrez in serii mici, ard cu lemn o data la sase saptamani, si nu fac doua vase identice.',
    toneWords: ['cald', 'simplu', 'mestesugit'],
    links: [{ kind: 'website', url: 'https://lutsifoc.ro', consented: true }],
    activity: {
      what: 'Ceramica de bucatarie, arsa cu lemn, in serii mici.',
      who: 'Oameni care gatesc acasa si restaurante mici',
      typical:
        'O serie de treizeci de piese la sase saptamani, plus comenzi pentru restaurante.',
      knownFor: 'Boluri si farfurii arse cu lemn',
      years: 'opt ani',
    },
  }),
  offer:
    'Vase de bucatarie din ceramica, arse cu lemn, in serii mici de treizeci de piese. Fac si comenzi pentru restaurante mici, cu forme alese impreuna.',
  projects: [
    { name: 'Seria Copou', line: 'Treizeci de boluri, arse cu lemn.' },
  ],
  noProjects: false,
  portraitPath: '/flowstarter-media/elena-portrait.jpg',
  expect: {
    siteKind: 'portfolio',
    // A trading name of her own does not stop the site being about her: she
    // is still the only person in it, and the about page is still hers.
    asksPersonQuestions: true,
    businessName: 'Lut Si Foc',
    briefReady: true,
    blockingCodes: [],
  },
};

/**
 * An independent AI researcher in English, who owns the domain his preview
 * sits on and answered the whole person block.
 *
 * The real incident: he typed his own name at step 1, confirmed the one
 * link pasted was his own site, and then answered all eleven person and
 * activity questions about himself. The naming rule read the owned hostname
 * first and never looked at the section he had just filled in, so
 * `deriveBusinessName` named him after a subdomain and `visitorIsTheBusiness`
 * -- comparing that hostname to his own name -- came back false, which sent
 * him through the whole funnel as a company with no name it could state. A
 * completed person section now outranks an owned hostname, so this case
 * resolves to his own name, a personal site kind, and a portfolio template.
 */
const DARIUS: Persona = {
  id: 'darius-portfolio',
  summary:
    'Independent AI researcher, English, owns his domain, full person block',
  locale: 'en',
  discovery: discovery({
    fullName: 'Darius Mihai Popescu',
    email: 'darius@example.com',
    description:
      'I research AI agent workflows and build small products with them, mostly for other independent developers.',
    websiteUrl: 'https://dmpresearch.flowstarter.dev',
    websiteIsOwnSite: 'yes',
    personStory:
      'I started writing agents to get through my own backlog faster and kept going because the failures were more interesting than the successes.',
    personHowIWork:
      'I ship a small thing, watch where it breaks, and rebuild the part that broke rather than the whole system.',
    personFeel:
      'That this was actually built by the person whose name is on it.',
    personProudest:
      'A review agent that caught a production bug three reviewers had already approved past.',
    personToneWords: 'direct, curious, precise',
    activityWhat:
      'Agent workflows and small research tools, mostly for other independent developers.',
    activityWho: 'Other independent developers and small technical teams',
    activityTypical:
      'A short call to understand the failure mode, then a working prototype within a week.',
    activityKnownFor: 'Turning a vague failure report into a reproducible test',
    activityYears: 'five years',
  }),
  person: person({
    name: 'Darius Mihai Popescu',
    headline: 'Independent AI researcher',
    story:
      'I started writing agents to get through my own backlog faster and kept going because the failures were more interesting than the successes.',
    howIWork:
      'I ship a small thing, watch where it breaks, and rebuild the part that broke rather than the whole system.',
    feel: 'That this was actually built by the person whose name is on it.',
    toneWords: ['direct', 'curious', 'precise'],
    proudestWork:
      'A review agent that caught a production bug three reviewers had already approved past.',
    links: [
      {
        kind: 'website',
        url: 'https://dmpresearch.flowstarter.dev',
        consented: true,
      },
    ],
    activity: {
      what: 'Agent workflows and small research tools, mostly for other independent developers.',
      who: 'Other independent developers and small technical teams',
      typical:
        'A short call to understand the failure mode, then a working prototype within a week.',
      knownFor: 'Turning a vague failure report into a reproducible test',
      years: 'five years',
    },
  }),
  offer:
    'Agent workflows and small research tools built for other independent developers, from a short call to a working prototype in about a week.',
  projects: [
    { name: 'Sigma classifier', line: 'A taxonomy-agnostic guardrail core.' },
  ],
  noProjects: false,
  portraitPath: '',
  expect: {
    siteKind: 'portfolio',
    asksPersonQuestions: true,
    businessName: 'Darius Mihai Popescu',
    briefReady: true,
    blockingCodes: [],
  },
};

/**
 * A family-run car garage in English, whose owner filled in the intake, owns
 * the garage's own site, and was never asked about a person.
 *
 * The control for the fix above, the same way `orchard-plumbing` controls
 * the first one: an owned site is still the right thing to name a company
 * after when nobody has said anything about themselves. Read the fixture
 * next to `darius-portfolio` and the only difference is the eleven person
 * answers -- which is exactly the signal the precedence rule turns on.
 */
const HENDRY: Persona = {
  id: 'hendry-motors',
  summary:
    'Car garage, English, owns its site, never asked about a person: stays a company',
  locale: 'en',
  discovery: discovery({
    fullName: 'Paul Hendry',
    email: 'paul@example.com',
    description:
      'A family run garage in Leeds doing servicing, MOTs and repairs for most makes.',
    websiteUrl: 'https://hendrymotors.co.uk',
    websiteIsOwnSite: 'yes',
  }),
  person: null,
  offer:
    'Servicing, MOTs and repairs for most makes, with a courtesy car for anything kept overnight.',
  projects: [],
  noProjects: true,
  portraitPath: '',
  expect: {
    siteKind: 'services',
    asksPersonQuestions: false,
    businessName: 'Hendrymotors',
    briefReady: true,
    blockingCodes: [],
  },
};

/**
 * The control, and the persona the person block must never reach.
 *
 * A plumbing company with a name, a van and two employees. Its site is about
 * a trade and a catchment area; a first-person life story on one is a genre
 * mistake, not a missing feature. Every assertion about "who is asked" is
 * only worth anything because this fixture is in the list.
 */
const PLUMBER: Persona = {
  id: 'orchard-plumbing',
  summary: 'Plumbing company, English, the control: never asked about a person',
  locale: 'en',
  discovery: discovery({
    fullName: 'Dave Sutton',
    email: 'dave@example.com',
    businessName: 'Orchard Plumbing',
    description:
      'Orchard Plumbing, a two van plumbing and heating company covering south Leeds. Boilers, bathrooms and emergency callouts.',
    industry: 'Professional services',
    websiteUrl: 'https://orchardplumbing.example',
    websiteIsOwnSite: 'yes',
  }),
  person: null,
  offer:
    'Boiler servicing and replacement, bathroom installation and emergency callouts across south Leeds. Two vans, same day for emergencies, fixed quotes before we start.',
  projects: [],
  noProjects: true,
  portraitPath: '',
  expect: {
    siteKind: 'services',
    asksPersonQuestions: false,
    businessName: 'Orchard Plumbing',
    briefReady: true,
    blockingCodes: [],
  },
};

/**
 * Every persona, in a stable order.
 *
 * Exported as one array so a suite can loop it and a new persona is covered
 * by every existing assertion the moment it is added here, rather than by
 * whichever tests somebody remembers to update.
 */
export const PERSONAS: readonly Persona[] = [
  IOANA,
  SAM,
  MARIA,
  TOM,
  NADIA,
  ELENA,
  PLUMBER,
  DARIUS,
  HENDRY,
];

/** One persona by id, for a suite that wants to name the case it is making. */
export function persona(id: string): Persona {
  const found = PERSONAS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no persona fixture named ${id}`);
  return found;
}
