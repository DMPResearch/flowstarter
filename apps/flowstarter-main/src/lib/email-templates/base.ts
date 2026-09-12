/**
 * The one layout every Flowstarter email is built from.
 *
 * The first real "Your site is live" that reached a paying client was a stack
 * of unstyled paragraphs, because the previous base wrote a modern stylesheet
 * into a `<style>` block and trusted mail clients to apply it. They do not.
 * Outlook renders through Word, Gmail strips most of the head, and every
 * client disagrees about the rest. So this file is deliberately old
 * technology: nested tables, inline styles on every element, a fixed 600px
 * shell, and one image.
 *
 * What the design system contributes is the palette and the restraint, not the
 * CSS. Cream page, white card, ink text, and indigo used exactly once per
 * email, on the button. No gradients, no second accent, no decorative images:
 * the same rulings that govern the product's surfaces, applied to the one
 * surface we cannot style twice.
 *
 * Templates never write HTML. They describe an email as a list of blocks and
 * this module renders both halves of it, the HTML and the plain-text
 * alternative, from the same description. That is the only way a text part
 * stays true: a hand-written one drifts from the HTML within two edits, and a
 * client whose reader shows text would then be reading last month's email.
 * Escaping happens here too, for the same reason, so no template can forget
 * it.
 */

/** Light and dark are the same design with different ink. Both pass AA. */
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
 * Onest is the product's face and no mail client has it. Asking for a webfont
 * would cost a network request, leak a read, and be ignored by Outlook
 * anyway, so the stack is the one every platform already has.
 */
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * Where the wordmark image is fetched from.
 *
 * Absolute and public by necessity: an email is read outside any origin we
 * control. The override exists for the preview harness, which renders the
 * same HTML from disk.
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
 * A root-relative path is allowed because one caller deliberately sends one:
 * when `NEXT_PUBLIC_SITE_URL` is unusable, the guest welcome would rather mail
 * an obviously broken `/login` than a working link to somebody else's host. A
 * protocol-relative `//host` is not a path, it is that other host, so it is
 * rejected.
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
        return `<strong style="font-weight:600;">${escapeHtml(
          node.strong
        )}</strong>`;
      }
      if ('mono' in node) {
        return `<span style="font-family:${MONO_STACK};font-size:14px;">${escapeHtml(
          node.mono
        )}</span>`;
      }
      const label = node.link.label ?? node.link.href;
      return `<a class="fs-link" href="${safeHref(
        node.link.href
      )}" style="color:${
        EMAIL_COLORS.light.accent
      };text-decoration:underline;">${escapeHtml(label)}</a>`;
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

const P_STYLE = `margin:0 0 18px;font-size:16px;line-height:1.6;color:${EMAIL_COLORS.light.ink};`;
const NOTE_STYLE = `margin:0 0 18px;font-size:14px;line-height:1.6;color:${EMAIL_COLORS.light.inkDim};`;

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
  const width = Math.min(420, Math.max(180, label.length * 10 + 64));
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px;">
  <tr><td align="left">
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:${width}px;" arcsize="20%" stroke="f" fillcolor="${EMAIL_COLORS.light.accent}">
      <w:anchorlock/>
      <center style="color:${EMAIL_COLORS.light.accentInk};font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${safeLabel}</center>
    </v:roundrect>
    <![endif]-->
    <!--[if !mso]><!-->
    <a class="fs-button" href="${url}" style="display:inline-block;padding:14px 30px;background-color:${EMAIL_COLORS.light.accent};color:${EMAIL_COLORS.light.accentInk};font-size:16px;font-weight:600;line-height:20px;text-decoration:none;border-radius:10px;font-family:${FONT_STACK};">${safeLabel}</a>
    <!--<![endif]-->
  </td></tr>
