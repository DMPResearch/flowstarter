/**
 * The one layout every Flowstarter email is built from.
 *
 * The first real "Your site is live" that reached a paying client was a stack
 * of unstyled paragraphs, because the previous base wrote a modern stylesheet
 * into a `<style>` block and trusted mail clients to apply it. They do not.
 * Outlook renders through Word, Gmail strips most of the head, and every
 * client disagrees about the rest. So this file is deliberately old
 * technology: nested tables, inline styles on every element, a fixed 600px
 * shell, and by default no image at all. An email must never depend on an
 * asset the sending deployment cannot prove is reachable, so the header mark
 * is plain HTML unless `EMAIL_ASSET_BASE_URL` is explicitly set. See
 * `wordmarkHtml` below.
 *
 * What the design contributes is the palette, the type and the restraint, not
 * the CSS. Every colour, size and measurement comes from `./design`, so the
 * tests can read the same values the renderer does and fail on a literal
 * typed into a style attribute. Cream field, white card, ink text, indigo as
 * an accent rather than a wash. No gradients, no second accent, no
 * decorative images: the same rulings that govern the product's surfaces,
 * applied to the one surface we cannot style twice.
 *
 * The one thing that is not inherited from the product is the display face.
 * A transactional message is correspondence, so headings, the standfirst and
 * anything quoted back to the reader are set in a text serif and the body is
 * set in the platform's own humanist sans. The serif costs no request: see
 * `emailFontFace` in `./design` for why there is a single `@font-face` in
 * this system and why it fetches nothing.
 *
 * Templates never write HTML. They describe an email as a list of blocks and
 * this module renders both halves of it, the HTML and the plain-text
 * alternative, from the same description. That is the only way a text part
 * stays true: a hand-written one drifts from the HTML within two edits, and a
 * client whose reader shows text would then be reading last month's email.
 * Escaping happens here too, for the same reason, so no template can forget
 * it.
 */
import {
  EMAIL_COLORS,
  EMAIL_FONTS,
  EMAIL_LAYOUT,
  EMAIL_TYPE,
  emailFontFace,
} from './design';

export { EMAIL_COLORS, EMAIL_LAYOUT, EMAIL_TYPE, EMAIL_FONTS } from './design';

/** Short names, because every string below is built from these. */
const C = EMAIL_COLORS.light;
const T = EMAIL_TYPE;
const L = EMAIL_LAYOUT;

/**
 * Where the wordmark PNG would be fetched from, if anything asked for it.
 *
 * Absolute and public by necessity: an email is read outside any origin we
 * control. Only called when `EMAIL_ASSET_BASE_URL` is explicitly set (see
 * `wordmarkHtml` below); the default value here is never sent in an email,
 * because a default is a guess, and this one guessed wrong once already: the
 * first branded "Your site is live" pointed the mark at
 * `https://flowstarter.net/email/flowstarter-mark.png`, which 404s on any
 * deploy that has not shipped `public/email/` yet, and Gmail shows that as a
 * broken image, not a missing one. The override exists for the preview
 * harness, which renders the same HTML from disk and can point this at a
 * `file://` path where the PNG actually exists.
 */
export function emailAssetBase(): string {
  const raw = process.env.EMAIL_ASSET_BASE_URL?.trim();
  return (raw || 'https://flowstarter.net').replace(/\/+$/, '');
}

/** Keeps a client-supplied value out of the HTML as anything but text. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A link we are willing to put in an email.
 *
 * Anything that is not http, https, mailto or a root-relative path becomes
 * '#'. The hrefs in these templates come from Stripe, from our own deploys and
 * from a database column an operator can edit, and `javascript:` in a mail
 * client is somebody else's problem only until it is ours.
 *
 * A root-relative path is allowed on purpose: every caller here builds its
 * href from `publicAppOrigin()` (the one rule for where the app itself is
 * publicly served) rather than guessing a hostname of its own, so this stays
 * permissive for whichever caller passes a bare path someday rather than
 * quietly rewriting it into an absolute link this module would have to guess
 * the origin for. A protocol-relative `//host` is not a path, it is that
 * other host, so it is rejected.
 */
