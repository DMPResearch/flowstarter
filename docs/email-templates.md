# Email templates

Every transactional email Flowstarter sends is rendered by one layout,
`apps/flowstarter-main/src/lib/email-templates/base.ts`. A template never
writes HTML. It describes an email as a list of blocks, and the base renders
both the HTML body and the plain-text alternative from that one description.

## Why it is built this way

The first real "Your site is live" a paying client received arrived as
unstyled paragraphs. The previous base wrote a modern stylesheet into a
`<style>` block and trusted mail clients to apply it; they do not. Outlook
renders through Word, Gmail strips most of the head, and the rest disagree
about everything else.

So the output is deliberately old technology: nested tables, inline styles on
every element, a fixed 600px shell, and by default no image at all.

Three things that used to be each template's problem are now the base's:

- **Escaping.** Every string a template passes is escaped when it is rendered,
  and every href is checked (only `http`, `https` and `mailto` survive). A
  template cannot forget.
- **The text part.** Generated from the same blocks as the HTML, so it cannot
  drift. A hand-written one is wrong within two edits.
- **Dark mode.** Each block carries the classes the dark media query overrides.
  A new block kind gets light, dark and text in one edit or it gets none.

## The design

Taken from the design system's rulings, not its CSS (see
`packages/flow-design-system/src/styles/brand.css`):

| | Light | Dark |
| --- | --- | --- |
| Page | `#fbf7ef` cream | `#040308` |
| Card | `#ffffff` | `#100e1c` |
| Ink | `#120a22` | `#f4eee4` |
| Muted ink | `#565073` | `#b4afac` |
| Accent (button, links) | `#2d40d2` | `#8e99eb`, button `#4e5fda` |

Every pair clears WCAG AA, asserted in `__tests__/base.test.ts` rather than
eyeballed. One accent, used once per email on the primary button. No
gradients, no second colour, no decorative images.

Type is a system stack. Onest is the product's face and no mail client has it;
a webfont would cost a request, leak a read and be ignored by Outlook anyway.

**The wordmark is HTML by default, not an image or inline SVG.** Gmail strips
`<svg>` and Outlook has never rendered it, which is most of the inboxes we
send to, so an SVG-first header would be a blank header for the majority. A
remote image is worse: an email is read by a client that owns none of the
origins we control, and this base once pointed the mark at
`https://flowstarter.net/email/flowstarter-mark.png` unconditionally, which
404s on any deployment that has not shipped `public/email/` yet and shows
Gmail's broken-image placeholder instead of a header. An email must never
depend on an asset the sending deployment cannot prove is reachable, so the
default mark is a table cell filled with the brand indigo and a bold white
"F", no network request involved. The word "Flowstarter" beside it is HTML
text either way, so a blocked-images inbox still shows the brand.

The PNG at `apps/flowstarter-main/public/email/flowstarter-mark.png` (built
from the SVG beside it by
`node apps/flowstarter-main/scripts/build-email-mark.mjs`) still exists for
whoever finishes deploying it. Setting
`EMAIL_ASSET_BASE_URL` switches the mark back to that image, served from
`<EMAIL_ASSET_BASE_URL>/email/`. Do not set it in any deployment until
`public/email/flowstarter-mark.png` is confirmed live at that base; the
variable is read as a promise the asset resolves, not checked against it.

The primary button is drawn twice: a VML `<v:roundrect>` for Word-rendered
Outlook and a padded anchor for everything else, only one of which is ever
visible. Both carry the same href, asserted in the tests.

## The blocks

```ts
renderEmail({
  subject: 'Your site is live',
  preheader: 'Lumina Dental is published at https://...',
  blocks: [
    { kind: 'heading', text: 'Your site is live' },
    { kind: 'paragraph', content: 'Hi Ana,' },
    { kind: 'paragraph', content: ['The balance of ', { strong: '€639.20' }, ' is invoiced.'] },
    { kind: 'hero', href: siteUrl },
    { kind: 'button', label: 'Open your site', href: siteUrl },
    { kind: 'callout', title: 'What happens next', content: '...' },
    { kind: 'quote', text: theirOwnWords },
    { kind: 'list', items: ['One ask per line.'] },
    { kind: 'facts', rows: [{ label: 'When', value: '...' }] },
    { kind: 'panel', rows: [{ label: 'Sign in with', value: email }] },
    { kind: 'note', content: 'Small print.' },
  ],
});
```