</table>`;
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return `<h1 class="fs-ink" style="margin:0 0 18px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:${
        EMAIL_COLORS.light.ink
      };">${escapeHtml(block.text)}</h1>`;
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
      return `<p style="margin:0 0 18px;font-size:19px;line-height:1.4;font-weight:600;word-break:break-all;"><a class="fs-link" href="${safeHref(
        block.href
      )}" style="color:${
        EMAIL_COLORS.light.accent
      };text-decoration:none;">${escapeHtml(label)}</a></p>`;
    }
    case 'quote':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;"><tr><td class="fs-quote" style="border-left:3px solid ${
        EMAIL_COLORS.light.quoteRule
      };padding:2px 0 2px 16px;"><p class="fs-ink" style="margin:0;font-size:16px;line-height:1.6;color:${
        EMAIL_COLORS.light.ink
      };">${escapeHtml(block.text)}</p></td></tr></table>`;
    case 'list': {
      if (block.items.length === 0) return '';
      const items = block.items
        .map((item) => `<li style="margin:0 0 8px;">${escapeHtml(item)}</li>`)
        .join('');
      return `<ul class="fs-ink" style="margin:0 0 18px;padding-left:22px;font-size:16px;line-height:1.6;color:${EMAIL_COLORS.light.ink};">${items}</ul>`;
    }
    case 'facts': {
      const rows = block.rows
        .filter((row) => row.value.trim().length > 0)
        .map(
          (row) =>
            `<tr><td class="fs-dim" style="padding:0 12px 8px 0;font-size:14px;line-height:1.5;color:${
              EMAIL_COLORS.light.inkDim
            };vertical-align:top;white-space:nowrap;">${escapeHtml(
              row.label
            )}</td><td class="fs-ink" style="padding:0 0 8px;font-size:15px;line-height:1.5;color:${
              EMAIL_COLORS.light.ink
            };vertical-align:top;">${escapeHtml(row.value)}</td></tr>`
        )
        .join('');
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;">${rows}</table>`;
    }
    case 'panel': {
      const rows = block.rows
        .map(
          (row, index) =>
            `<p class="fs-dim" style="margin:${
              index === 0 ? '0' : '14px'
            } 0 2px;font-size:12px;line-height:1.4;letter-spacing:0.06em;text-transform:uppercase;color:${
              EMAIL_COLORS.light.inkDim
            };">${escapeHtml(
              row.label
            )}</p><p class="fs-ink" style="margin:0;font-family:${MONO_STACK};font-size:15px;line-height:1.5;font-weight:600;word-break:break-all;color:${
              EMAIL_COLORS.light.ink
            };">${escapeHtml(row.value)}</p>`
        )
        .join('');
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;"><tr><td class="fs-panel fs-rule" style="background-color:${EMAIL_COLORS.light.panel};border:1px solid ${EMAIL_COLORS.light.rule};border-radius:12px;padding:16px 18px;">${rows}</td></tr></table>`;
    }
    case 'callout':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;"><tr><td class="fs-panel fs-rule" style="background-color:${
        EMAIL_COLORS.light.panel
      };border:1px solid ${
        EMAIL_COLORS.light.rule
      };border-radius:12px;padding:16px 18px;"><p class="fs-ink" style="margin:0 0 6px;font-size:14px;font-weight:600;line-height:1.4;color:${
        EMAIL_COLORS.light.ink
      };">${escapeHtml(
        block.title
      )}</p><p class="fs-ink" style="margin:0;font-size:15px;line-height:1.6;color:${
        EMAIL_COLORS.light.ink
      };">${inlineHtml(block.content)}</p></td></tr></table>`;
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return block.text;
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
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr><td class="fs-pad" style="padding:24px 8px 0;">
    <p class="fs-dim" style="margin:0 0 6px;font-size:13px;line-height:1.6;color:${
      EMAIL_COLORS.light.inkDim
    };">${FOOTER_LOCATION} &nbsp;&middot;&nbsp; <a class="fs-link" href="mailto:${FOOTER_EMAIL}" style="color:${
    EMAIL_COLORS.light.accent
  };text-decoration:underline;">${FOOTER_EMAIL}</a></p>
    <p class="fs-dim" style="margin:0;font-size:13px;line-height:1.6;color:${
      EMAIL_COLORS.light.inkDim
    };">${escapeHtml(FOOTER_TRANSACTIONAL)}</p>
  </td></tr>
