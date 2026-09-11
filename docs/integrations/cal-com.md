# Cal.com

Every workspace can connect its own Cal.com calendar. The link is embedded on
the site we build for that client, and the bookings taken through it are shown
back on their dashboard.

Nothing here is shared between clients. One workspace, one link, one signing
secret, one set of bookings.

## What a client does

1. Open the project, then **Bookings**, then **Booking settings**
   (`/dashboard/projects/{workspaceId}/booking`).
2. Paste the Cal.com link and save. Only `cal.com`, `www.cal.com` and
   `app.cal.com` links are accepted, and the stored value is always rewritten to
   `https://cal.com/handle` or `https://cal.com/handle/event`. Anything else is
   refused with a sentence saying which part was wrong.
3. A preview of the calendar appears under the form. That is the same embed the
   built site uses.
4. The page then shows a webhook URL and a signing secret. In Cal.com, open
   **Settings**, then **Developer**, then **Webhooks**, add a new webhook, paste
   the URL as the subscriber URL and the secret as the secret, and tick
   **Booking created**, **Booking rescheduled** and **Booking cancelled**.
5. **Disconnect** clears the link and the secret. Bookings already recorded stay
   where they are: they happened, and deleting a client's own history because
   they changed calendar tools would be the wrong default. Connecting again
   hands out a new secret, so the old webhook in Cal.com has to be updated.

The calendar works on the site from step 2. Steps 4 and 5 are only about whether
the bookings also appear on the dashboard.

## The webhook contract

```
POST /api/integrations/cal/{workspaceId}
X-Cal-Signature-256: <hex>
Content-Type: application/json
```

The signature is an HMAC-SHA256 of the exact request body, keyed with that
workspace's secret, in lower case hex. It is verified against the raw bytes,
never against a re-serialised copy of the parsed JSON.

Triggers handled: `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`.
Anything else is acknowledged with 200 and ignored, so Cal.com does not retry a
body that will never become handleable.

| Situation | Status |
| --- | --- |
| No signature header | 401, and no database query is made at all |
| Signature present, workspace id is not a uuid or has no workspace | 404 |
| Workspace has no calendar connected | 401 |
| Signature does not match the workspace's secret | 401 |
| Verified, and handled or deliberately ignored | 200 |
| Verified, but the lookup that precedes it failed | 503 |

The order matters. A caller with no signature gets the same 401 whatever id is
in the path, and nothing is read, so the endpoint cannot be used to find out
which workspaces exist. A caller that offers a signature has already had to
guess a v4 uuid, and telling Cal.com that a workspace is gone is how an operator
finds a stale webhook in their own settings screen.

Every refusal after the signature check returns 200. A non-2xx makes Cal.com
send the delivery again, and the one thing a retry must never do is count a
booking twice.

## Idempotency

Rows live in `workspace_bookings`, one row per booking, unique on
`(workspace_id, provider, external_uid)` where `external_uid` is Cal.com's
booking uid.

- A delivery for a uid with no row inserts one.
- A delivery whose status matches the stored one is a replay and changes
  nothing.
- A booking that was cancelled is never reopened by a late `BOOKING_CREATED`.
  Webhook order is not guaranteed, and the table is what the client reads.
- Anything else updates the existing row in place.

The unique index is the backstop for the case the read cannot see: two copies of
one delivery handled at the same moment. The loser of that race is treated as a
duplicate, not as an error.

## What the dashboard shows

The **Bookings** tile on the project page has three states:

- No link saved: `Not set up`, and a prompt to connect one.
- Connected with nothing ahead: `0`, and either how many there were in the last
  30 days or a line saying the calendar is connected and taking bookings. A
  connected calendar with nothing on it is not the same fact as a calendar
  nobody has hooked up.
- Connected with bookings ahead: the number coming up, the date of the next one,
  and the count for the last 30 days.

Cancelled bookings are left out of every count. They are still shown on the
list at `/dashboard/projects/{workspaceId}/booking/list`, muted and struck
through, upcoming above earlier, soonest first in each group.

## Emails

A `BOOKING_CREATED` that actually inserted a row sends the client one email,
"New booking on your site", through `notifyClientOnce` keyed on the booking uid.
A replay, a reschedule and a cancellation send nothing. When `RESEND_API_KEY` is
unset, no email is attempted and the webhook still returns 200.

## Tenancy

`workspace_bookings` has RLS on. Members of a workspace may read their own
rows and may not write any; the webhook writes with the service role after the
signature has been checked. The tenant isolation lane proves both halves on
every CI run, and `tenant-table-guard.mjs` fails if the table is ever dropped
from that proof.

The signing secret lives on `workspaces.cal_com_webhook_secret`. It is readable
by members of that workspace, which is deliberate: the client has to paste it
into Cal.com themselves. It is a shared secret between one tenant and one
endpoint, not a platform credential, and it never appears in a `project_events`
payload.

## Where the code is

| Thing | File |
| --- | --- |
| Which links are valid | `apps/flowstarter-main/src/lib/flowstarter/cal-link.ts` |
| Signature, payload and idempotency rules | `apps/flowstarter-main/src/lib/flowstarter/cal-webhook.ts` |
| Connect and disconnect | `apps/flowstarter-main/src/lib/flowstarter/cal-integration.ts` |
| Reading and writing bookings | `apps/flowstarter-main/src/lib/flowstarter/bookings-data.ts` |
| Counting and ordering bookings | `apps/flowstarter-main/src/lib/flowstarter/bookings.ts` |
| Inbound webhook | `apps/flowstarter-main/src/app/api/integrations/cal/[workspaceId]/route.ts` |
| Client settings API | `apps/flowstarter-main/src/app/api/client/booking/[workspaceId]/route.ts` |
| Migration | `supabase/migrations/20260911120000_workspace_bookings.sql` |

## The embed on the generated site

The site build reads the same `workspaces.cal_com_url` column, so the embed can
only ever carry a link that passed the rules above. Two paths write it, and both
are already conditional:

- `packages/agentic-codegen/src/integrations.ts` returns the file tree unchanged
  when the link does not parse, and emits a plain iframe pointing at Cal.com's
  documented no-JS embed route. It writes no script tag at all.
- `apps/flowstarter-library/templates/shared/dorin-ds/components/CalBookingBlock.astro`
  is the only file in the repo that loads `app.cal.com/embed/embed.js`, and the
  whole `<script>` is inside a `hasCal &&` guard.

One thing to know before touching that component: the `is:inline` directive on
that script is load-bearing. A plain Astro `<script>` is hoisted and bundled
into the page whatever conditional surrounds it, so dropping `is:inline` would
quietly make the embed loader unconditional again.