export function safeHref(href: string): string {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return escapeHtml(trimmed);
  if (/^\/(?!\/)/.test(trimmed)) return escapeHtml(trimmed);
  return '#';
}

/** Inline runs inside a paragraph. Everything is escaped when rendered. */
export type Inline =
  | string
  | { strong: string }
  | { mono: string }
  | { link: { href: string; label?: string } };

export type Block =
  /** The one h1. Every email has exactly one, first. */
  | { kind: 'heading'; text: string }
  /**
   * The standfirst: the single sentence that says why this email exists, set
   * in the display face above a hairline. One per email, directly under the
   * heading, and never used for a sentence that is merely next.
   */
  | { kind: 'lede'; content: Inline[] | string }
  | { kind: 'paragraph'; content: Inline[] | string }
  /** Small print: still readable, never the point. */
  | { kind: 'note'; content: Inline[] | string }
  /** The primary action. One per email, and the only indigo fill in it. */
  | { kind: 'button'; label: string; href: string }
  /** A URL that is itself the news, shown large and linked. */
  | { kind: 'hero'; href: string; label?: string }
  /** The client's own words, quoted back. */
  | { kind: 'quote'; text: string }
  /** A short list of asks or items. Renders nothing when empty. */
  | { kind: 'list'; items: string[] }
  /** Label and value pairs, for the emails that are mostly facts. */
  | { kind: 'facts'; rows: Array<{ label: string; value: string }> }
  /** A boxed value to be read and copied, such as a sign-in address. */
  | { kind: 'panel'; rows: Array<{ label: string; value: string }> }
  /** One short titled aside, for "what happens next". */
  | { kind: 'callout'; title: string; content: Inline[] | string };

export interface RenderedEmail {
  subject: string;
  /** The line inboxes show after the subject. Never empty. */
  preheader: string;
  html: string;
  /** The text/plain alternative, generated from the same blocks. */
  text: string;
}

function inlines(content: Inline[] | string): Inline[] {
  return typeof content === 'string' ? [content] : content;
}

function inlineHtml(content: Inline[] | string): string {
  return inlines(content)
    .map((node) => {
      if (typeof node === 'string') return escapeHtml(node);
      if ('strong' in node) {
        return `<strong style="font-weight:${T.micro.weight};">${escapeHtml(
          node.strong
        )}</strong>`;
      }
      if ('mono' in node) {
        return `<span style="font-family:${EMAIL_FONTS.mono};font-size:${
          T.note.size
        }px;">${escapeHtml(node.mono)}</span>`;
      }
      const label = node.link.label ?? node.link.href;
      return `<a class="fs-link" href="${safeHref(
        node.link.href
      )}" style="color:${C.accent};text-decoration:underline;">${escapeHtml(
        label
      )}</a>`;
    })
    .join('');
}

function inlineText(content: Inline[] | string): string {
  return inlines(content)
    .map((node) => {
      if (typeof node === 'string') return node;
      if ('strong' in node) return node.strong;
      if ('mono' in node) return node.mono;
      const label = node.link.label;
      return label && label !== node.link.href
        ? `${label}: ${node.link.href}`
        : node.link.href;
    })
    .join('');
}

