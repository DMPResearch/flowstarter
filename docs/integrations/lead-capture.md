# Lead capture

Every workspace's site posts its contact form to Flowstarter, and the message
lands in that workspace's `leads` table. Nothing here is shared between
clients: one workspace, one token, one set of enquiries, one inbox.

The storage half existed for months. The site half did not, so the enquiries
tile on a client's dashboard could only ever show zero. This is the wiring.

## What identifies the tenant

Not the workspace id. The value has to sit in static HTML that any visitor can
read, and an id is the key half the schema is addressed by, it appears in
dashboard URLs and event payloads, and it cannot be changed.

So each workspace carries `workspaces.lead_capture_token`: 32 random bytes in
base64url, 43 characters, unique, `not null` with a database default, and
rotatable. It is public by nature and it grants exactly one thing:

> create one lead for this workspace

It reads nothing. It is accepted on one endpoint. Losing it costs the client a
rotation and a republish, not a workspace.

The shape is `^[A-Za-z0-9_-]{43,128}$`, enforced both as a check constraint on
the column and as the first thing the endpoint looks at. The floor is 43 rather
than 32 for one reason: a canonical UUID is 36 characters of hex and hyphens,
which is valid base64url, so a lower floor would make a workspace id a
well-formed token and let the endpoint be probed with one.

## The contract

```
POST https://<platform host>/api/leads/capture/<token>
Content-Type: application/json
Origin: https://<one of this workspace's own hostnames>
```

```json
{
  "name": "Elena Popescu",
  "email": "elena@salon.ro",
  "message": "Doresc o programare pentru vineri",
  "phone": "+40 712 345 678",
  "page": "/contact",
  "company_website": ""
}
```

`name`, `email` and `message` are required. `phone` and `page` are optional.
`company_website` is the honeypot: it is hidden in the markup, no person ever
fills it in, and a submission carrying it is accepted and discarded.

Success is `201` with `{ "ok": true }` and nothing else. The lead id is not in
it, the workspace is not in it, and the spam verdict is not in it. Every extra
field would be a fact about a tenant published to whoever asked, and telling a
spammer they were classified is telling them what to change.

A refusal is `{ "ok": false, "message": "..." }` with a sentence the site shows
the visitor as it is.

| Situation                                               | Status                     |
| ------------------------------------------------------- | -------------------------- |
| A preview token                                         | 403, before any query      |
| A token that is not base64url, including a workspace id | 404, before any query      |
| A token nobody has, or one that has been rotated away   | 404, the same body         |
| Over the rate limit, per token or per IP                | 429, before any query      |
| An origin that is not this workspace's own              | 403, and no allow header   |
| A body that fails a rule                                | 400, naming which          |
| The honeypot was filled in                              | 201, and nothing is stored |
| Stored, spam or not                                     | 201                        |
| The database could not be reached                       | 503                        |

The order matters. A malformed token and a wrong token get the same 404 and
neither reads anything, so the endpoint cannot be used to find out which tokens
exist. A caller that got past that has already had to guess 256 bits.

## The origin rule

A submission has to come from one of the workspace's own hostnames:

- the final site, `finalHostname(slug)`;
- the preview it was claimed from, `previewHostname(claimed_preview_id)`, since
  a paid site and its preview both exist for a while and a form submitted from
  the preview of a claimed project is still this client's enquiry;
- any custom domain on `workspace_hosts`.

All three are derived rather than configured, and all three are `https` only: a
site we deploy is behind Caddy with a certificate, and an `http` origin claiming
to be that hostname is not it.

`Origin` is checked first, because a browser sets it on every cross-origin POST
and a page cannot talk it out of it. `Referer` is the fallback for the handful
of privacy setups that strip `Origin` on a form post, reduced to its origin so a
path can never widen what matched. Neither present is a refusal.

The CORS preflight answers with an allow header only for an origin that passed
the same rule. `Access-Control-Allow-Origin: *` would make every client's
endpoint callable from every page on the internet, which is the thing the rule
exists to stop.

## Rate limits

Per token, 10 a minute. Per IP, 20 a minute. Both, because the two abuses are
different: one scraped token hammered from a botnet is caught by the token, and
one host walking every token it can find is caught by the IP.

The count lives in Upstash Redis when `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` are both set, and in memory when they are not. An
unreachable Redis allows the request: a rate limiter that turns an outage of
itself into an outage of every client's contact form has picked the wrong thing
to protect.

## Spam

The classifier is the one that has always decided `new` from `spam`: two or more
of a short pattern list have to match before anything is filed as spam. Two,
not one, because a Romanian salon asking about a treatment uses the word "free"
and a real enquiry can carry a link.

Spam is stored, not dropped. The classifier is a handful of regular expressions
and it will be wrong about somebody's real customer eventually, so a client can
see the pile and find them. It is left out of every count, and it is never
emailed.

## What happens after a lead is stored

Nothing below this line can fail the request. The enquiry is already in the
client's workspace.

