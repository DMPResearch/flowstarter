/**
 * Deterministic integration injection — no LLM involved, no template file
 * left "unfinished" for the client. Mirrors docs/INTEGRATIONS-PLAN.md's
 * `injectIntegrations(files, projectConfig)` step: pure string manipulation
 * over the generated Astro file tree, run as post-processing after content
 * personalization and before (or independent of) `astro build`.
 *
 * Every base template under apps/flowstarter-templates ships a `book.astro`
 * (or, for wellness-therapy, a booking panel on that page) with either:
 *   - a `<div class="book-page__calendar">` containing a placeholder
 *     Calendly iframe and the comment "Replace the src below with your
 *     Calendly or Cal.com embed URL", or
 *   - no calendar embed at all (a "connect your Calendly or Cal.com link
 *     here" note pointing at a mailto CTA instead).
 *
 * Preview vs full site:
 *   - `injectCalComPreviewDemo` — funnel/preview only: a blurred static
 *     calendar mock. Never loads cal.com. Marker: data-flowstarter-cal-preview.
 *   - `injectCalCom` — full site and every client rebuild: the live Cal.com
 *     embed when a validated link exists, and outright removal
 *     (`removeCalComPreviewDemo`) when it does not. Either way the blurred
 *     demo never reaches a build the client is paying (or has paid) for —
 *     see `packages/agentic-codegen/src/flowstarter/cal-preview-rule.ts` for
 *     the gate that gives that rule teeth on the compiled output.
 */

/** A template's file tree: relative path (posix, no leading slash) → content. */
export type FileMap = Record<string, string>;

/**
 * A `<div>` block located by scanning, from its `<` to the `>` of the first
 * `</div>` after it.
 *
 * No regex does this any more. Every pattern that tried ended up quadratic on
 * a page whose `</div>` is missing, because the engine has to start again
 * from the next offset each time it runs off the end, and these read
 * model-written and already-built HTML where a missing close is normal.
 */
interface HtmlBlock {
  /** Index of the block's opening `<`. */
  start: number;
  /** Index just past the block's `</div>`. */
  end: number;
  /** The block itself, opening tag through `</div>`. */
  text: string;
}

/** `\w`, for the word boundary in front of a marker attribute. */
function isWordCharacter(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= 'a' && char <= 'z') ||
      (char >= 'A' && char <= 'Z') ||
      (char >= '0' && char <= '9') ||
      char === '_')
  );
}

/**
 * Everything from `openStart` to the `</div>` that actually closes it, or
 * null when there is none.
 *
 * Counts nesting depth rather than stopping at the first `</div>`: the
 * template placeholder and the managed live-embed block never nest a `<div>`
 * inside themselves, but the rendered preview-demo block does (its calendar
 * grid and its overlay caption are both `<div>`s of their own), and a scan
 * that stopped early there would slice the block off in the middle, leaving
 * the tail — half the old markup, none of the marker that named it — sitting
 * in the page next to whatever replaced the front half.
 */
function closeBlockAt(
  html: string,
  openStart: number,
  openEnd: number,
): HtmlBlock | null {
  let depth = 1;
  let cursor = openEnd;
  while (depth > 0) {
    const close = html.indexOf('</div>', cursor);
    if (close === -1) return null;
    const open = html.indexOf('<div', cursor);
    // `<div\b`, same rule as `findMarkedDiv`: `<divider` does not nest.
    if (open !== -1 && open < close && !isWordCharacter(html[open + 4])) {
      depth += 1;
      cursor = open + 4;
    } else {
      depth -= 1;
      cursor = close + 6;
    }
  }
  return { start: openStart, end: cursor, text: html.slice(openStart, cursor) };
}

/**
 * The first `<div …>` whose attributes carry `marker`, with its block.
 *
 * The marker has to sit on an attribute boundary (the character in front of
 * it is not a word character) and inside the tag, which is why the search
 * stops at the tag's own `>`.
 */
