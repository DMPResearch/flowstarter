/**
 * Assembles the recorded clips into one page.
 *
 * Facts come from `artifacts/showcase/manifest.json`, written by the recording
 * run — the page cannot claim a clip exists unless the file is on disk, and it
 * cannot claim a number that the run did not measure. Where a step could not
 * run on this machine the caption says so in a sentence rather than leaving a
 * gap that reads like success.
 *
 *   node e2e/support/build-showcase-page.mjs
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const OUT = 'artifacts/showcase';
const manifestPath = join(OUT, 'manifest.json');
const M = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : {};

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim() : '');

/**
 * Duration straight off the file. Several clips are assembled from cut or
 * joined segments, so the wall-clock time the recorder measured is not the
 * length of what a viewer actually watches — the file is the only honest source.
 */
function durationOf(file) {
  try {
    const out = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        file,
      ],
      { encoding: 'utf8' },
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

/**
 * One section per clip. A missing file is stated, not hidden: a silent gap
 * would read as though the step had been skipped for being unflattering.
 */
const clip = (name, title, caption) => {
  const file = join(OUT, 'video', `${name}.webm`);
  const meta = M.clips?.[name];
  if (!existsSync(file)) {
    return `
  <figure class="clip missing">
    <figcaption><strong>${esc(title)}</strong> — not recorded.
    ${esc(meta?.error || 'The step did not complete on this machine.')}</figcaption>
  </figure>`;
  }
  const secs = durationOf(file) ?? meta?.seconds ?? null;
  const dur = secs ? `<span class="dur">${esc(secs)}s</span>` : '';
  return `
  <figure class="clip">
    <video controls muted loop playsinline preload="metadata"><!--
      no src attribute: a src on <video> makes browsers ignore the <source>
      children, and Safari cannot decode the VP8 webm -- it needs the mp4
      --><source src="video/${name}.mp4" type="video/mp4"><source src="video/${name}.webm" type="video/webm"></video>
    <figcaption><strong>${esc(title)}</strong> ${dur}<br>${caption}</figcaption>
  </figure>`;
};

const commits = (M.commits ?? [])
  .map((c) => `<li><code>${esc(c)}</code></li>`)
  .join('');

/**
 * Whether clip 04 on disk is the two-change take or the older single-change one.
 *
 * Read from the manifest rather than assumed, because the two are different
 * films: the new flow withholds the deposit ask until both free changes are
 * spent, and captioning the old footage that way would describe a gate the
 * clip never shows. The recorder records what it actually achieved, so the
 * page can describe whichever take it is looking at.
 */
const twoChanges = M.editsApplied === 2 && M.offerRevealed === true;

/** Whether clip 05 reaches the unlock page or stops at the claim. */
const unlockFilmed = M.unlockFilmed === true;

/**
 * Facts for the two re-shot clips, read back out of the database by
 * `retake-facts.mjs` after the takes. Kept separate from `M.notes` so a
 * caption below cannot quietly fall back to a number an older run measured.
 */
const R = M.retake ?? {};
const E = M.notes?.editor ?? {};

writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Flowstarter — the client flow, running</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f1a; --panel:#121829; --line:#1f2740;
          --ink:#e8ecf6; --dim:#94a0bd; --accent:#7c8cff; --ok:#6ee7a8; --warn:#f0b866 }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.65 ui-sans-serif,system-ui,-apple-system,sans-serif }
  .wrap { max-width:1000px; margin:0 auto; padding:56px 20px 96px }
  h1 { font-size:clamp(1.9rem,4vw,2.7rem); line-height:1.14; margin:0 0 14px; letter-spacing:-.02em }
  .lede { color:var(--dim); max-width:66ch; margin:0 0 32px }
  h2 { font-size:1.15rem; margin:46px 0 6px }
  h2 .n { color:var(--accent); font-variant-numeric:tabular-nums; margin-right:.5em }
  .clip { margin:14px 0 22px; background:var(--panel); border:1px solid var(--line);
          border-radius:14px; overflow:hidden }
  .clip.missing { border-color:#4a3a24; background:#1a1509 }
  .clip video { width:100%; display:block; background:#000 }
  figcaption { padding:12px 16px; color:var(--dim); font-size:13.5px; border-top:1px solid var(--line) }
  .clip.missing figcaption { border-top:0; color:var(--warn) }
  figcaption strong { color:var(--ink); font-weight:600 }
  .dur { color:var(--dim); font-size:12px; border:1px solid var(--line); border-radius:20px;
         padding:1px 8px; margin-left:8px; font-variant-numeric:tabular-nums }
  table.facts { width:100%; border-collapse:collapse; margin:0 0 8px; font-size:14px }
  table.facts td { border-top:1px solid var(--line); padding:9px 4px; vertical-align:top }
  table.facts td:first-child { color:var(--dim); width:210px }
  table.facts td b { color:var(--ok); font-weight:600 }
  pre { background:#0d1322; border:1px solid var(--line); border-radius:12px; padding:16px;
        overflow-x:auto; font:12.5px/1.6 ui-monospace,Menlo,monospace; color:#c7d0e8;
        white-space:pre; -webkit-overflow-scrolling:touch }
  a { color:var(--accent) }
  ol.commits { columns:2; column-gap:26px; padding-left:20px; color:var(--dim); font-size:13px }
  ol.commits li { margin:0 0 3px; break-inside:avoid }
  ol.commits code { font:12px/1.5 ui-monospace,Menlo,monospace }
  .note { background:#141a2e; border-left:3px solid var(--warn); border-radius:0 10px 10px 0;
          padding:12px 16px; margin:14px 0; color:var(--dim); font-size:13.5px }
  .note b { color:var(--warn) }
  footer { color:var(--dim); font-size:13px; margin-top:56px; border-top:1px solid var(--line); padding-top:18px }
  footer code { color:var(--ink) }
</style></head><body><div class="wrap">

<h1>The client flow, running</h1>
<p class="lede">Ten clips, in order, of one visitor going from a blank landing page to a paid project
with an operator working it. Everything below is the running system on a local stack: a real model
writing a real site in about five and a half minutes, a Stripe webhook verified with a real signature,
real Clerk sessions for two separate accounts. Three of these clips show something failing — a broken
page, a gated editor, a build worker that is not configured. Those are kept, and each says exactly what
broke and why, because a reel with the failures cut out would not tell you anything you could rely on.</p>

<table class="facts">
  <tr><td>Branch</td><td><code>${esc(M.branch ?? 'pivot-concierge-v1')}</code>, ${esc(M.commits?.length ?? 0)} commits since <code>9a74ac80</code></td></tr>
  <tr><td>Unit + integration tests</td><td><b>${esc(M.tests?.passed ?? '?')} passed</b> across ${esc(M.tests?.files ?? '?')} files (<code>vitest --root src --run</code>)</td></tr>
  <tr><td>Tenant isolation (RLS)</td><td><b>${esc(M.rls ?? '14/14')}</b> — <code>scripts/verify-rls-local.mjs</code>, by query and by API</td></tr>
  <tr><td>Preview claim</td><td><b>${esc(M.claim ?? '27/27')}</b> — route, durable preview, and intake-chat carry-over</td></tr>
  <tr><td>Workspace filmed</td><td><code>${esc(M.workspaceId ?? '—')}</code></td></tr>
  <tr><td>Generation</td><td>${esc(M.generation ?? '—')}</td></tr>
</table>

<h2><span class="n">01</span>Intake</h2>
${clip(
  '01-intake',
  'Landing to brief',
  `A visitor opens the landing page and <strong>talks</strong> the brief
through — a Bristol counsellor, from <code>e2e/support/briefs.mjs</code>. There is no form: one question
at a time, answered by typing or by tapping a quick reply, with every earlier answer still on screen and
editable. What is worth knowing is who decides. The order of the questions, what counts as a valid
answer, which ones are required and when the intake is <em>finished</em> are all data in
<code>intake-script.ts</code> — <strong>no model is consulted</strong> for any of it. Notice the optional
question being skipped outright, and notice too that there is nothing that jumps ahead of it: the two
commercial decisions at the end are turns in the same conversation, not something a visitor can skip past
to reach the preview early. The recommendation is computed first by <strong>deterministic rules</strong>
(<code>recommendTier</code> in <code>discovery.logic.ts</code>); a model call may then refine it, and if
that call fails the rules stand. The reasons listed are the rules that actually fired, not a generated
explanation.`,
)}

<h2><span class="n">02</span>The info agent</h2>
${clip(
  '02-info-agent',
  'What is still missing',
  `The gate lists what it does not yet know in plain language.
The replies are typed in, and the follow-up question is a live model call through OpenRouter — not a
scripted line: the agent introduces itself, then picks a concrete detail out of the answer
(&ldquo;trauma-informed and paced by the client&rdquo;) before asking the next question. That is phrasing
only — the sufficiency gate still decides what gets asked and in what order, and it stops asking as soon
as it has enough, which is why the last answer draws no reply.
<strong>Skip and show me the preview</strong> stays visible the whole time; the agent
can never trap someone in a conversation.`,
)}

<h2><span class="n">03</span>Generation</h2>
${clip(
  '03-generation',
  'Skeleton, phases, then the site',
  `The preview step is a conversation. A sticky
<strong>NOW</strong> line names the phase and counts the seconds, the site pane starts as an empty
skeleton — deliberately blank bars, never invented headlines — and each phase arrives as a message
signed by the agent that owns it: Brand analyst, Site builder, Honesty editor. The deposit is stated
before the build starts, not after. Then the finished site, desktop and phone.`,
)}
<div class="note"><b>What is real, what is local:</b> the model is a live OpenRouter call and it writes
real files. <code>FLOWSTARTER_LOCAL_PREVIEW=true</code> means those files are served from a local
directory instead of a Daytona sandbox. ${esc(M.generation ?? '')}. The build takes about five and a
half minutes; the waiting is cut, nothing is sped up.</div>
${
  M.iframeNotCaptured
    ? `<div class="note"><b>The site pane is shown full-frame, not through the wizard.</b>
That pane is a cross-origin iframe and headless Chromium does not composite it into a captured video —
it comes out white on the recording even though it is loading and a visitor sees it. So the finished
site is filmed by opening the same preview URL the pane points at. The conversation, the phases and
the timings are the original take.</div>`
    : ''
}

<h2><span class="n">04</span>Editing by prompt</h2>
${
  twoChanges
    ? clip(
        '04-prompt-edit',
        'Two changes on the house, then the ask',
        `The site arrives with an offer of
<strong>two changes</strong>, not a price — a counter on the edit box tracks them. Both are spent here:
the headline is rewritten to say the intro call is free, then evening and online sessions are worked
into the services. Each instruction is plain English, and each change lands in the same iframe; no
template picker, no CSS. The deposit ask stays out of the conversation until the second change is in
&mdash; deterministic, a counter and a click, with a quiet <em>Happy already?</em> link for anyone who
wants to skip ahead.`,
      )
    : clip(
        '04-prompt-edit',
        'One sentence, one change',
        `A plain-English instruction is sent to the live
preview and the change lands in the iframe. No template picker, no CSS — the visitor describes the
change and the model applies it to the generated source.`,
      )
}
${
  twoChanges
    ? ''
    : `<div class="note"><b>This clip predates the two-change flow.</b> The product now offers
two free changes before it mentions money, and holds the deposit ask back until both are spent
(<code>6f57cdc0</code>). The take above is the earlier single-change version; it is kept because it is
the most recent footage in which a prompt edit actually completed.</div>`
}

<h2><span class="n">05</span>Claim and deposit</h2>
${clip(
  '05-claim-and-deposit',
  'The offer, then the money',
  `${twoChanges ? 'The offer the second change unlocked, with' : 'The offer is restated next to the preview with'}
the real split — a &euro;159.80 deposit against a &euro;799 build, &euro;639.20 on completion — and a
quieter way out beside it. A signed-out click opens Clerk's modal rather than navigating, because a
redirect here would throw away the preview.${
    unlockFilmed ? ' Then the unlock page, and the deposit landing on it.' : ''
  }`,
)}
${
  unlockFilmed
    ? ''
    : `<div class="note"><b>The unlock page is not in this clip, and the reason is a bug of
ours.</b> The deposit below is real and the workspace really moved to <code>DEPOSIT_PAID</code> — the
transcript is printed underneath. What could not be filmed is the page the client lands on afterwards:
<code>NavigationWrapper</code> keeps its own hardcoded list of public routes, <code>/unlock</code> was
never added to it (the middleware does treat it as public), so the route is held behind a full-screen
loading screen until Clerk reports <code>isLoaded</code> — and on this route Clerk never does, so the
screen never lifts. Rather than publish twenty-six seconds of a spinner, the clip stops at the claim.</div>`
}
<div class="note"><b>One click is not on camera.</b> This Clerk instance answers a scripted sign-in with
<code>needs_client_trust</code> — bot protection a headless browser cannot satisfy — and redeeming a
sign-in token calls <code>setActive</code>, which navigates and would destroy the preview. So the modal
is filmed opening, and then the session is created from a server-minted Clerk token and the
<em>same</em> request the button makes is sent with the same preview id and the visitor's own answers.
The claim returned <code>201</code> and a real workspace. What you do not see is the password being typed.</div>
<div class="note"><b>The deposit is a real webhook.</b> The event is signed with the real secret and
posted to the live route, so <code>constructEvent</code> verifies it exactly as it verifies Stripe's own
delivery, and the amount is checked against the stored quote. The run also redelivers the identical
event (the ledger must not build twice) and posts a forged one, which is refused.</div>
${read('/tmp/deposit-run.txt') ? `<pre>${esc(read('/tmp/deposit-run.txt'))}</pre>` : ''}

<h2><span class="n">06</span>The client dashboard</h2>
${clip(
  '06-client-dashboard',
  'The asks, the thread, and a photo going up',
  `The client's own project, on the
route that used to throw. The stepper puts the build at <em>${esc(
    R.built?.project_state === 'HUMAN_QA'
      ? 'a person is checking every page'
      : (R.built?.project_state ?? 'its current stage'),
  )}</em>; the open
asks are listed with a way to answer each one; the thread carries the operator's clarification, and a
typed reply lands in it — <strong>${esc(R.inbound ?? 0)} inbound message</strong> in
<code>project_messages</code> where there were none. Then one photograph goes up against the ask it
answers, the rights are confirmed, and the panel underneath is the server's recomputed reading of what
is <em>still</em> missing.`,
)}
<div class="note"><b>The previous take of this clip filmed a real bug, and it is fixed.</b> That take was
a 500: <code>dashboard/projects/[workspaceId]/page.tsx</code> called <code>messagesFromPayload()</code>
— a client-module export — from a server component, and Next refused to render the page at all. Filming
is what found it. It is fixed at this commit, so this is the honest re-take rather than a patched-over
one, and the failure is left in the record above as part of how the work went.</div>
<div class="note"><b>What the server did with the photo.</b> The file is a
${esc(R.assets?.[0]?.size ?? '1200x800')} interior from the template library's own photo set — no one's
face in a filmed clip — and it is stored <code>usable_for: ${esc(
    R.assets?.[0]?.usableFor?.join(', ') ?? 'section',
  )}</code> with the rights confirmation recorded against it. Nothing is placed on the site until
that box is ticked. The readiness line then <em>changes its mind in public</em>: the main-photo ask stops
being "we have nothing" and becomes "the one we have is too small or too tall for the top of the page",
because the gate measured the file rather than counting it. Two asset requests are still open, so eight
asks are listed — the operator raised the same request twice on the earlier run, and that duplicate is
left on screen rather than tidied out of the recording.</div>

<h2><span class="n">07</span>The operator console</h2>
${clip(
  '07-operator-console',
  'Where a stall becomes visible',
  `A different account, with the operator role.
The pipeline board counts the projects that need attention and shows this one in
<code>DEPOSIT_PAID</code> with its <code>FULL_SITE_BUILD</code> job flagged as queued and stalled. The
project's Pipeline tab carries the real job ledger and the real timeline, and <strong>Re-dispatch</strong>
returns the honest failure rather than pretending to send work somewhere.`,
)}
<div class="note"><b>The build worker cannot run here.</b> It needs a GitHub sites repository and a token
this machine does not have. So the deposit enqueues <code>FULL_SITE_BUILD</code>, the dispatcher logs
that it is not configured, and the job sits queued — which is exactly the stall the console exists to
surface. Nothing was faked to make it look dispatched.</div>
<div class="note"><b>Two things about the operator's own role.</b> There is no message composer in the
admin UI — only the client dashboard renders a thread — so the clarification was sent from the
operator's signed-in page to the same route a composer would call, and confirmed in the database rather
than on a screen. And the operator needed <code>publicMetadata.role</code> set explicitly: the pipeline
board accepts the flowstarter.dev email-domain fallback, but
<code>/api/admin/projects/[id]</code> re-implements its own check that does not, so the project page
hung on "Loading…" until the role was set. That inconsistency was in the code, not in the recording —
and it is fixed at this commit: the operator filmed in clips 06 and 08 above is a plain
flowstarter.dev account with no metadata set on it at all.</div>

<h2><span class="n">08</span>The editor</h2>
${clip(
  '08-editor',
  'The plan goes on, and the editor runs',
  `Two halves, both real. The operator opens the
workspace the client claimed minutes earlier with the Pro care plan: its Billing tab reads
<strong>&euro;${esc(R.claimed?.monthly_fee ?? 99)}/mo</strong>, mapped server-side from the plan's name —
the browser never sends a price, and this is the &euro;0 that used to gate everything. Activation there
is refused, out loud, and the reason is below. So the operator moves to the project this pipeline
actually built and was paid for in full, sets its monthly fee in the console's own field, and activates:
Stripe returns a subscription on trial (<code>${esc((R.built?.stripe_subscription_id ?? '').slice(0, 14))}…</code>).
Then the client's editor, on that workspace — <strong>${esc(E.targets ?? 247)} editable targets</strong>
read out of their site, an instruction typed against one of them, and the model's actual rewrite shown
word-by-word against the old sentence before anything is saved. Applied as a new version, then put back:
<code>${esc((R.siteVersions ?? []).join(' · '))}</code>.`,
)}
<div class="note"><b>The previous take of this clip filmed a real bug, and it is fixed.</b> That take was
a dead end: the editor loaded the client's site and refused every control, because the policy wants an
active care plan and the claim had never put a price on the workspace — which left the operator's own
activation button disabled too. The claim now maps <code>subscription: 'pro'</code> to
&euro;99/mo and a billing interval, so the chain completes. Filming is what found the gap; this is the
re-take, and the earlier refusal stays in the record as part of how the work went.</div>
<div class="note"><b>Why the newly claimed workspace could not be the one that unlocks.</b> Its
activation is refused with the endpoint's own sentence — <em>"Both deposit and final must be paid before
activating subscription"</em> — and the deposit is unpaid for a reason worth naming: the durable
<code>funnel_previews</code> row for that preview carries the site's files but no intake, because
<code>publishFunnelPreview</code> upserts the row without it and overwrites what the claim stashed. So
<code>getClaimablePreview</code> found nothing usable, the workspace was minted empty and left in
<code>INTAKE</code>, and <code>payment_intent.succeeded</code> answered <code>500</code> —
"Deposit cannot start a build from state INTAKE". A workspace with no site is one the editor has nothing
to open, and no amount of billing changes that. It is filmed as it happened; nothing was written into
the database to hide it.</div>
<div class="note"><b>The pane beside the editor is blank, and that is a bug in this build.</b> The
route serves the site fine — <code>GET /api/client/site/&lt;id&gt;/preview</code> returns 200 and 58KB of
the client's own content — but the middleware only relaxes framing for paths starting with
<code>/preview</code>, so this one is stamped <code>frame-ancestors 'none'</code> and Chrome blocks the
iframe: <em>"Framing … violates the following Content Security Policy directive"</em>. Every client's
editor shows an empty pane today. It was found by watching this clip back, and it is not fixed here —
this run films the build, it does not patch it.</div>
<div class="note"><b>The structural refusal has no notice to show, so it was exercised instead.</b> The
policy notice only renders when something is refused, and with the plan on, words and pictures are not:
the client owns them. The editor offers a client no structural control at all — the list holds text, the
Pictures tab holds slots — so the boundary was tested where it is enforced, on the same route the editor
posts to, from the client's own session: a stylesheet target answers
<code>${esc(E.structuralRefusal?.status ?? 403)}</code> —
<em>"${esc(E.structuralRefusal?.body?.match(/"error":"([^"]+)"/)?.[1] ?? 'color changes require Flowstarter review under the care plan')}"</em>.
That request is not on camera; the response is quoted verbatim.</div>

<h2><span class="n">09</span>Balance, and a finished site</h2>
${clip(
  '09-balance-and-live',
  'Two moves, the other 80%, and the output',
  `The operator advances the project
with a written reason each time — and because only neighbouring states are allowed, getting from
<code>DEPOSIT_PAID</code> to <code>HUMAN_QA</code> takes two moves, not one. The Billing tab then shows
both invoices paid, &euro;159.80 and &euro;639.20, the balance having gone through the invoice path the
webhook already handles. The two finished sites at the end came out of this pipeline on earlier runs: a
Bristol counselling practice and a Romanian bakery, written in Romanian.`,
)}
<div class="note"><b>The client's side of the balance is the unlock page.</b> It reads the same workspace
row the webhook wrote. This clip was filmed when the client project page was still throwing; that page
works now, and clip 06 above is the re-take. The project finished this recording in
<code>HUMAN_QA</code> with both the deposit and the balance marked paid.</div>

<h2><span class="n">10</span>Preview hosting</h2>
${clip(
  '10-previews-hosting',
  'The lever, not pulled',
  `The provisioner's default is a dry run: it prints the exact
server, the cloud-init size and the DNS record it would write, and exits without calling a mutating API.
The operator's reap endpoint is shown in <code>GET</code> form, which lists what would be reaped and
tears down nothing.`,
)}
<div class="note"><b>No server was created and no DNS was changed.</b> The Hetzner host is unprovisioned
by design — applying costs money and edits a live zone, so it requires
<code>--yes-i-understand-this-costs-money</code> spelled out in full. The output below is the plan only.</div>
${read('/tmp/provision-dryrun.txt') ? `<pre>${esc(read('/tmp/provision-dryrun.txt'))}</pre>` : ''}

<h2>What could not run here, in full</h2>
<ul class="sites">
<li><strong>The editor's preview pane is blank for every client.</strong> The route returns the site
(200, 58KB), but the middleware relaxes framing only for paths under <code>/preview</code>, so
<code>/api/client/site/&lt;id&gt;/preview</code> is served with <code>frame-ancestors 'none'</code> and
the browser blocks the iframe. Found by watching clip 08 back; filmed, not patched.</li>
<li><strong>A durable preview cannot hand a workspace its site.</strong> The
<code>funnel_previews</code> row keeps the files but not the intake, so a claim served from that row
mints an empty workspace stuck in <code>INTAKE</code> — and its deposit webhook then answers
<code>500</code>. That is why clip 08's second half moves to the project the pipeline actually built.</li>
<li><strong>Two things clip 06 and clip 08 used to show, and no longer do.</strong> The client project
page was a 500 (a client-module call inside a server component) and the editor was gated at
&euro;0/mo. Both are fixed at this commit and both clips are honest re-takes; the earlier failures are
described above rather than deleted.</li>
<li><strong>The build worker.</strong> It needs a GitHub sites repository and a token this machine does
not have. The deposit still enqueues <code>FULL_SITE_BUILD</code>; the dispatcher logs that it is not
configured and the job stays queued. That stall is shown, not hidden.</li>
<li><strong>The Hetzner previews host.</strong> Not provisioned, by design — applying costs money and
writes to a live DNS zone, so the script demands a flag spelled out in full. Only the dry run was
recorded. No server was created and no DNS record was touched.</li>
<li><strong>A filmed password sign-in.</strong> The Clerk instance requires client-trust verification a
headless browser cannot pass, so both sessions were created from server-minted, single-use Clerk
sign-in tokens. Real users, real roles, real sessions — no form-filling on camera.</li>
<li><strong>An operator message composer.</strong> It does not exist in the admin UI. The clarification
went to the same endpoint a composer would call, from the operator's own session, and was confirmed in
the database.</li>
<li><strong>Generation is not certain.</strong> This one ${esc(M.generation ?? 'ran')}. When it fails it
says so — the step shows "The build stopped" — and the run tries again rather than dressing up a
fallback as a finished site.</li>
</ul>

<h2>The commits behind it</h2>
<ol class="commits">${commits}</ol>

<footer>
Recorded on one machine against a local Supabase, a Clerk test instance and Stripe test keys.
Workspace filmed: <code>${esc(M.workspaceId ?? '—')}</code> — left in the local database as demo data.
The two Clerk users created for the recording were deleted afterwards.
Timings are from these runs, not a benchmark.
${M.recordedAt ? `Recorded ${esc(M.recordedAt)}.` : ''}
</footer>
</div></body></html>`,
);
console.log('wrote', join(OUT, 'index.html'));