</table>`;
}

function footerText(): string {
  return `${FOOTER_LOCATION}\n${FOOTER_EMAIL}\n${FOOTER_TRANSACTIONAL}`;
}

/**
 * The wordmark, as a small image and live text rather than inline SVG.
 *
 * Gmail removes `<svg>` entirely and Outlook has never rendered it, which is
 * most of the inboxes we send to, so an SVG-first header would be a blank
 * header for the majority. The mark is a PNG at twice its display size, and
 * the word itself is text: if images are blocked, the brand is still legible
 * and still the right colour.
 */
function wordmarkHtml(): string {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
  <tr>
    <td style="padding:0 10px 0 0;vertical-align:middle;">
      <img src="${emailAssetBase()}/email/flowstarter-mark.png" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border:0;border-radius:10px;" />
    </td>
    <td style="vertical-align:middle;">
      <span class="fs-ink" style="font-family:${FONT_STACK};font-size:21px;font-weight:700;letter-spacing:-0.025em;color:${
    EMAIL_COLORS.light.ink
  };"><span class="fs-link" style="color:${
    EMAIL_COLORS.light.accent
  };">Flow</span>starter</span>
    </td>
  </tr>
</table>`;
}

/**
 * The inbox preview line.
 *
 * Padded with zero-width joiners so the client does not follow it with the
 * first words of the card, which in this layout would be the wordmark's alt
 * text and then the heading again.
 */
function preheaderHtml(preheader: string): string {
  return `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${
    EMAIL_COLORS.light.page
  };">${escapeHtml(preheader)}${'&#8204;&nbsp;'.repeat(60)}</div>`;
}

const DARK_CSS = `
@media (prefers-color-scheme: dark) {
  .fs-body { background-color: ${EMAIL_COLORS.dark.page} !important; }
  .fs-card { background-color: ${EMAIL_COLORS.dark.card} !important; border-color: ${EMAIL_COLORS.dark.rule} !important; }
  .fs-ink, .fs-ink h1, .fs-ink p { color: ${EMAIL_COLORS.dark.ink} !important; }
  .fs-dim { color: ${EMAIL_COLORS.dark.inkDim} !important; }
  .fs-link { color: ${EMAIL_COLORS.dark.accent} !important; }
  .fs-rule { border-color: ${EMAIL_COLORS.dark.rule} !important; }
  .fs-quote { border-color: ${EMAIL_COLORS.dark.quoteRule} !important; }
  .fs-panel { background-color: ${EMAIL_COLORS.dark.panel} !important; }
  .fs-button { background-color: ${EMAIL_COLORS.dark.button} !important; color: ${EMAIL_COLORS.dark.accentInk} !important; }
}`;

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
}): RenderedEmail {
  const body = input.blocks.map(blockHtml).join('\n');
  const text = [
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
body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
img { border: 0; line-height: 100%; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
@media only screen and (max-width: 620px) {
  .fs-shell { width: 100% !important; }
  .fs-pad { padding-left: 22px !important; padding-right: 22px !important; }
  .fs-card-pad { padding: 28px 22px 22px !important; }
}
${DARK_CSS}
</style>
</head>
<body class="fs-body" style="margin:0;padding:0;width:100%;background-color:${
    EMAIL_COLORS.light.page
  };font-family:${FONT_STACK};">
${preheaderHtml(input.preheader)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="fs-body" bgcolor="${
    EMAIL_COLORS.light.page
  }" style="background-color:${EMAIL_COLORS.light.page};">
  <tr>
    <td align="center" style="padding:32px 12px 40px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="fs-shell" style="width:600px;max-width:600px;font-family:${FONT_STACK};">
        <tr><td class="fs-pad" style="padding:0 8px;">${wordmarkHtml()}</td></tr>
        <tr>
          <td class="fs-card fs-card-pad" bgcolor="${
            EMAIL_COLORS.light.card
          }" style="background-color:${
    EMAIL_COLORS.light.card
  };border:1px solid ${
    EMAIL_COLORS.light.rule
  };border-radius:16px;padding:36px 36px 26px;">
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