function findMarkedDiv(html: string, marker: string): HtmlBlock | null {
  for (
    let at = html.indexOf('<div');
    at !== -1;
    at = html.indexOf('<div', at + 1)
  ) {
    // `<div\b`: `<divider` is a different element.
    if (isWordCharacter(html[at + 4])) continue;
    const tagEnd = html.indexOf('>', at + 4);
    if (tagEnd === -1) continue;
    // Any occurrence inside the tag will do, not just the first: the pattern
    // could walk past one that failed the boundary (`xdata-…`) to a later one.
    for (
      let marked = html.indexOf(marker, at + 4);
      marked !== -1 && marked < tagEnd;
      marked = html.indexOf(marker, marked + 1)
    ) {
      if (isWordCharacter(html[marked - 1])) continue;
      const block = closeBlockAt(html, at, tagEnd + 1);
      if (block) return block;
      break;
    }
  }
  return null;
}

/** The first `<div class="book-page__calendar">` block. The opening tag is literal. */
function findPlaceholderCalendar(html: string): HtmlBlock | null {
  const OPEN = '<div class="book-page__calendar">';
  for (
    let at = html.indexOf(OPEN);
    at !== -1;
    at = html.indexOf(OPEN, at + 1)
  ) {
    const block = closeBlockAt(html, at, at + OPEN.length);
    if (block) return block;
  }
  return null;
}

const findManagedBlock = (html: string) =>
  findMarkedDiv(html, 'data-flowstarter-cal-embed="true"');
const findPreviewDemoBlock = (html: string) =>
  findMarkedDiv(html, 'data-flowstarter-cal-preview="true"');

/** Replaces `block.text` with `replacement`, taking the string literally. */
function spliceBlock(
  html: string,
  block: HtmlBlock,
  replacement: string,
): string {
  return html.slice(0, block.start) + replacement + html.slice(block.end);
}

/**
 * Files the injector will consider, in preference order — first hit wins.
 *
 * The `.astro` sources come first: injecting before `astro build` is how a
 * real full-site build gets its calendar, and the built HTML then carries it
 * for free. The `dist`-shaped HTML paths are the fallback for a tree that has
 * already been built (or was authored as plain HTML), so packaging a build
 * output can still upgrade a blurred preview demo to the live embed.
 */
const BOOKING_PAGE_CANDIDATES = [
  'src/pages/book.astro',
  'src/pages/contact.astro',
  'book/index.html',
  'contact/index.html',
  'book.html',
  'contact.html',
];

export interface CalComOptions {
  /** Cal.com embed layout. Default 'month_view'. */
  layout?: 'month_view' | 'week_view' | 'column_view';
  /** Cal.com embed theme. Default 'light' (matches the shared CalBookingBlock convention). */
  theme?: 'light' | 'dark';
  /** iframe title attribute. Default 'Book an appointment'. */
  title?: string;
}

/**
 * Normalizes a user-supplied Cal.com URL/handle into the link fragment Cal.com
 * expects after `cal.com/`, e.g. "yourname/30min" or "yourname".
 *
 * Accepts, and returns the same normalized fragment for:
 *   "yourname"                         → "yourname"
 *   "yourname/30min"                   → "yourname/30min"
 *   "cal.com/yourname"                 → "yourname"
 *   "https://cal.com/yourname/30min"   → "yourname/30min"
 *   "https://app.cal.com/yourname"     → "yourname"
 *
 * Returns null for empty input or a URL on a non-Cal.com host (this function
 * only ever produces Cal.com embeds — see docs/INTEGRATIONS-PLAN.md, which
 * prefers Cal.com for new integration code).
 */