1. A `lead_captured` row goes into `project_events`, carrying the lead id, the
   status, the page and the origin.
2. The client gets one email, "New enquiry from your site", through
   `notifyClientOnce` keyed on the lead id, with the message in it and
   `Reply-To` set to the visitor, so hitting reply works. Spam sends nothing. A
   redelivery of the same lead sends nothing.

## What a client sees

On their project page, the **Enquiries** tile counts the last 30 days, says how
many are waiting for a reply, and links to the list.

`/dashboard/projects/{workspaceId}/enquiries/list` is every enquiry, newest
first, with spam behind a toggle that says how many it is hiding.

`/dashboard/projects/{workspaceId}/enquiries` is the contact form settings: the
token, the endpoint it belongs to, and **Rotate**.

Rotate asks first, and the question says what it costs, because it is the one
action on the page that breaks something that currently works:

> Rotating stops the old token working straight away. Your live site keeps
> sending the old one until it is published again, so enquiries will not arrive
> in between.

That is the honest behaviour. A rotation that left the old token working would
not be one. Rotation is for a token that got somewhere it should not have been,
and the fix is to rotate and then republish the site.

## The site side

The templates' contact form is progressive enhancement, in three layers:

1. **No JavaScript at all.** The form keeps a real `mailto:` action and the
   browser hands the message to the visitor's own mail client.
2. **The injected script.** A small inline script intercepts submit, posts the
   form as JSON, and shows the site's own success or failure copy, which lives
   in the template's `site-labels.md` rather than in the injector.
3. **The network fails.** The form is submitted natively, which is the mailto
   again. An enquiry is never silently dropped.

The script is injected by `injectLeadCapture` in
`packages/agentic-codegen/src/integrations.ts`, the same way `injectCalCom`
injects the booking embed, into a managed block marked
`data-flowstarter-lead-capture="true"`. Re-running the injector updates that
block in place, so a rotation or a preview-to-paid upgrade leaves one block, not
two.

`is:inline` on that script tag is load-bearing. A plain Astro `<script>` is
hoisted into `_astro/*.js` and disappears from the HTML, which would mean the
token never appears in the built page and no gate could ever prove it shipped.

It runs on the full build, the change-request build and the rebuild, and it runs
unconditionally, exactly like the booking injector and for the same reason: a
workspace whose token could not be resolved still needs any endpoint a previous
run left on the page taken back out.

The platform host comes from `resolvePlatformDomain()` in the build worker, so a
worker running against the dev zone cannot write a production endpoint into a
site because a queued row said so.

## Previews cannot send

A funnel preview belongs to nobody: there is no workspace behind it and
therefore no tenant a lead could belong to. It gets a token of the form
`preview.<previewId>`, and the endpoint refuses it with a 403 and a sentence the
form shows.

The dot is the load-bearing character. It is outside base64url, so the column's
check constraint refuses it, so no minted token can ever collide with a preview
token however unlucky the random bytes are. "Previews cannot send" is a fact
rather than a probability.

The alternative was a preview whose contact form silently did nothing when
clicked, which is how a visitor learns not to trust the rest of it.

## Tenancy

`leads` has RLS on with no grant for `anon` or `authenticated`: it is a
server-only table, and the tenant isolation lane proves that on every CI run.
Every read and every write in this feature goes through `withTenant`, so the
`workspace_id` filter is structural rather than remembered.

`workspaces.lead_capture_token` is readable by members of that workspace, which
is deliberate: the client is shown it on their own page and their own site
publishes it. A member cannot write it. Rotation goes through the API behind
`requireWorkspaceAccess`, which is what records who did it; the RLS proof
asserts that a member cannot rotate their own token straight through PostgREST
and bypass that ledger.

## Where the code is

| Thing                                                  | File                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Token, origin rule, body rules, spam, reads and writes | `apps/flowstarter-main/src/lib/flowstarter/lead-capture.ts`                                 |
| The preview token on the funnel path                   | `apps/flowstarter-main/src/lib/flowstarter/lead-capture-scaffold.ts`                        |
| The public endpoint                                    | `apps/flowstarter-main/src/app/api/leads/capture/[token]/route.ts`                          |
| Token and rotation API                                 | `apps/flowstarter-main/src/app/api/client/lead-capture/[workspaceId]/route.ts`              |
| Settings page and list page                            | `apps/flowstarter-main/src/app/(dynamic-pages)/dashboard/projects/[workspaceId]/enquiries/` |
| The injected script                                    | `packages/agentic-codegen/src/integrations.ts`                                              |
| Endpoint assembly for a build                          | `apps/build-worker/src/job-store.ts`                                                        |
| The form, the honeypot and the mailto fallback         | `apps/flowstarter-templates/*/src/components/contact/ContactFormPanel.astro`                |
| The slot the injector fills                            | `apps/flowstarter-templates/*/src/pages/contact.astro`                                      |
| Migration                                              | `supabase/migrations/20260912160000_workspaces_lead_capture_token.sql`                      |
