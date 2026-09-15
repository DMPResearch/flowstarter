/**
 * What we say when the gate stops someone.
 *
 * Pure, so a test can read the exact sentence a stranger will read, and so the
 * six enforcement points all say the same thing.
 *
 * The tone is set deliberately. A refusal is the worst moment in the funnel
 * and most of the people who hit it are not criminals: they are a lingerie
 * shop, a pharmacy, or someone whose four-word description read badly. So the
 * copy is polite, it names the policy in one sentence, it links to the clause,
 * and it offers a person. It does not lecture, it does not accuse, and it
 * never repeats the visitor's own words back at them.
 *
 * House rules: no em dashes, no emoji.
 *
 * Locale: a review verdict is also where every uncertain answer lands,
 * including a broken classifier (see `acceptable-use.ts`'s `PolicyDecision`
 * doc), so `reviewNotice` is the one copy a visitor reads whether the reason
 * was a sensitive category or the classifier itself failing closed. There is
 * no third, separate "unclear" notice: `refusalNotice` and `reviewNotice`
 * are the whole surface, and both take the visitor's locale so a Romanian
 * request reads Romanian rather than falling back to English mid-funnel.
 * `category.label` / `category.reason` stay in English regardless of
 * locale -- translating the acceptable-use category list itself is a
 * separate, much larger change to `acceptable-use.ts` this fix does not make.
 */

import {
  CLEAN_CATEGORY,
  type PolicyCategory,
  type PolicyDecision,
  type PolicyRule,
} from './acceptable-use';

/** The anchor on `/terms`. The heading there carries this id. */
export const ACCEPTABLE_USE_ANCHOR = '/terms#acceptable-use';
export const CONTACT_HREF = '/contact';

/**
 * The two languages the funnel's intake asks a visitor to pick from (see
 * `IntakeGraphLocale` in `src/lib/flowstarter/intake-graph/types.ts`, and
 * `src/locales/{en,ro}.ts` for the rest of the app's copy). Defaults to
 * `'en'` everywhere in this module, so every existing caller that has not
 * been taught to pass a locale yet keeps today's behaviour exactly.
 */
export type PolicyLocale = 'en' | 'ro';

export interface PolicyNotice {
  /** A short heading, for a card or a dialog. */
  title: string;
  /** The sentence that names the policy. */
  message: string;
  /** What happens next, in one sentence. */
  next: string;
  termsHref: string;
  contactHref: string;
  /**
   * The words on the two links, in the same language as everything above.
   *
   * They live here rather than in the components because they did not, and
   * the result was a Romanian visitor reading a Romanian refusal under two
   * English links: `PreviewStep` hardcoded "Read the acceptable use section
   * of our terms" and "Talk to a person" as literals. A notice that carries
   * its own language for three sentences and not for the two words a visitor
   * actually clicks is a notice that is only half translated.
   */
  termsLabel: string;
  contactLabel: string;
  /** Machine-readable, for a client that branches rather than renders. */
  decision: PolicyDecision;
  categoryId: string;
  /** The language `title`/`message`/`next` are written in. */
  locale: PolicyLocale;
}

interface NoticeStrings {
  title: string;
  message: (category: PolicyCategory) => string;
  next: string;
}

/** The two link labels, once per language, shared by all three notices. */
const LINK_LABELS: Record<PolicyLocale, { terms: string; contact: string }> = {
  en: {
    terms: 'Read the acceptable use section of our terms',
    contact: 'Talk to a person',
  },
  ro: {
    terms: 'Citiți secțiunea despre utilizarea acceptabilă din termenii noștri',
    contact: 'Vorbiți cu o persoană',
  },
};

const REFUSAL_STRINGS: Record<PolicyLocale, NoticeStrings> = {
  en: {
    title: 'We cannot build this one',
    message: (category) =>
      `Our acceptable-use policy does not allow us to build sites for ${category.label.toLowerCase()}, so we have stopped here and nothing has been charged.`,
    next: 'If we have read your business wrong, tell us what you do and a person will look at it.',
  },
  ro: {
    title: 'Nu putem construi acest site',
    message: (category) =>
      `Politica noastră de utilizare acceptabilă nu ne permite să construim site-uri pentru ${category.label.toLowerCase()}, așa că ne oprim aici și nu s-a taxat nimic.`,
    next: 'Dacă am înțeles greșit despre ce este vorba, spuneți-ne cu ce vă ocupați și o persoană va analiza cazul.',
  },
};

const REVIEW_STRINGS: Record<PolicyLocale, NoticeStrings> = {
  en: {
    title: 'One of us needs to look at this first',
    message: () =>
      'Your business sits close enough to our acceptable-use policy that a person checks it rather than a machine deciding, so we have paused here and nothing has been charged.',
    next: 'We usually come back the same working day. You can add anything that helps, such as a licence number, through the contact page.',
  },
  ro: {
    title: 'Trebuie mai întâi să verificăm',
    message: () =>
      'Afacerea dvs. se apropie suficient de politica noastră de utilizare acceptabilă încât o persoană o verifică, nu o mașină, așa că am pus totul pe pauză aici și nu s-a taxat nimic.',
    next: 'De obicei revenim în aceeași zi lucrătoare. Puteți adăuga orice ajută, precum un număr de licență, prin pagina de contact.',
  },
};

