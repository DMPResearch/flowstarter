# Email design

Every email the product sends is rendered by one module,
`src/lib/email-templates/base.ts`, from one set of values,
`src/lib/email-templates/design.ts`. A template describes its message as a list
of blocks; the module turns that list into the HTML part and the plain-text
part together. No template writes markup, no template writes a colour, and no
template writes its own text alternative.

This page is what to check before changing any of it, what the clients actually
do to it, and how to look at the result without sending yourself mail.

## The reference this design answers to

Researched 2026-09-15. Where a number below is quoted from a source, the
source is named; where it is our own decision, it says so and says why. The
point of writing them down is that the next person to change a value can see
what it was weighed against.

The single most useful artifact is **Postmark's own transactional templates**
(`github.com/ActiveCampaign/postmark-templates`), because it is shipped code
rather than advice. Everything marked "Postmark" is read from that source.

### Width and the card

- 600px outer, and Postmark's content column is **570px** inside it. Email on
  Acid puts the practical ceiling at about 650px before Outlook and Yahoo
  start disagreeing. **Ours: 600px shell.**
- Postmark's card padding is **45px** on all four sides. **Ours: 40px top and
  sides, 32px bottom**, because 40 is on our four-pixel grid and 45 is not,
  and because the footer rule already closes the message.
- Mobile: Postmark collapses the fixed column at **600px** and, separately,
  takes the button full width at **500px**. Two breakpoints on purpose.
  **Ours: 620px for the shell, 500px for the button**, same reasoning.

### Type

- Litmus: minimum body size **14px**, "preferably larger", and anything below
  14px triggers iOS Mail's own text enlargement. Litmus's house preference is
  18px body; Postmark ships 16px.
- Litmus: line height **1.5 to 2 times** the size. Postmark ships
  `font-size: 16px; line-height: 1.625` on body copy, which is 26px.
- Litmus: **no more than two font styles** in one email.
- Postmark's scale: h1 22, h2 16, body 16, line items 15, fine print 13,
  muted table labels 12. Their largest text is 22px.
- **Ours**: 28 heading, 19 standfirst, 18 quote, 16 body, 15 facts, 14 note,
  13 footer, 12 labels, all with pixel line heights. The heading is larger
  than Postmark's because it is set in a display serif rather than a bold
  sans, and 12px appears only where Postmark puts it, on muted labels.
- Pixel line heights rather than ratios: Word does the arithmetic on a
  unitless value differently from every browser. This bit us once, when a
  12px label with `line-height: 16` got a 192px line box.

### Hierarchy and the summary

- Postmark's receipt, in order: wordmark, greeting, one-sentence
  confirmation, the card-statement fact, then the **labelled summary**, a
  two-column receipt-id and date pair followed by a Description/Amount table
  with 12px muted headers and a bold total, then the button, then fine print,
  then the footer. The summary is a labelled table, not prose.
- Postmark's password reset bolds the one fact that matters inline in the
  opening sentence ("**only valid for the next 24 hours**") rather than
  breaking it out.
- Postmark's comment notification has **no button at all**: the event, the
  attribution line, then two plain text links, because the action is
  optional. Really Good Emails reads Basecamp's notification the same way,
  "a notification that doesn't require any action from the user".
- **Ours**: the standfirst is the summary. Every email opens with one
  sentence in the display face over a hairline, which is what makes it
  triageable from a preview pane, and the `facts` block is the labelled
  table for the emails that have facts. The refund email keeps Postmark's
  no-button rule: the money is already sent and there is nothing to press.

### The action

- Postmark: `.body-action { margin: 30px auto; }`, so **30px of clear space
  above the button**, one button, after the explanation, never in the header.
- The bulletproof technique they ship is borders-as-padding (10px vertical,
  18px horizontal) because Outlook drops `padding` on an anchor but honours
  `border`. Email on Acid's variant uses real padding inside nested tables.
  Both are fine; **ours is the VML `roundrect` plus a padded anchor**, which
  keeps the radius Outlook would otherwise square off.
- Postmark repeats the **raw URL as plain text** under the button on password
  reset, for a client that strips the button. **We do not**, and the reason
  is that our button is drawn twice: a client that cannot render one gets the
  other, and the plain-text part carries every URL in full.
