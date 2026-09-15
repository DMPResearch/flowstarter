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

import type { PolicyCategory, PolicyDecision } from './acceptable-use';

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
    decision: 'review',
    categoryId: category.id,
    locale,
  };
}

/** The notice for a verdict, or `null` when the verdict allows. */
export function noticeFor(input: {
  decision: PolicyDecision;
  category: PolicyCategory;
  locale?: PolicyLocale;
}): PolicyNotice | null {
  if (input.decision === 'refuse')
    return refusalNotice(input.category, input.locale);
  if (input.decision === 'review')
    return reviewNotice(input.category, input.locale);
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
