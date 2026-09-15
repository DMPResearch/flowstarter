/**
 * Every colour, every type size and every measurement an email is allowed to
 * use. Nothing else in `email-templates/` writes a literal.
 *
 * The reason is not tidiness. An email cannot be inspected after it is sent:
 * there is no dev server, no cascade to override and no second deploy that
 * fixes the copy already sitting in somebody's inbox. So the only way to hold
 * the design to a rule is to make the rule a value, put it here, and let the
 * tests read the same values the renderer does. `base.test.ts` measures every
 * foreground against every background it can land on, and `templates.test.ts`
 * walks the rendered HTML and fails on any colour that is not in
 * `EMAIL_PALETTE`. Neither test can be satisfied by a literal typed into a
 * style attribute, which is the point.
 *
 * The palette itself is the product's, not a second one invented for email: a
 * near-neutral cream field, a white card, ink that is almost black with a
 * trace of the brand's blue in it, and the Flowstarter indigo used as an
 * accent rather than a wash. That is the same ruling the design system's
 * surfaces are held to (quiet tiles, near-neutral field, no gradients), said
 * in the one language every mail client understands, which is a hex value on
 * an element.
 */

/**
 * Light and dark are the same design with different ink. Both pass AA.
 *
 * `light.accent` is a darker indigo than the brand's own `hsl(233 65% 58%)`
 * (`#4e5fda`) because that value is 3.5:1 on white and a link has to clear
 * 4.5:1. The brand value returns unchanged in dark mode as `dark.button`,
 * where the background it sits on makes it legible again.
 */
export const EMAIL_COLORS = {
  light: {
    page: '#fbf7ef',
    card: '#ffffff',
    ink: '#120a22',
    inkDim: '#565073',
    rule: '#e8e1d3',
    panel: '#f7f3ea',
    quoteRule: '#c9c0ad',
    accent: '#2d40d2',
    accentInk: '#ffffff',
  },
  dark: {
    page: '#040308',
    card: '#100e1c',
    ink: '#f4eee4',
    inkDim: '#b4afac',
    rule: '#241f38',
    panel: '#191527',
    quoteRule: '#494068',
    accent: '#8e99eb',
    accentInk: '#ffffff',
    button: '#4e5fda',
  },
} as const;

/**
 * Every hex the palette contains, lowercased, for the test that walks the
 * rendered HTML. Derived rather than listed, so adding a colour above is the
 * only edit needed and removing one cannot leave a stale entry behind.
 */
export const EMAIL_PALETTE: ReadonlySet<string> = new Set(
  [
    ...Object.values(EMAIL_COLORS.light),
    ...Object.values(EMAIL_COLORS.dark),
  ].map((hex) => hex.toLowerCase())
);

/**
 * The display face.
 *
 * A transactional email from this product is correspondence, not a screen: it
 * is one person telling another person a fact about their work.
 * Correspondence is set in a text serif, and this is the rare brief where
 * that is a reason rather than a reflex, because the alternative here is not
 * a distinctive sans, it is the same system sans the body is already in,
 * which leaves a heading distinguishable from a paragraph only by being
 * bigger.
 *
 * The stack is ordered so that the fallback is the design rather than a
 * degradation. Charter (macOS, and Bitstream Charter on Linux) and Sitka Text
 * (Windows 10 and later) are both modern text serifs with short ascenders and
 * a large x-height, which is what holds up at 19px inside a 600px column.
 * Cambria is the Office fallback and the one Word-rendered Outlook will
 * actually pick. Georgia is the floor and is on every machine that has ever
 * read an email. Any of the five reads as a considered choice; none of them
 * costs a request.
 */