- Secondary actions are **links, not buttons** (Postmark's 13px `.sub`
  class). Ours are inline links in body copy after the button.
- **Ours**: 32px above and below the button, which is Postmark's 30 rounded
  onto our grid.

### Small print and the footer

- Postmark separates fine print from the message with a hairline and 25px
  either side (`.body-sub { margin-top: 25px; padding-top: 25px; border-top:
  1px solid }`). **Ours: the `note` block, hairline plus 24px.**
- A transactional footer in the wild is **sender identity and a postal
  address, centered, 13px, muted, and nothing else**. No unsubscribe, no
  social, no marketing links. Litmus's unsubscribe guidance is about
  marketing mail and does not apply here.
- **Ours**: sender name, a reply address, and one sentence saying why there
  is nothing to unsubscribe from. No postal address, because the product's
  own copy says only that Flowstarter operates from Romania and a footer must
  not invent a city.

### Dark mode

- The meta pair plus the `:root` declaration, then
  `@media (prefers-color-scheme: dark)` with `!important` throughout, because
  a client's own dark mode fights on specificity.
- **Apple Mail inverts by heuristic, and pure `#ffffff` and `#000000` are
  what trip it.** The documented dodge is near-white and near-black. This is
  why our card is `#fffffe` and our dark page is `#040308`.
- **Gmail and Outlook.com do not support `prefers-color-scheme` at all.**
  They invert on their own heuristics. Outlook.com tags what it changed:
  `data-ogsc` for a text colour, `data-ogsb` for a background, and the
  documented technique is to duplicate the dark rules keyed to those
  attributes. We emit all three from one list.
- Colours that break under automatic inversion: saturated brand colours can
  shift hue, and a dark logo on a transparent background disappears. Ours is
  a filled cell with a `bgcolor` attribute and white text, which survives.

### Typography stacks

- Litmus's web-safe list: Arial, Tahoma, Trebuchet MS, Verdana, Baskerville,
  Courier New, Georgia, Palatino, Times New Roman.
- Gmail's webfont support is limited to Roboto and Google Sans; everything
  else needs a real fallback.
- Postmark ships a webfont **and** an Outlook override in a conditional
  comment, forcing its font class to Arial, because Word ignores the stack.
  **We ship the same device in the other direction**: no webfont at all, and
  a conditional-comment rule pinning `.fs-display` to Georgia, so Word gets a
  serif rather than the first name it fails to find.
- Litmus on serif: serif and sans are both fine for body copy and are the
  most readable; display and script faces are for headlines only. Our display
  serif is a text serif, used at 18px and up.