/**
 * The refusal. One sentence of policy, one of consequence, one door out.
 *
 * The category label is included because vagueness here is cruel: "we cannot
 * help with this" leaves a lingerie shop guessing, while "adult content and
 * its promotion" tells them we read them wrong and that the contact link is
 * worth using.
 */
export function refusalNotice(
  category: PolicyCategory,
  locale: PolicyLocale = 'en'
): PolicyNotice {
  const strings = REFUSAL_STRINGS[locale];
  return {
    title: strings.title,
    message: strings.message(category),
    next: strings.next,
    termsHref: ACCEPTABLE_USE_ANCHOR,
    contactHref: CONTACT_HREF,
    termsLabel: LINK_LABELS[locale].terms,
    contactLabel: LINK_LABELS[locale].contact,
    decision: 'refuse',
    categoryId: category.id,
    locale,
  };
}

/**
 * The review. Not a refusal, and it must not read like one: this is where the
 * pharmacy and the licensed bookmaker land, and they are customers.
 */
export function reviewNotice(
  category: PolicyCategory,
  locale: PolicyLocale = 'en'
): PolicyNotice {
  const strings = REVIEW_STRINGS[locale];
  return {
    title: strings.title,
    message: strings.message(category),
    next: strings.next,
    termsHref: ACCEPTABLE_USE_ANCHOR,
    contactHref: CONTACT_HREF,
    termsLabel: LINK_LABELS[locale].terms,
    contactLabel: LINK_LABELS[locale].contact,
    decision: 'review',
    categoryId: category.id,
    locale,
  };
}

/**
 * The hold: we could not finish checking, so a person will.
 *
 * Its own copy rather than `reviewNotice`'s, and the difference is not
 * cosmetic. The review copy says "your business sits close enough to our
 * acceptable-use policy that a person checks it" -- a claim ABOUT THE
 * BUSINESS, and one we have no standing to make here, because the reason this
 * notice is showing is that nothing succeeded in reading the business at all.
 * Telling a florist their brief looked borderline when in fact our classifier
 * timed out is both untrue and, to the small minority who notice, insulting.
 *
 * So it says what happened, in the house voice: the check did not finish, a
 * person picks it up, nothing has been charged. No category is named because
 * there is none to name -- `categoryId` is the clean id, which is the honest
 * value and the one the operator board already knows how to render.
 */
const HOLD_STRINGS: Record<PolicyLocale, NoticeStrings> = {
  en: {
    title: 'We are still checking this one',
    message: () =>
      'Our automatic check did not finish on your brief, so rather than guess we have passed it to a person to read. Nothing has been charged and nothing has been built yet.',
    next: 'We usually come back the same working day. If you would rather not wait, tell us more about what you do through the contact page.',
  },
  ro: {
    title: 'Încă verificăm',
    message: () =>
      'Verificarea automată nu s-a finalizat pentru solicitarea dvs., așa că nu ghicim: am trimis-o unei persoane care o va citi. Nu s-a taxat nimic și nu s-a construit nimic încă.',
    next: 'De obicei revenim în aceeași zi lucrătoare. Dacă preferați să nu așteptați, spuneți-ne mai multe despre ce faceți prin pagina de contact.',
  },
};

export function holdNotice(locale: PolicyLocale = 'en'): PolicyNotice {
  const strings = HOLD_STRINGS[locale];
  return {
    title: strings.title,
    message: strings.message(CLEAN_CATEGORY),
    next: strings.next,
    termsHref: ACCEPTABLE_USE_ANCHOR,
    contactHref: CONTACT_HREF,
    termsLabel: LINK_LABELS[locale].terms,
    contactLabel: LINK_LABELS[locale].contact,
    decision: 'review',
    categoryId: CLEAN_CATEGORY.id,
    locale,
  };
}

/**
 * The notice for a verdict, or `null` when the verdict allows.
 *
 * `rule` is read, not just `decision`, because a `review` produced by
 * `classifier_unavailable` is a different thing to say to a visitor than a
 * `review` produced by `sensitive_lawful`. Callers that do not pass it keep
 * exactly today's behaviour.
 */
export function noticeFor(input: {
  decision: PolicyDecision;
  category: PolicyCategory;
  rule?: PolicyRule;
  locale?: PolicyLocale;
}): PolicyNotice | null {
  if (input.decision === 'refuse')
    return refusalNotice(input.category, input.locale);
  if (input.decision === 'review') {
    return input.rule === 'classifier_unavailable'
      ? holdNotice(input.locale)
      : reviewNotice(input.category, input.locale);
  }
  return null;
}

const PARAGRAPH_SUFFIX: Record<PolicyLocale, (notice: PolicyNotice) => string> =
  {
    en: (notice) =>
      `You can read the acceptable-use section of our terms at ${notice.termsHref} or reach us at ${notice.contactHref}.`,
    ro: (notice) =>
      `Puteți citi secțiunea despre utilizarea acceptabilă din termenii noștri la ${notice.termsHref} sau ne puteți contacta la ${notice.contactHref}.`,
  };

/**
 * The same refusal as one paragraph, for surfaces with no room for a card:
 * an email body, a plain-text API message, a build log line.
 */
export function noticeParagraph(notice: PolicyNotice): string {
  return `${notice.message} ${notice.next} ${PARAGRAPH_SUFFIX[notice.locale](
    notice
  )}`;
}