/** Collapses the whitespace a template's source indentation introduces. */
function tidy(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * A block that needs a table (a fill, a border or a column) plus the space
 * under it.
 *
 * The space is a spacer row rather than a margin because Word-rendered
 * Outlook drops margins on tables, and a stack of blocks with no space
 * between them is the failure mode that is invisible in every other client.
 */
function blockTable(cell: string, gap: number = L.blockGap): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
  <tr>${cell}</tr>
  <tr><td style="height:${gap}px;line-height:${gap}px;font-size:1px;">&nbsp;</td></tr>
</table>`;
}

const DISPLAY = `font-family:${EMAIL_FONTS.display};`;
const BODY_FACE = `font-family:${EMAIL_FONTS.body};`;
const P_STYLE = `margin:0 0 ${L.blockGap}px;${BODY_FACE}font-size:${T.body.size}px;line-height:${T.body.leading};color:${C.ink};`;
const NOTE_STYLE = `margin:0 0 ${L.blockGap}px;${BODY_FACE}font-size:${T.note.size}px;line-height:${T.note.leading};color:${C.inkDim};`;
/** The letterhead's queue line and every label above a value. */
const MICRO_STYLE = `${BODY_FACE}font-size:${T.micro.size}px;line-height:${T.micro.leading};font-weight:${T.micro.weight};letter-spacing:${T.micro.tracking};text-transform:uppercase;color:${C.inkDim};`;

/**
 * Outlook ignores padding and border-radius on a link, so the button is drawn
 * twice: a VML rounded rectangle for Word-rendered Outlook, and a padded
 * anchor for everything else. Only one of the two is ever visible.
 */
function buttonHtml(label: string, href: string): string {
  const url = safeHref(href);
  const safeLabel = escapeHtml(label);
  // Word needs the box in points before it can centre the text in it, and it
  // cannot measure a string, so the width is estimated from the label.
  const width = Math.min(
    L.button.maxWidth,
    Math.max(
      L.button.minWidth,
      label.length * L.button.perChar + L.button.padding
    )
  );
  const cell = `<td align="left" style="padding:${L.buttonGap.top}px 0 0;">
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:${L.button.height}px;v-text-anchor:middle;width:${width}px;" arcsize="20%" stroke="f" fillcolor="${C.accent}">
      <w:anchorlock/>
      <center style="color:${C.accentInk};font-family:Arial,sans-serif;font-size:${T.button.size}px;font-weight:bold;">${safeLabel}</center>
    </v:roundrect>
    <![endif]-->
    <!--[if !mso]><!-->
    <a class="fs-button" href="${url}" style="display:inline-block;padding:${L.buttonPadding};background-color:${C.accent};color:${C.accentInk};font-size:${T.button.size}px;font-weight:${T.button.weight};line-height:${T.button.leading}px;text-decoration:none;border-radius:${L.radius.button}px;${BODY_FACE}">${safeLabel}</a>
    <!--<![endif]-->
  </td>`;
  return blockTable(cell, L.buttonGap.bottom);
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return `<h1 class="fs-ink" style="margin:0 0 ${
        L.blockGap
      }px;${DISPLAY}font-size:${T.heading.size}px;line-height:${
        T.heading.leading
      };font-weight:${T.heading.weight};letter-spacing:${
        T.heading.tracking
      };color:${C.ink};">${escapeHtml(block.text)}</h1>`;
    case 'lede': {
      // The one sentence an operator reads before deciding whether to open
      // anything, set apart the way a standfirst is: the display face, a step
      // up from body, and a hairline under it that ends the summary and
      // starts the detail.
      const cell = `<td class="fs-rule" style="padding:0 0 ${
        L.ledeGap
      }px;border-bottom:${L.hairline}px solid ${
        C.rule
      };"><p class="fs-ink" style="margin:0;${DISPLAY}font-size:${
        T.lede.size
      }px;line-height:${T.lede.leading};font-weight:${T.lede.weight};color:${
        C.ink
      };">${inlineHtml(block.content)}</p></td>`;
      return blockTable(cell, L.ledeGap);
    }
    case 'paragraph':
      return `<p class="fs-ink" style="${P_STYLE}">${inlineHtml(
        block.content
      )}</p>`;
    case 'note':
      return `<p class="fs-dim" style="${NOTE_STYLE}">${inlineHtml(
        block.content
      )}</p>`;
    case 'button':
      return buttonHtml(block.label, block.href);
    case 'hero': {
      const label = block.label ?? block.href;
      return `<p style="margin:0 0 ${L.blockGap}px;${BODY_FACE}font-size:${
        T.hero.size
      }px;line-height:${T.hero.leading};font-weight:${
        T.hero.weight
      };word-break:break-all;"><a class="fs-link" href="${safeHref(
        block.href
      )}" style="color:${C.accent};text-decoration:none;">${escapeHtml(
        label
      )}</a></p>`;
    }
    case 'quote': {
      // Their words, not ours: the display face on the panel tone, behind a
      // rule. It reads as a thing lifted from somewhere else, which is what
      // it is, without needing a quotation mark we would then have to escape.
      const cell = `<td class="fs-quote fs-panel" style="background-color:${
        C.panel
      };border-left:${L.quoteRuleWidth}px solid ${
        C.quoteRule
      };border-radius:0 ${L.radius.panel}px ${L.radius.panel}px 0;padding:${
        L.quotePadding
      };"><p class="fs-ink" style="margin:0;${DISPLAY}font-size:${
        T.quote.size
      }px;line-height:${T.quote.leading};color:${C.ink};">${escapeHtml(
        block.text
      )}</p></td>`;
      return blockTable(cell);
    }
    case 'list': {
      if (block.items.length === 0) return '';
      const items = block.items
        .map(
          (item) =>
            `<li style="margin:0 0 ${L.listItemGap}px;">${escapeHtml(
              item
            )}</li>`
        )
        .join('');
      return `<ul class="fs-ink" style="margin:0 0 ${L.blockGap}px;padding-left:${L.listIndent}px;${BODY_FACE}font-size:${T.body.size}px;line-height:${T.body.leading};color:${C.ink};">${items}</ul>`;
    }
    case 'facts': {
      // A label column and a value column under one hairline, the way a
      // delivery note sets them. The label is the micro style the panel uses,
      // so the two blocks read as the same family of object.
      const rows = block.rows
        .filter((row) => row.value.trim().length > 0)
        .map(
          (row) =>
            `<tr><td class="fs-dim" style="padding:0 12px ${
              L.factRowGap
            }px 0;${MICRO_STYLE}line-height:${
              L.factLineHeight
            }px;vertical-align:top;width:${L.factLabelWidth}px;">${escapeHtml(
              row.label
            )}</td><td class="fs-ink" style="padding:0 0 ${
              L.factRowGap
            }px;${BODY_FACE}font-size:${T.fact.size}px;line-height:${
              L.factLineHeight
            }px;color:${
              C.ink
            };vertical-align:top;word-break:break-word;">${escapeHtml(
              row.value
            )}</td></tr>`
        )
        .join('');
      if (!rows) return '';
      const cell = `<td class="fs-rule" style="padding:${L.factRowGap}px 0 0;border-top:${L.hairline}px solid ${C.rule};"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">${rows}</table></td>`;
      return blockTable(cell);
    }
    case 'panel': {
      const rows = block.rows
        .map(
          (row, index) =>
            `<p class="fs-dim" style="margin:${
              index === 0 ? '0' : '14px'
            } 0 3px;${MICRO_STYLE}">${escapeHtml(
              row.label
            )}</p><p class="fs-ink" style="margin:0;font-family:${
              EMAIL_FONTS.mono
            };font-size:${T.fact.size}px;line-height:${
              T.fact.leading
            };font-weight:${T.micro.weight};word-break:break-all;color:${
              C.ink
            };">${escapeHtml(row.value)}</p>`
        )
        .join('');
      const cell = `<td class="fs-panel fs-rule" style="background-color:${C.panel};border:${L.hairline}px solid ${C.rule};border-radius:${L.radius.panel}px;padding:${L.panelPadding};">${rows}</td>`;
      return blockTable(cell, L.ledeGap);
    }
    case 'callout': {
      const cell = `<td class="fs-panel fs-rule" style="background-color:${
        C.panel
      };border:${L.hairline}px solid ${C.rule};border-radius:${
        L.radius.panel
      }px;padding:${
        L.panelPadding
      };"><p class="fs-ink" style="margin:0 0 6px;${DISPLAY}font-size:${
        T.note.size + 3
      }px;font-weight:${T.button.weight};line-height:${T.micro.leading};color:${
        C.ink
      };">${escapeHtml(
        block.title
      )}</p><p class="fs-ink" style="margin:0;${BODY_FACE}font-size:${
        T.fact.size
      }px;line-height:${T.body.leading};color:${C.ink};">${inlineHtml(
        block.content
      )}</p></td>`;
      return blockTable(cell);
    }
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return block.text;
    case 'lede':
    case 'paragraph':
    case 'note':
      return tidy(inlineText(block.content));
    case 'button':
      return `${block.label}: ${block.href}`;
    case 'hero':
      return block.label && block.label !== block.href
        ? `${block.label}: ${block.href}`
        : block.href;
    case 'quote':
      return block.text
        .split('\n')
        .map((line) => `  ${line.trim()}`)
        .join('\n');
    case 'list':
      return block.items.map((item) => `- ${item}`).join('\n');
    case 'facts':
      return block.rows
        .filter((row) => row.value.trim().length > 0)
        .map((row) => `${row.label}: ${row.value}`)
        .join('\n');
    case 'panel':
      return block.rows.map((row) => `${row.label}: ${row.value}`).join('\n');
    case 'callout':
      return `${block.title} ${tidy(inlineText(block.content))}`;
  }
}