Sources: [Postmark templates](https://github.com/ActiveCampaign/postmark-templates),
[Postmark transactional best practices](https://postmarkapp.com/guides/transactional-email-best-practices),
[Litmus typography](https://www.litmus.com/blog/email-typography-fonts),
[Litmus accessibility](https://www.litmus.com/blog/email-accessibility-for-designers-8-best-practices-you-should-follow),
[Litmus design best practices](https://www.litmus.com/blog/email-design-best-practices),
[Email on Acid bulletproof emails](https://www.emailonacid.com/blog/article/email-development/how-to-make-your-emails-bulletproof/),
[Really Good Emails, Stripe](https://reallygoodemails.com/emails/transactional-email-design-from-stripe).

Not verified this round: the pixel-level layout of Stripe's, Linear's,
Notion's and Vercel's own mail. Really Good Emails serves those as
screenshots, which a text fetch cannot read, so the receipt-summary pattern
above is cited from Postmark's shipped template rather than from Stripe's
rendering. If that detail ever matters, it needs a visual pass.

## The design, in one paragraph

A transactional message from this product is correspondence, not a screen, so
it is set as correspondence. A letterhead: the mark, the wordmark, and for
operator mail the queue it belongs to, over a hairline. A white card on the
near-neutral cream field, with the product's own concentric radii. Headings,
the standfirst and anything quoted back to the reader in a text serif; the body
in whatever humanist sans the reader's platform already has. Indigo appears as
the mark, the links and the one button, and nowhere as a fill or a wash. No
gradient, no second accent, and no image the layout depends on.

The one structural idea is the standfirst. Every email exists because of a
single sentence: the reason a lead is on the board, the fact that a deposit
went through, the address a site is now live at. That sentence is set a step
up from body in the display face with a hairline under it, and everything
below the hairline is detail. It is the difference between an email that is
triaged from the preview pane and one that has to be read.

The second idea is that the gaps are a rule, not a number. `gapBetween` in
`base.ts` decides how much air goes between two blocks from what the pair is:
tight after a greeting, which belongs to the sentence under it; one step for
paragraphs in a passage; a larger one around anything with edges; and a zone
on both sides of the button, the one place that has to read as a boundary.
Before this, every gap was the same eighteen pixels and the layout read as a
wall, because a heading, an aside and a call to action set equidistant are
telling the eye they are worth the same.

## Preview

```bash
cd apps/flowstarter-main

# HTML and text for all eighteen templates, to .email-previews/
node scripts/render-email-previews.mjs

# the same, plus PNGs at 600 and 390, light and dark
EMAIL_PREVIEW_SHOT_DIR=/tmp/email-design \
  node scripts/render-email-previews.mjs --screenshots
```

Open `.email-previews/index.html` for the list. Screenshots are named
`<template>.<width>.<scheme>.png`.

Two things about the harness. It bundles the shared fixtures with esbuild, so
what the browser shows is what the assertions run against, never a second copy.
And it deliberately leaves `EMAIL_ASSET_BASE_URL` unset, because the header
mark must preview as what actually ships, which is the HTML mark tile and not
the PNG. Export it yourself, pointed at a `file://` path under `public/`, only
when you are previewing the PNG variant on purpose.

Playwright's own Chromium download stalls on this machine. The harness launches
the installed Chrome (`chromium.launch({ channel: 'chrome' })`), the same way
the design gallery screenshots do.

## The checklist

Run this before any change to `base.ts`, `design.ts` or a template's blocks.
Most of it is already a test; the tests are named so you can see which.

### Structure

- [ ] The document is a full `<!DOCTYPE html>` page with `<meta charset>` and a
      `<title>`. (`base.test.ts`)
- [ ] 600px table shell, `width="600"` plus `max-width:600px`, everything
      `role="presentation"`. No flexbox, no grid. (`base.test.ts`,
      `lintEmailHtml`)
- [ ] Exactly one `<h1>`, and it is first. (`templates.test.ts`)
- [ ] At most one primary button, and both halves of it, the VML rectangle and
      the anchor, point at the same URL. (`templates.test.ts`)
- [ ] A preheader, non-empty, present in the HTML, padded with joiners so the
      client does not print the letterhead after it. (`templates.test.ts`)
- [ ] Under 100 KB. Gmail clips at about 102 KB and hides everything after the
      cut behind "view entire message", which in this layout is the button.
      (`templates.test.ts`)

### Colour and type

- [ ] Every colour in the rendered HTML is in `EMAIL_PALETTE`. Inline styles
      and `bgcolor` attributes both. (`templates.test.ts`)
- [ ] Every foreground clears WCAG AA against every surface it can land on, in
      both schemes. (`base.test.ts`)
- [ ] Sizes in pixels, never `rem`. Outlook ignores `rem` outright.
      (`lintEmailHtml`)
- [ ] Every `line-height` carries its unit. The scale is pixels, and a
      dropped `px` turns 16 into sixteen times the font size.
      (`lintEmailHtml`)
- [ ] Every element in the display face also carries `fs-display`, so the
      Outlook conditional rule can pin it to Georgia.
- [ ] The one `@font-face` has no `url()`. It resolves `local()` faces only, so
      it costs no request and leaks no read. (`lintEmailHtml`)
- [ ] The display stack still degrades through Charter, Bitstream Charter,
      Sitka Text, Cambria, Georgia. Any one of the five has to look like a
      choice, because Gmail will pick one of them for most readers.

### Both parts

- [ ] Every sentence in the HTML part is in the text part.
      (`templates.test.ts`, `says the same sentences in both parts`)
- [ ] The text part carries no markup. (`base.test.ts`)
- [ ] Operator mail's queue line is in the letterhead and in the first line of
      the text part. (`templates.test.ts`)
- [ ] No em dash, no en dash, no emoji, in the subject, the preheader, the HTML
      or the text. (`templates.test.ts`)

### Assets

- [ ] No `<img>` at all unless `EMAIL_ASSET_BASE_URL` is set, and then exactly
      one, with an `alt` and an absolute `src`. (`base.test.ts`,
      `lintEmailHtml`)
- [ ] No background image, no gradient, no `@import`, no script, no positioned
      element. (`lintEmailHtml`)
- [ ] The layout still makes sense with images off. It should, because there
      are none.

### By eye, in the previews

- [ ] 600 light, 600 dark, 390 light, 390 dark, for anything you changed.
- [ ] At 390 the shell is fluid, the card padding has come in, the button has
      gone full width, and the letterhead's queue line has not collided with
      the wordmark.
- [ ] The letterhead's rule and the footer's rule land on the same two
      verticals. A border on a padded cell spans the cell, not the content,
      so these drift apart the moment one of them is nested differently.
- [ ] Nothing outweighs the button. An aside directly above the one call to
      action is the thing most likely to, which is why the callout is a
      hanging rule rather than a filled panel.
- [ ] The facts block's labels and values share a baseline.
- [ ] A long value (an email address, a preview URL) wraps rather than widening
      the table.
- [ ] The button label is on one line.

## Client quirks this design is built around

**Word-rendered Outlook (2007 through current Windows desktop).** No
`border-radius`, no `padding` on an anchor, no `margin` on a table, no `rem`,
no `background-size`. The button is therefore drawn twice, a VML `roundrect`
inside `<!--[if mso]>` and a padded anchor inside `<!--[if !mso]>`, and only
one is ever visible. Word cannot measure a string, so the VML box's width is
estimated from the label length in `EMAIL_LAYOUT.button`. Space between blocks
is a spacer row, not a margin, for the same reason. `mso-table-lspace` and
`mso-table-rspace` are zeroed because Word adds its own.

**Gmail, web and app.** Strips most of `<head>`, which is why every element
carries its style inline and the `<style>` block holds only the things that
cannot be inlined: the media queries, the dark variant and the `@font-face`.
Expect the display face to fall back to Georgia or Cambria here; that is
planned for, not tolerated.

**Gmail on Android, dark mode.** Inverts a light message wholesale and honours
neither `prefers-color-scheme` nor the `color-scheme` meta. Nothing declared
can prevent it, so the defence is structural: a `bgcolor` attribute on every
filled cell, no text whose only contrast comes from an image, and no colour
pairing that stops working when its lightness is flipped. Check a change here
by eye with an inverted screenshot before assuming it is fine.

**Outlook.com and the Outlook mobile apps, dark mode.** Rewrite colours and
stamp `[data-ogsc]` or `[data-ogsb]` on the elements they touched. The dark
variant is therefore emitted three times from one list of rules in `base.ts`:
once inside `prefers-color-scheme: dark`, once behind `[data-ogsc]`, once
behind `[data-ogsb]`. Add a rule in one place and all three get it.

**Apple Mail and iOS Mail.** The best case. Honour the media query, the
`@font-face` and the radii. This is where the design looks like the previews.

**Blocked images, everywhere.** The default state for most first-time senders.
The letterhead mark is a filled table cell with a letter in it rather than a
PNG, and the wordmark is live text, so a blocked-images inbox still gets the
brand at the right colour. `EMAIL_ASSET_BASE_URL` swaps the mark for a PNG, and
must stay unset in any environment where that file is not confirmed live,
because a 404 renders as a broken image rather than as no image.

## Changing something

Add a block kind in `base.ts` rather than markup in a template: a kind gets an
HTML rendering, a text rendering and a dark variant in one edit, and a template
that writes its own markup gets none of the three.

Add a colour to `EMAIL_COLORS` in `design.ts` rather than to a style attribute.
The palette test walks the rendered HTML, so a literal fails on every template
at once, which is the intended amount of friction.

If a snapshot moves, read the diff before updating it. The text part is the
thing under snapshot, and a change there is a change to what a reader with a
plain-text client is told.
