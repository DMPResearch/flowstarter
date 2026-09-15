/**
 * The landing header menu and the numbered section eyebrows share this list.
 * Keep the order identical to the page: a visitor who walks the menu top to
 * bottom should meet the same sections, with the same index, in the same
 * order. Anything else on the page that wants a masthead line stays
 * unnumbered so it cannot collide with these four.
 */
export const LANDING_NAV = [
  {
    id: 'process',
    index: '01',
    navKey: 'nav.process',
    eyebrowKey: 'landing.process.eyebrow',
  },
  {
    id: 'editor-showcase',
    index: '02',
    navKey: 'nav.smartEditor',
    eyebrowKey: 'landing.editorShowcase.eyebrow',
  },
  {
    id: 'pricing',
    index: '03',
    navKey: 'nav.pricing',
    eyebrowKey: 'landing.pricing.eyebrow',
  },
  {
    id: 'faq',
    index: '04',
    navKey: 'nav.faq',
    eyebrowKey: 'landing.faq.eyebrow',
  },
] as const;

export type LandingNavId = (typeof LANDING_NAV)[number]['id'];

export const LANDING_NAV_IDS = LANDING_NAV.map((item) => item.id);

export function landingNavIndex(id: LandingNavId): string {
  const item = LANDING_NAV.find((entry) => entry.id === id);
  if (!item) {
    throw new Error(`Unknown landing nav id: ${id}`);
  }
  return item.index;
}