/**
 * The sender identity and the reason this is not marketing.
 *
 * No physical address: the product's own copy states only that Flowstarter
 * operates from Romania, and a footer must not invent a city. Transactional
 * mail needs no postal line. There is no unsubscribe link because every
 * template in this system is transactional: a client who opted out of "your
 * site is live" would be opting out of the product.
 */
const FOOTER_LOCATION = 'Flowstarter';
const FOOTER_TRANSACTIONAL =
  'This is a service message about your project, not marketing, so there is ' +
  'nothing to unsubscribe from. Reply to this email and a person will read it.';
const FOOTER_EMAIL = 'hello@flowstarter.net';

function footerHtml(): string {
  const footerStyle = `margin:0;${BODY_FACE}font-size:${T.footer.size}px;line-height:${T.footer.leading};color:${C.inkDim};`;
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
  <tr><td class="fs-pad" style="padding:${L.footerGap}px ${L.gutter}px 0;">
    <p class="fs-dim" style="${footerStyle}margin-bottom:6px;">${FOOTER_LOCATION} &nbsp;&middot;&nbsp; <a class="fs-link" href="mailto:${FOOTER_EMAIL}" style="color:${
    C.accent
  };text-decoration:underline;">${FOOTER_EMAIL}</a></p>
    <p class="fs-dim" style="${footerStyle}">${escapeHtml(
    FOOTER_TRANSACTIONAL
  )}</p>
  </td></tr>