Paragraph and note content is either a string or a list of inline runs:
`{ strong }`, `{ mono }`, `{ link: { href, label? } }`.

## The templates

| Module | Export | Subject |
| --- | --- | --- |
| `client-notices.ts` | `previewReadyEmail` | Your preview is ready |
| `client-notices.ts` | `depositReceivedEmail` | Your deposit is in and your build has started |
| `client-notices.ts` | `briefIncompleteEmail` | We are waiting on a few things for your site |
| `client-notices.ts` | `balanceInvoiceEmail` | Your balance invoice is ready |
| `client-notices.ts` | `siteLiveEmail` | Your site is live |
| `client-notices.ts` | `buildNeedsReviewEmail` | Your build needs a second look |
| `client-notices.ts` | `newBookingEmail` | New booking on your site |
| `client-notices.ts` | `changeRequestLiveEmail` | Your change is live |
| `welcome.ts` | `welcomeEmail` | Welcome to Flowstarter |
| `invitation.ts` | `invitationEmail` | You're invited to join Flowstarter |
| `verification.ts` | `verificationEmail` | Verify your email for Flowstarter |
| `lead-notification.ts` | `leadNotificationEmail` | New enquiry from your site |
| `guest-deposit-welcome.ts` | `guestDepositWelcomeEmail` | Your Flowstarter account and your build / Your deposit is in and your build has started |

Two subjects changed with the rewrite. `Welcome to Flowstarter! 🎉` lost its
emoji and exclamation mark, which the house style bans everywhere else in the
directory. `New lead on <site>: <name>` became `New enquiry from your site`,
because the old one put a stranger's name in the client's inbox list, called
their customer a lead, and could not be matched by an inbox rule.

## Voice

Short, specific, warm. No hype, no em dashes, no emoji. One button per email.
A subject line that is true read alone in an inbox list. The tests enforce the
dashes, the emoji and the button count; the rest is review.

## How to add a template

1. Write the function in the module it belongs to. Return `renderEmail({...})`.
   Do not write HTML, do not escape anything, do not write a text version.
2. Export it from `index.ts`.
3. Add a fixture to
   `src/lib/email-templates/__tests__/preview-fixtures.ts` with the href its
   button must carry and the facts its text part must keep. That one entry puts
   it under the whole sweep in `templates.test.ts` (subject length, preheader,
   wordmark, one heading, one button, text facts, no em dashes or emoji,
   unsupported CSS, size) and into the preview harness.
4. If it needs a shape the blocks cannot draw, add a block kind to `base.ts`:
   HTML in `blockHtml`, text in `blockText`, dark classes on the new markup.

## How to preview

```bash
cd apps/flowstarter-main
node scripts/render-email-previews.mjs               # HTML + text to .email-previews/
node scripts/render-email-previews.mjs --screenshots # + Chrome shots to /tmp/fs-email/
```

`.email-previews/index.html` lists every template with its subject and size.
Screenshots are 640px wide at 2x, light and dark, using the installed Chrome
(`channel: 'chrome'`) because Playwright's own Chromium download stalls on this
machine.

The harness also runs the same CSS rules as the test suite (no flex, no grid,
no external fonts, no background images, no positioned elements, no custom
properties, no `rem`, every image absolute and with an `alt`) and exits
non-zero on a violation. There is no email-specific linter in this repo; these
rules are it.

## What cannot be checked here

Outlook's Word rendering engine does not exist on this machine, so the VML
button, the conditional comments and the table fallbacks are written to the
documented behaviour and verified by assertion, not by rendering. Litmus or a
real Outlook is the only way to close that.