export function normalizeCalLink(
  calUrl: string | null | undefined,
): string | null {
  if (!calUrl) return null;
  let rest = calUrl.trim();
  if (!rest) return null;

  rest = rest.replace(/^https?:\/\//i, '');

  const hostMatch = rest.match(/^([^/?#]+)/);
  const host = hostMatch?.[1]?.toLowerCase() ?? '';
  if (host.includes('.')) {
    if (!/^(www\.|app\.)?cal\.com$/.test(host)) return null;
    rest = rest.slice(host.length);
  }

  rest = rest.replace(/^\/+/, '');
  rest = rest.split(/[?#]/)[0] ?? '';
  // Trailing slashes are counted off by hand: `/\/+$/` has to backtrack from
  // every offset on a value that is nothing but slashes, and this one arrives
  // straight from a client's form field.
  let end = rest.length;
  while (end > 0 && rest[end - 1] === '/') end -= 1;
  rest = rest.slice(0, end);

  return rest || null;
}

/** Cal.com's documented no-JS embed route: cal.com/<link>/embed?layout=…&theme=… */
function calEmbedSrc(calLink: string, opts: CalComOptions): string {
  const layout = opts.layout ?? 'month_view';
  const theme = opts.theme ?? 'light';
  return `https://cal.com/${calLink}/embed?layout=${layout}&theme=${theme}`;
}

function renderManagedBlock(
  calLink: string,
  opts: CalComOptions,
  standalone: boolean,
): string {
  const title = opts.title ?? 'Book an appointment';
  const src = calEmbedSrc(calLink, opts);
  const wrapperOpen = standalone
    ? `<div class="flowstarter-cal-embed" data-flowstarter-cal-embed="true" style="margin:32px 0;border:1px solid var(--border-color, #e5e5e5);border-radius:var(--radius-lg, 12px);overflow:hidden;">`
    : `<div class="book-page__calendar" data-flowstarter-cal-embed="true">`;
  const iframeStyle = standalone
    ? ' style="display:block;width:100%;border:0;"'
    : '';
  return [
    wrapperOpen,
    `  <!-- flowstarter:cal-embed — injected by injectCalCom(); re-running the injector updates this block in place -->`,
    `  <iframe`,
    `    src="${src}"`,
    `    width="100%"`,
    `    height="700"`,
    `    frameborder="0"`,
    `    title="${title}"`,
    `    loading="lazy"${iframeStyle}`,
    `  ></iframe>`,
    `</div>`,
  ].join('\n');
}

/**
 * Static, blurred calendar mock for funnel previews. No network call to
 * cal.com — the live embed is reserved for the paid full-site build.
 */
function renderPreviewDemoBlock(standalone: boolean): string {
  const wrapperOpen = standalone
    ? `<div class="flowstarter-cal-preview" data-flowstarter-cal-preview="true" style="position:relative;margin:32px 0;border:1px solid var(--border-color, #e5e5e5);border-radius:var(--radius-lg, 12px);overflow:hidden;min-height:420px;background:var(--surface-base, #fafafa);">`
    : `<div class="book-page__calendar" data-flowstarter-cal-preview="true" style="position:relative;overflow:hidden;min-height:420px;">`;
  const days = Array.from({ length: 28 }, (_, i) => {
    const n = i + 1;
    const active = n === 12 || n === 19;
    return `<span style="display:flex;align-items:center;justify-content:center;aspect-ratio:1;border-radius:8px;font-size:13px;${
      active
        ? 'background:#111;color:#fff;font-weight:600;'
        : 'background:rgba(0,0,0,0.04);color:#333;'
    }">${n}</span>`;
  }).join('');
  return [
    wrapperOpen,
    `  <!-- flowstarter:cal-preview — blurred demo; injectCalCom() replaces this on the full site -->`,
    `  <div aria-hidden="true" style="filter:blur(7px);transform:scale(1.02);padding:28px 24px 40px;pointer-events:none;user-select:none;">`,
    `    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">`,
    `      <strong style="font-size:18px;letter-spacing:-0.02em;">Book a time</strong>`,
    `      <span style="font-size:13px;opacity:0.6;">Cal.com</span>`,
    `    </div>`,
    `    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;">${days}</div>`,
    `    <div style="margin-top:24px;display:grid;gap:10px;">`,
    `      <div style="height:44px;border-radius:10px;background:rgba(0,0,0,0.06);"></div>`,
    `      <div style="height:44px;border-radius:10px;background:rgba(0,0,0,0.06);"></div>`,
    `      <div style="height:48px;border-radius:10px;background:#111;opacity:0.85;"></div>`,
    `    </div>`,
    `  </div>`,
    `  <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(255,255,255,0.28);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);">`,
    `    <p style="margin:0;max-width:16rem;text-align:center;font-size:14px;line-height:1.4;font-weight:600;color:#111;text-shadow:0 1px 0 rgba(255,255,255,0.8);">`,
    `      Your Cal.com calendar<br /><span style="font-weight:500;opacity:0.75;">Unlocks on the full site</span>`,
    `    </p>`,
    `  </div>`,
    `</div>`,
  ].join('\n');
}

function spliceBookingBlock(before: string, block: string): string | null {
  const found =
    findManagedBlock(before) ??
    findPreviewDemoBlock(before) ??
    findPlaceholderCalendar(before);
  if (found) return spliceBlock(before, found, block);

  // No calendar of any kind: hang the block off the last `</main>`.
  const lastMain = before.lastIndexOf('</main>');
  if (lastMain !== -1) {
    return `${before.slice(0, lastMain)}${block}\n</main>${before.slice(lastMain + 7)}`;
  }
  return null;
}

function wantsStandalone(before: string): boolean {
  const managed = findManagedBlock(before);
  if (managed?.text.includes('class="flowstarter-cal-embed"')) return true;
  const preview = findPreviewDemoBlock(before);
  if (preview?.text.includes('class="flowstarter-cal-preview"')) return true;
  return (
    findPlaceholderCalendar(before) === null &&
    !before.includes('class="book-page__calendar"') &&
    managed === null &&
    preview === null
  );
}

/**
 * Funnel/preview only: replace the booking placeholder with a blurred static
 * calendar demo. Never loads cal.com. Idempotent via
 * `data-flowstarter-cal-preview`.
 */
export function injectCalComPreviewDemo(files: FileMap): FileMap {
  const targetPath = BOOKING_PAGE_CANDIDATES.find((path) => path in files);
  if (!targetPath) return files;

  const before = files[targetPath]!;
  const block = renderPreviewDemoBlock(wantsStandalone(before));
  const after = spliceBookingBlock(before, block);
  if (!after || after === before) return files;
  return { ...files, [targetPath]: after };
}

/**
 * Deletes any live (`data-flowstarter-cal-embed`) or preview-demo
 * (`data-flowstarter-cal-preview`) calendar block from every file in the
 * tree, leaving everything else — including a page's own email
 * call-to-action — exactly as it was.
 *
 * This is the other half of `injectCalCom`'s contract: a workspace with no
 * validated booking link gets no calendar UI at all, real or blurred. It has
 * to scan every file rather than stop at the first `BOOKING_PAGE_CANDIDATES`
 * hit, because `injectCalComPreviewDemo` runs at preview time against
 * whichever candidate page is still in the scaffold — normally `book.astro`,
 * but once the page-set rule has already dropped that page for having no
 * booking link, the demo's own append-before-`</main>` fallback lands it on
 * `contact.astro` instead. A later call with the *same* candidate list would
 * only find it again by coincidence; a paid build or client rebuild that
 * inherits that seeded page must remove it regardless of which page it is on.
 */
export function removeCalComPreviewDemo(files: FileMap): FileMap {
  let changed = false;
  const next: FileMap = { ...files };
  for (const [path, content] of Object.entries(files)) {
    if (
      !content.includes('data-flowstarter-cal-preview="true"') &&
      !content.includes('data-flowstarter-cal-embed="true"')
    ) {
      continue;
    }
    let stripped = content;
    for (;;) {
      const block =
        findManagedBlock(stripped) ?? findPreviewDemoBlock(stripped);
      if (!block) break;
      stripped = spliceBlock(stripped, block, '');
    }
    if (stripped !== content) {
      next[path] = stripped;
      changed = true;
    }
  }
  return changed ? next : files;
}

/**
 * Injects (or, on re-run, updates) a Cal.com booking embed into a template's
 * file tree. Pure and deterministic: same inputs → same output, no network,
 * no LLM.
 *
 * With no valid `calUrl`, this does not merely no-op: it calls
 * `removeCalComPreviewDemo` so that any block a prior preview injection left
 * behind — the blurred demo, or a stale live embed from a link the client
 * has since removed — cannot survive into a build that has no link to back
 * it. A file tree with neither `src/pages/book.astro` nor
 * `src/pages/contact.astro` (nor a built-HTML equivalent) still returns
 * `files` unchanged in that branch, since there is no candidate page to
 * inject the live embed into.
 */
export function injectCalCom(
  files: FileMap,
  calUrl: string | null | undefined,
  opts: CalComOptions = {},
): FileMap {
  const calLink = normalizeCalLink(calUrl);
  if (!calLink) return removeCalComPreviewDemo(files);

  const targetPath = BOOKING_PAGE_CANDIDATES.find((path) => path in files);
  if (!targetPath) return files;

  const before = files[targetPath]!;
  const block = renderManagedBlock(calLink, opts, wantsStandalone(before));
  const after = spliceBookingBlock(before, block);
  if (!after || after === before) return files;
  return { ...files, [targetPath]: after };
}

// ─── Lead capture ──────────────────────────────────────────────────────────

/**
 * The contact page, in the same preference order and for the same reason as
 * `BOOKING_PAGE_CANDIDATES`: the `.astro` source first, so injecting before
 * `astro build` puts the script in every built copy of the page for free, and
 * the `dist`-shaped paths as the fallback for a tree that has already been
 * built or was authored as plain HTML.
 */
const LEAD_CAPTURE_PAGE_CANDIDATES = [
  'src/pages/contact.astro',
  'contact/index.html',
  'contact.html',
];

const findLeadCaptureBlock = (html: string) =>
  findMarkedDiv(html, 'data-flowstarter-lead-capture="true"');
const findLeadCaptureSlot = (html: string) =>
  findMarkedDiv(html, 'data-flowstarter-lead-capture-slot');

/**
 * The endpoint, or null.
 *
 * Deliberately narrow. This string becomes the address every enquiry a client
 * ever receives is posted to, written into a public page by a build nobody
 * watches, so "looks like a URL" is not the bar: it has to be https and it has
 * to be a capture path. Anything else is refused and the site keeps its mailto
 * fallback, which is a worse contact form and not a leak.
 */
export function normalizeLeadCaptureEndpoint(
  endpoint: string | null | undefined,
): string | null {
  if (!endpoint) return null;
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!/^\/api\/leads\/capture\/[^/]+$/.test(url.pathname)) return null;
  if (url.search || url.hash) return null;
  return url.toString();
}

/**
 * The whole of the site side of lead capture: one inline script.
 *
 * No framework, no bundler, no import. It has to survive `astro build`
 * unchanged and be findable in the built HTML by a string search, which a
 * bundled module script is not: Astro hoists those into `_astro/*.js` and
 * leaves a `<script src>` behind, so a build gate could never prove the token
 * shipped. `is:inline` is what stops that happening, and it is load-bearing.
 *
 * Progressive enhancement, in three layers:
 *   - No JavaScript at all: the form keeps its `mailto:` action and the
 *     browser hands the message to the visitor's mail client.
 *   - This script: the submit is intercepted and posted as JSON.
 *   - The network fails: the form is submitted natively, which is the mailto
 *     again. An enquiry is never silently dropped.
 *
 * It also sets `data-lead-capture="on"` on the form, which is how the
 * template's own bundled mailto handler knows to stand down. That runs later
 * (a module script is deferred, this one is not), so the flag is always set
 * before it looks.
 */
function renderLeadCaptureBlock(endpoint: string, astro: boolean): string {
  const scriptOpen = astro ? '<script is:inline>' : '<script>';
  return [
    `<div class="flowstarter-lead-capture" data-flowstarter-lead-capture="true">`,
    `  <!-- flowstarter:lead-capture — injected by injectLeadCapture(); re-running the injector updates this block in place -->`,
    `  ${scriptOpen}`,
    `    (function () {`,
    `      var endpoint = ${JSON.stringify(endpoint)};`,
    `      var form = document.querySelector('[data-contact-form]');`,
    `      if (!form) return;`,
    `      form.setAttribute('data-lead-capture', 'on');`,
    `      var sent = form.querySelector('[data-contact-sent]') || form.querySelector('[data-contact-success]');`,
    `      var failed = form.querySelector('[data-contact-error]');`,
    `      var button = form.querySelector('[type="submit"]');`,
    `      function show(el, text) { if (!el) return; if (text) el.textContent = text; el.hidden = false; }`,
    `      function hide(el) { if (el) el.hidden = true; }`,
    `      function value(data, key) { return String(data.get(key) || '').trim(); }`,
    `      form.addEventListener('submit', function (event) {`,
    `        event.preventDefault();`,
    `        if (typeof form.reportValidity === 'function' && !form.reportValidity()) return;`,
    `        hide(sent); hide(failed);`,
    `        var data = new FormData(form);`,
    `        var phone = (value(data, 'countryCode') + ' ' + value(data, 'phone')).trim();`,
    `        var payload = {`,
    `          name: value(data, 'name') || value(data, 'fullName'),`,
    `          email: value(data, 'email'),`,
    `          phone: phone,`,
    `          message: value(data, 'message'),`,
    `          page: window.location.pathname,`,
    `          company_website: value(data, 'company_website')`,
    `        };`,
    `        if (button) button.disabled = true;`,
    `        fetch(endpoint, {`,
    `          method: 'POST',`,
    `          headers: { 'Content-Type': 'application/json' },`,
    `          body: JSON.stringify(payload)`,
    `        }).then(function (response) {`,
    `          return response.json().catch(function () { return {}; }).then(function (body) {`,
    `            if (response.ok) { show(sent); form.reset(); }`,
    `            else { show(failed, body && body.message); }`,
    `            if (button) button.disabled = false;`,
    `          });`,
    `        }).catch(function () {`,
    `          if (button) button.disabled = false;`,
    `          if (form.getAttribute('action')) form.submit();`,
    `          else show(failed);`,
    `        });`,
    `      });`,
    `    })();`,
    `  </script>`,
    `</div>`,
  ].join('\n');
}

function spliceLeadCaptureBlock(before: string, block: string): string | null {
  const found = findLeadCaptureBlock(before) ?? findLeadCaptureSlot(before);
  if (found) return spliceBlock(before, found, block);

  const lastMain = before.lastIndexOf('</main>');
  if (lastMain !== -1) {
    return `${before.slice(0, lastMain)}${block}\n</main>${before.slice(lastMain + 7)}`;
  }
  return null;
}

/**
 * Deletes any injected lead capture block from every file in the tree.
 *
 * The other half of `injectLeadCapture`'s contract, and it scans everything
 * rather than the candidate list for the same reason `removeCalComPreviewDemo`
 * does: the block's append-before-`</main>` fallback can land it on a page
 * this list would not think to look at, and a build with no endpoint must not
 * ship a script posting to a token that no longer resolves.
 */
export function removeLeadCapture(files: FileMap): FileMap {
  let changed = false;
  const next: FileMap = { ...files };
  for (const [path, content] of Object.entries(files)) {
    if (!content.includes('data-flowstarter-lead-capture="true"')) continue;
    let stripped = content;
    for (;;) {
      const block = findLeadCaptureBlock(stripped);
      if (!block) break;
      stripped = spliceBlock(stripped, block, '');
    }
    if (stripped !== content) {
      next[path] = stripped;
      changed = true;
    }
  }
  return changed ? next : files;
}

/**
 * Injects (or, on re-run, updates) the lead capture script into a template's
 * file tree. Pure and deterministic, like everything else here.
 *
 * The endpoint carries the workspace's public capture token, so this is also
 * the thing that decides which tenant a site's enquiries belong to. A preview
 * gets a preview token, which the endpoint refuses with a sentence the script
 * shows; a paid build gets the real one.
 *
 * With no usable endpoint this removes rather than no-ops, for the reason
 * `injectCalCom` does: a seeded preview block inherited by a paid build has to
 * come back out even when there is nothing to put in its place.
 */
export function injectLeadCapture(
  files: FileMap,
  endpoint: string | null | undefined,
): FileMap {
  const url = normalizeLeadCaptureEndpoint(endpoint);
  if (!url) return removeLeadCapture(files);

  const targetPath = LEAD_CAPTURE_PAGE_CANDIDATES.find((path) => path in files);
  if (!targetPath) return files;

  const before = files[targetPath]!;
  const block = renderLeadCaptureBlock(url, targetPath.endsWith('.astro'));
  const after = spliceLeadCaptureBlock(before, block);
  if (!after || after === before) return files;
  return { ...files, [targetPath]: after };
}

export interface IntegrationsConfig {
  booking?: {
    provider: 'cal.com';
    /**
     * Empty, invalid or `null` removes any existing calendar block instead
     * of injecting a new one — see `injectCalCom`.
     */
    url: string | null;
    options?: CalComOptions;
  };
  leadCapture?: {
    /**
     * The full `https://<platform host>/api/leads/capture/<token>` URL, or
     * `null` to remove any block a previous run left behind — see
     * `injectLeadCapture`.
     */
    endpoint: string | null;
  };
}

/**
 * The `injectIntegrations(files, projectConfig)` step from
 * docs/INTEGRATIONS-PLAN.md's architecture diagram. Currently runs
 * `injectCalCom`; future deterministic integrations (analytics, SEO) plug in
 * here without touching call sites.
 *
 * A `booking` config with no url still runs `injectCalCom` — deliberately,
 * because that is what makes it remove a leftover demo/embed block rather
 * than only ever add one. Omitting `booking` entirely is the true no-op, for
 * a caller that has nothing to say about Cal.com either way.
 */
export function injectIntegrations(
  files: FileMap,
  config: IntegrationsConfig,
): FileMap {
  let next = files;
  if (config.booking?.provider === 'cal.com') {
    next = injectCalCom(next, config.booking.url, config.booking.options);
  }
  if (config.leadCapture) {
    next = injectLeadCapture(next, config.leadCapture.endpoint);
  }
  return next;
}

/**
 * Disk adapter for `runCodegen`'s real (non-in-memory) workspace: reads the
 * candidate booking pages out of `buildDir`, runs `injectIntegrations` over
 * them in memory, and writes back only the files that actually changed.
 * Never throws — a missing template file or an unrecognized `calUrl` is a
 * no-op, matching `injectCalCom`'s fail-open contract.
 *
 * Callers on the full-build and rebuild paths should call this
 * unconditionally, `booking.url` set to `job.calComUrl ?? null` — never only
 * when a link is present. The rule this enforces cuts both ways: a link
 * wires the live embed, and its absence removes the seeded preview demo. A
 * caller that only invoked this behind `if (calComUrl)` would let that demo
 * ship on a paid site whenever the workspace has no link, which is exactly
 * the defect this function exists to prevent.
 */
export async function applyIntegrationsToWorkspace(
  buildDir: string,
  config: IntegrationsConfig,
): Promise<{ applied: boolean; changedPaths: string[] }> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileExists } = await import('./workspace');

  const before: FileMap = {};
  // The union, not the booking list. This loop is the only thing that decides
  // which files reach `injectIntegrations` on the real build path, so a page
  // missing from it is an integration that silently never runs.
  const candidates = Array.from(
    new Set([...BOOKING_PAGE_CANDIDATES, ...LEAD_CAPTURE_PAGE_CANDIDATES]),
  );
  for (const rel of candidates) {
    const abs = join(buildDir, rel);
    if (await fileExists(abs)) before[rel] = await readFile(abs, 'utf8');
  }
  if (Object.keys(before).length === 0)
    return { applied: false, changedPaths: [] };

  const after = injectIntegrations(before, config);
  const changedPaths: string[] = [];
  for (const rel of Object.keys(after)) {
    if (after[rel] !== before[rel]) {
      await writeFile(join(buildDir, rel), after[rel]!, 'utf8');
      changedPaths.push(rel);
    }
  }
  return { applied: changedPaths.length > 0, changedPaths };
}