</table>`;
}

function footerText(): string {
  return `${FOOTER_LOCATION}\n${FOOTER_EMAIL}\n${FOOTER_TRANSACTIONAL}`;
}

/**
 * The mark tile beside the wordmark.
 *
 * Plain table-and-inline-style HTML by default: a table cell filled with the
 * brand indigo, rounded where the client honours `border-radius` and square
 * where it does not, holding a bold white "F". No client can fail to fetch a
 * cell it already has to render.
 *
 * `EMAIL_ASSET_BASE_URL` can swap this for the PNG at
 * `public/email/flowstarter-mark.png` (built by
 * `scripts/build-email-mark.mjs`), but only when the caller sets it
 * explicitly, which is a promise, not a check: setting the variable in a
 * deployment where that file is not actually served at that base recreates
 * the exact 404 this function exists to avoid. The variable must stay unset
 * in every environment until the asset is confirmed live there.
 */
function markHtml(): string {
  const assetBaseConfigured = Boolean(process.env.EMAIL_ASSET_BASE_URL?.trim());
  const size = L.mark.size;
  if (assetBaseConfigured) {
    return `<img src="${emailAssetBase()}/email/flowstarter-mark.png" width="${size}" height="${size}" alt="" style="display:block;width:${size}px;height:${size}px;border:0;border-radius:${
      L.radius.mark
    }px;" />`;
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${size}" height="${size}" style="width:${size}px;height:${size}px;">
        <tr>
          <td class="fs-mark" width="${size}" height="${size}" align="center" valign="middle" bgcolor="${C.accent}" style="width:${size}px;height:${size}px;background-color:${C.accent};border-radius:${L.radius.mark}px;${BODY_FACE}font-size:17px;font-weight:${T.wordmark.weight};line-height:${size}px;color:${C.accentInk};text-align:center;">F</td>
        </tr>
      </table>`;
}

/**
 * The letterhead: the mark tile, the wordmark, an optional queue line on the
 * right, and a rule under all three.
 *
 * It is a letterhead rather than a logo because these messages are
 * correspondence. The queue line is the one piece of routing an operator
 * cannot get from the card below without reading it, and it is the reason
 * the whole row is worth the space: two of these emails land in the same
 * inbox from the same address, and "Custom work" against "Policy review" in
 * the top right says which one this is before the eye reaches the heading.
 * Client emails pass no label and get the wordmark alone.
 *
 * Never inline SVG. Gmail removes `<svg>` entirely and Outlook has never
 * rendered it, which is most of the inboxes we send to, so an SVG-first
 * header would be a blank header for the majority. The word itself is text:
 * if images are blocked, the brand is still legible and still the right
 * colour.
 */
function letterheadHtml(label?: string): string {
  const columns = label ? 3 : 2;
  const queue = label
    ? `<td class="fs-dim" align="right" style="vertical-align:middle;${MICRO_STYLE}">${escapeHtml(
        label
      )}</td>`
    : '';
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
  <tr>
    <td style="padding:0 ${L.mark.gap}px 0 0;vertical-align:middle;width:${
    L.mark.size
  }px;">${markHtml()}</td>
    <td style="vertical-align:middle;">
      <span class="fs-ink" style="${BODY_FACE}font-size:${
    T.wordmark.size
  }px;font-weight:${T.wordmark.weight};letter-spacing:${
    T.wordmark.tracking
  };color:${C.ink};"><span class="fs-link" style="color:${
    C.accent
  };">Flow</span>starter</span>
    </td>${queue}
  </tr>
  <tr><td colspan="${columns}" class="fs-rule" style="height:${
    L.letterheadPadding
  }px;line-height:${L.letterheadPadding}px;font-size:1px;border-bottom:${
    L.hairline
  }px solid ${C.rule};">&nbsp;</td></tr>
  <tr><td colspan="${columns}" style="height:${L.letterheadGap}px;line-height:${
    L.letterheadGap
  }px;font-size:1px;">&nbsp;</td></tr>
</table>`;
}

