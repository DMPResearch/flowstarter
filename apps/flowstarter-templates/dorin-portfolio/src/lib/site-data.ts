import { frontmatter as rawSiteLabels } from '../content/site-labels.md';

type AnyRecord = Record<string, any>;

export interface TitleLine {
  text?: string;
  accent?: string;
  suffix?: string;
  suffixColor?: string;
}

export interface LinkItem {
  label: string;
  href: string;
}

export interface ArticleItem {
  imageSrc: string;
  imageAlt: string;
  title: string;
  excerpt: string;
  href: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface ImageItem {
  imageSrc: string;
  imageAlt: string;
}

export interface JourneyItem {
  year: string;
  title: string;
  description: string;
  keyMoment: string;
  achievement: string;
}

const siteLabels = rawSiteLabels as AnyRecord;

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const asTitleLines = (value: unknown): TitleLine[] =>
  Array.isArray(value)
    ? value.map((item) => ({
        text: asString((item as AnyRecord)?.text),
        accent: asString((item as AnyRecord)?.accent),
        suffix: asString((item as AnyRecord)?.suffix),
        suffixColor: asString((item as AnyRecord)?.suffixColor),
      }))
    : [];

const asLinks = (value: unknown): LinkItem[] =>
  Array.isArray(value)
    ? value.map((item) => ({
        label: asString((item as AnyRecord)?.label),
        href: asString((item as AnyRecord)?.href, '#'),
      }))
    : [];

const asArticles = (value: unknown): ArticleItem[] =>
  Array.isArray(value)
    ? value.map((item) => ({
        imageSrc: asString((item as AnyRecord)?.imageSrc),
        imageAlt: asString((item as AnyRecord)?.imageAlt),
        title: asString((item as AnyRecord)?.title),
        excerpt: asString((item as AnyRecord)?.excerpt),
        href: asString((item as AnyRecord)?.href, '#'),
      }))
    : [];

const asFaqItems = (value: unknown): FaqItem[] =>
  Array.isArray(value)
    ? value.map((item) => ({
        question: asString((item as AnyRecord)?.question),
        answer: asString((item as AnyRecord)?.answer),
      }))
    : [];

const asImages = (value: unknown): ImageItem[] =>
  Array.isArray(value)
    ? value.map((item) => ({
        imageSrc: asString((item as AnyRecord)?.imageSrc),
        imageAlt: asString((item as AnyRecord)?.imageAlt),
      }))
    : [];

const asJourneyItems = (value: unknown): JourneyItem[] =>
  Array.isArray(value)
    ? value.map((item) => ({
        year: asString((item as AnyRecord)?.year),
        title: asString((item as AnyRecord)?.title),
        description: asString((item as AnyRecord)?.description),
        keyMoment: asString((item as AnyRecord)?.keyMoment),
        achievement: asString((item as AnyRecord)?.achievement),
      }))
    : [];

export const getHeaderNavLinks = (): LinkItem[] => asLinks(siteLabels.header?.navLinks);

export const getAboutPageData = () => {
  const aboutPage = (siteLabels.aboutPage ?? {}) as AnyRecord;
  const intro = (aboutPage.intro ?? {}) as AnyRecord;
  const freeTime = (aboutPage.freeTime ?? {}) as AnyRecord;
  const backgroundExperience = (aboutPage.backgroundExperience ?? {}) as AnyRecord;
  const journey = (aboutPage.journey ?? {}) as AnyRecord;
  const latestArticles = (aboutPage.latestArticles ?? {}) as AnyRecord;

  return {
    heroLines: asTitleLines(aboutPage.heroLines),
    intro: {
      eyebrow: asString(intro.eyebrow),
      paragraphs: asStringArray(intro.paragraphs),
      buttonLabel: asString(intro.buttonLabel),
      buttonHref: asString(intro.buttonHref, '#'),
      imageSrc: asString(intro.imageSrc),
      imageAlt: asString(intro.imageAlt),
    },
    freeTime: {
      titleLines: asTitleLines(freeTime.titleLines),
      paragraphs: asStringArray(freeTime.paragraphs),
      imageSrc: asString(freeTime.imageSrc),
      imageAlt: asString(freeTime.imageAlt),
    },
    backgroundExperience: {
      eyebrow: asString(backgroundExperience.eyebrow),
      title: asString(backgroundExperience.title),
      imageSrc: asString(backgroundExperience.imageSrc),
      imageAlt: asString(backgroundExperience.imageAlt),
      paragraphs: asStringArray(backgroundExperience.paragraphs),
      whyWorkWithMeTitle: asString(backgroundExperience.whyWorkWithMeTitle),
      whyWorkWithMeText: asString(backgroundExperience.whyWorkWithMeText),
      items: [
        ...asStringArray(backgroundExperience.uvps),
        ...asStringArray(backgroundExperience.reasons),
      ],
    },
    journey: {
      title: asString(journey.title),
      intro: asString(journey.intro),
      items: asJourneyItems(journey.items),
    },
    latestArticles: {
      title: asString(latestArticles.title),
      buttonLabel: asString(latestArticles.buttonLabel),
      buttonHref: asString(latestArticles.buttonHref, '#'),
      articles: asArticles(latestArticles.articles),
    },
  };
};

export const getContactPageData = () => {
  const contactPage = (siteLabels.contactPage ?? {}) as AnyRecord;
  const form = (contactPage.form ?? {}) as AnyRecord;
  const details = (contactPage.details ?? {}) as AnyRecord;

  return {
    titleLines: asTitleLines(contactPage.titleLines),
    introText: asString(contactPage.introText),
    form: {
      title: asString(form.title),
      note: asString(form.note),
      fullNameLabel: asString(form.fullNameLabel),
      fullNamePlaceholder: asString(form.fullNamePlaceholder),
      emailLabel: asString(form.emailLabel),
      emailPlaceholder: asString(form.emailPlaceholder),
      phoneLabel: asString(form.phoneLabel),
      phonePlaceholder: asString(form.phonePlaceholder),
      messageLabel: asString(form.messageLabel),
      messagePlaceholder: asString(form.messagePlaceholder),
      submitLabel: asString(form.submitLabel),
      successMessage: asString(form.successMessage),
      sentMessage: asString(form.sentMessage),
      failureMessage: asString(form.failureMessage),
    },
    details: {
      emailLabel: asString(details.emailLabel),
      emailValue: asString(details.emailValue),
      emailHref: asString(details.emailHref, '#'),
      phoneLabel: asString(details.phoneLabel),
      phoneValue: asString(details.phoneValue),
      phoneHref: asString(details.phoneHref, '#'),
      addressLabel: asString(details.addressLabel),
      addressValue: asString(details.addressValue),
      mapEmbedUrl: asString(details.mapEmbedUrl),
      strategicCallLabel: asString(details.strategicCallLabel),
      strategicCallHref: asString(details.strategicCallHref, '#'),
    },
  };
};

export const getServicesPageData = () => {
  const servicesPage = (siteLabels.servicesPage ?? {}) as AnyRecord;
  const faq = (servicesPage.faq ?? {}) as AnyRecord;

  return {
    heroLines: asTitleLines(servicesPage.heroLines),
    heroImages: asImages(servicesPage.heroImages),
    faq: {
      title: asString(faq.title),
      items: asFaqItems(faq.items),
    },
  };
};

export const getCaseStudyProjects = () =>
  Array.isArray(siteLabels.caseStudies?.projects) ? siteLabels.caseStudies.projects : [];

export { siteLabels };