export const EMAIL_FONTS = {
  /** The family name declared by the single `@font-face` in `emailFontFace`. */
  displayFamily: 'Flowstarter Text',
  display:
    "'Flowstarter Text', Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, 'Times New Roman', serif",
  /**
   * The body face is whatever humanist sans the reader's platform already
   * ships: SF on Apple, Segoe on Windows, Roboto on Android. Asking for
   * anything else would mean a webfont, and a webfont in an email is a
   * network request the reader did not consent to and a read receipt we would
   * rather not collect. See `emailFontFace` for how the display face gets
   * character without one.
   */
  body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  /** For a value meant to be copied, never for prose. */
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

/**
 * The one `@font-face` in the system, and it fetches nothing.
 *
 * `src` is `local()` only. That is deliberate and it is the whole technique:
 * the rule names one family, `Flowstarter Text`, and resolves it against
 * faces the reader's machine already has, in the order we would have chosen
 * had we been allowed to ship a file. A client that honours `@font-face`
 * (Apple Mail, iOS Mail, Outlook for Mac) gets Charter. A client that strips
 * the `<style>` block entirely (Gmail's web and app readers do, in most
 * configurations) falls through to the same faces by way of the font stack in
 * `EMAIL_FONTS.display`, and looks identical.
 *
 * There is no `url()` and there will not be one. A hosted webfont in an email
 * costs a request per open, tells the host that the message was read and by
 * whom, is ignored by Word-rendered Outlook regardless, and would be a remote
 * asset of exactly the kind `markHtml` in `./base` refuses to depend on.
 * `lintEmailHtml` fails any `@font-face` that grows a `url()`.
 */
export function emailFontFace(): string {
  return `@font-face {
  font-family: '${EMAIL_FONTS.displayFamily}';
  src: local('Charter'), local('Charter Roman'), local('Bitstream Charter'), local('Sitka Text'), local('Cambria'), local('Georgia');
  font-style: normal;
  font-display: swap;
}`;
}

/**
 * The type scale, in pixels, because an email has no root font size to be
 * relative to and Outlook ignores `rem` outright.
 *
 * Ten steps for the whole system, and the jumps between the ones that matter
 * are wide enough to read as rank at a glance in a client that has thrown
 * away half the styling.
 */
export const EMAIL_TYPE = {
  heading: { size: 28, leading: 1.2, tracking: '-0.012em', weight: 600 },
  /** The standfirst: the one sentence that says why this email exists. */
  lede: { size: 19, leading: 1.5, weight: 400 },
  /** A URL that is itself the news. */
  hero: { size: 19, leading: 1.4, weight: 600 },
  /** The client's own words, quoted back. */
  quote: { size: 18, leading: 1.55, weight: 400 },
  body: { size: 16, leading: 1.65, weight: 400 },
  fact: { size: 15, leading: 1.5, weight: 400 },
  note: { size: 14, leading: 1.6, weight: 400 },
  footer: { size: 13, leading: 1.6, weight: 400 },
  /** Labels above a value, and the letterhead's queue line. Never prose. */
  micro: { size: 12, leading: 1.4, weight: 600, tracking: '0.07em' },
  button: { size: 16, leading: 20, weight: 600 },
  wordmark: { size: 21, tracking: '-0.025em', weight: 700 },
} as const;

/**
 * Widths, spacing and radii.
 *
 * The radii are concentric, the same rule the product's surfaces use: the
 * card is the outermost box at 16, anything inside it sits at 12, and a
 * control inside that sits at 10. A single scale, applied everywhere, is what
 * keeps a layout built out of 1998 table markup from looking like one.
 */
export const EMAIL_LAYOUT = {
  /** The width every email client has agreed on since Outlook 2007. */
  shellWidth: 600,
  /** Below this the shell goes fluid and the card's padding comes in. */
  mobileBreakpoint: 620,
  /** The letterhead and footer sit inside the card's edge by this much. */
  gutter: 8,
  gutterMobile: 22,
  radius: { card: 16, panel: 12, button: 10, mark: 8 },
  /** Between one block and the next. */
  blockGap: 18,
  /** After the standfirst's rule, which needs more air than a paragraph. */
  ledeGap: 22,
  /** Above and below the one primary button. */
  buttonGap: { top: 10, bottom: 24 },
  cardPadding: '36px 36px 28px',
  cardPaddingMobile: '28px 22px 22px',
  pagePadding: '32px 12px 40px',
  /** The letterhead's mark tile, and the space between it and the wordmark. */
  mark: { size: 34, gap: 10 },
  /** Between the letterhead's rule and the card below it. */
  letterheadGap: 16,
  letterheadPadding: 14,
  footerGap: 24,
  hairline: 1,
  quoteRuleWidth: 3,
  quotePadding: '14px 18px',
  panelPadding: '16px 18px',
  /** The label column in a facts table. Wide enough for "Their site". */
  factLabelWidth: 88,
  factRowGap: 10,
  /**
   * One line height for both cells of a facts row, in pixels.
   *
   * The label is 12px and the value 15px, and left to their own leading the
   * two sit a visible three pixels apart, which in a two-column block reads
   * as a broken table rather than as a label. A shared line box puts their
   * first baselines within a pixel of each other.
   */
  factLineHeight: 22,
  listIndent: 22,
  listItemGap: 8,
  /**
   * Word cannot measure a string, so the VML button's box is estimated from
   * the label: this many points per character plus the padding, clamped.
   */
  button: {
    height: 48,
    perChar: 10,
    padding: 64,
    minWidth: 180,
    maxWidth: 420,
  },
  buttonPadding: '14px 30px',
  /**
   * How many joiner-and-space pairs follow the preheader, so the client does
   * not print the letterhead after it in the inbox list.
   */
  preheaderPadRepeat: 60,
} as const;