/**
 * The inbox preview line.
 *
 * Padded with zero-width joiners so the client does not follow it with the
 * first words of the card, which in this layout would be the letterhead and
 * then the heading again.
 */
function preheaderHtml(preheader: string): string {
  return `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${
    C.page
  };">${escapeHtml(preheader)}${'&#8204;&nbsp;'.repeat(
    L.preheaderPadRepeat
  )}</div>`;
}

const D = EMAIL_COLORS.dark;

/**
 * The dark variant, written once and emitted twice.
 *
 * Once inside `prefers-color-scheme: dark`, which Apple Mail, iOS Mail and
 * Outlook for Mac honour. Once more behind `[data-ogsc]` and `[data-ogsb]`,
 * the attributes Outlook.com and the Outlook mobile apps stamp onto elements
 * whose colours their own dark mode has rewritten: without these the
 * rewrite wins and the ink lands somewhere we never measured.
 *
 * Gmail's Android app is the one client neither form reaches. It inverts a
 * light message wholesale and ignores both the media query and the meta, so
 * the defence there is structural rather than declared: a `bgcolor`
 * attribute on every filled cell, no text whose only contrast comes from a
 * background image, and no colour pairing that stops working when its
 * lightness is flipped. See `docs/operations/email-design.md`.
 */
