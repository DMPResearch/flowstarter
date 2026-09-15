# Email design

Every email the product sends is rendered by one module,
`src/lib/email-templates/base.ts`, from one set of values,
`src/lib/email-templates/design.ts`. A template describes its message as a list
of blocks; the module turns that list into the HTML part and the plain-text
part together. No template writes markup, no template writes a colour, and no
template writes its own text alternative.

This page is what to check before changing any of it, what the clients actually
do to it, and how to look at the result without sending yourself mail.

## The design, in one paragraph

A transactional message from this product is correspondence, not a screen, so
it is set as correspondence. A letterhead: the mark, the wordmark, and for
operator mail the queue it belongs to, over a hairline. A white card on the
near-neutral cream field, with the product's own concentric radii. Headings,
the standfirst and anything quoted back to the reader in a text serif; the body
in whatever humanist sans the reader's platform already has. Indigo appears as
the mark, the links and the one button, and nowhere as a fill or a wash. No
gradient, no second accent, and no image the layout depends on.

The one structural idea is the standfirst. An operator email exists because of
a single sentence, the rule-chosen reason the lead or the review is on the
board, and that sentence is set a step up from body in the display face with a
hairline under it. Everything below the hairline is detail. It is the
difference between an email that is triaged from the preview pane and one that
has to be read.

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
- [ ] At 390 the shell is fluid, the card padding has come in, and the
      letterhead's queue line has not collided with the wordmark.
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