const DARK_RULES = [
  ['.fs-body', `background-color: ${D.page} !important;`],
  [
    '.fs-card',
    `background-color: ${D.card} !important; border-color: ${D.rule} !important;`,
  ],
  ['.fs-ink, .fs-ink h1, .fs-ink p', `color: ${D.ink} !important;`],
  ['.fs-dim', `color: ${D.inkDim} !important;`],
  ['.fs-link', `color: ${D.accent} !important;`],
  ['.fs-rule', `border-color: ${D.rule} !important;`],
  ['.fs-quote', `border-left-color: ${D.quoteRule} !important;`],
  ['.fs-panel', `background-color: ${D.panel} !important;`],
  ['.fs-mark', `background-color: ${D.button} !important;`],
  [
    '.fs-button',
    `background-color: ${D.button} !important; color: ${D.accentInk} !important;`,
  ],
] as const;

function darkCss(): string {
  const block = (prefix: string) =>
    DARK_RULES.map(
      ([selector, body]) =>
        `  ${selector
          .split(', ')
          .map((one) => `${prefix}${one}`)
          .join(', ')} { ${body} }`
    ).join('\n');
  return `@media (prefers-color-scheme: dark) {
${block('')}
}
${block('[data-ogsc] ')}
${block('[data-ogsb] ')}`;
}

/**
 * Renders one email into its two bodies.
 *
 * The blocks are the whole contract: a template that wants something this
 * function cannot draw adds a block kind here, where it gets an HTML
 * rendering, a text rendering and dark mode in one edit, instead of writing
 * markup that has none of the three.
 */
export function renderEmail(input: {
  subject: string;
  preheader: string;
  blocks: Block[];
  /**
   * The queue this message belongs to, shown in the letterhead and carried
   * as the first line of the text part so the two halves still say the same
   * thing. Operator mail only: a client has one queue and does not need it
   * named.
   */
  masthead?: string;
}): RenderedEmail {
  const body = input.blocks.map(blockHtml).join('\n');
  const text = [
    ...(input.masthead ? [`${FOOTER_LOCATION} / ${input.masthead}`] : []),
    ...input.blocks.map(blockText).filter((part) => part.trim().length > 0),
    // The signature separator every mail reader has understood since 1985.
    '--',
    footerText(),
  ].join('\n\n');

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escapeHtml(input.subject)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
${emailFontFace()}
body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
img { border: 0; line-height: 100%; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
@media only screen and (max-width: ${L.mobileBreakpoint}px) {
  .fs-shell { width: 100% !important; }
  .fs-pad { padding-left: ${L.gutterMobile}px !important; padding-right: ${
    L.gutterMobile
  }px !important; }
  .fs-card-pad { padding: ${L.cardPaddingMobile} !important; }
}
${darkCss()}
</style>
</head>
<body class="fs-body" style="margin:0;padding:0;width:100%;background-color:${
    C.page
  };${BODY_FACE}">
${preheaderHtml(input.preheader)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="fs-body" bgcolor="${
    C.page
  }" style="background-color:${C.page};">
  <tr>
    <td align="center" style="padding:${L.pagePadding};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${
        L.shellWidth
      }" class="fs-shell" style="width:${L.shellWidth}px;max-width:${
    L.shellWidth
  }px;${BODY_FACE}">
        <tr><td class="fs-pad" style="padding:0 ${
          L.gutter
        }px;">${letterheadHtml(input.masthead)}</td></tr>
        <tr>
          <td class="fs-card fs-card-pad" bgcolor="${
            C.card
          }" style="background-color:${C.card};border:${L.hairline}px solid ${
    C.rule
  };border-radius:${L.radius.card}px;padding:${L.cardPadding};">
${body}
          </td>
        </tr>
        <tr><td>${footerHtml()}</td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;

  return {
    subject: input.subject,
    preheader: input.preheader,
    html,
    text,
  };
}
