# Stripe webhooks: retries, replay and reprocessing

The endpoint is `POST /api/webhooks/stripe`
(`apps/flowstarter-main/src/app/api/webhooks/stripe/route.ts`). Everything
below is about one promise it now keeps:

> **A 200 from this route means the state is in the database.**

Stripe treats any 2xx as final and never redelivers that event. Until
2026-09-12 the handlers awaited Supabase updates without reading `{ error }`,
so a failed write still fell through to `{ received: true }` — a paying
customer could stay marked unpaid, or keep a care-plan status that had already
moved on, with nothing but a log line and no retry. That is risk 2 in
`docs/quality/codex-review-2026-09-12.md`.

## What the route does with a delivery

1. **Verify the signature.** A body that does not verify gets 401 and is not
   recorded anywhere: a forged event cannot even consume an event id.
2. **Claim the event.** A row is written to `public.stripe_events` *before* any
   handler runs.
   - Row already exists with `processed_at` set → redelivery. Nothing runs,
     the response is `{ received: true, duplicate: true }`, 200.
   - Row already exists with `processed_at` null → a previous attempt died
     before it finished. Process it again and count the attempt.
   - No row → first delivery.
   - The ledger itself unreachable → **500**, nothing is processed.
3. **Check ordering** (subscription and invoice events). Stripe's delivery
   order is not the event order, so before applying anything the route asks the
   ledger for the newest event already applied to the same Stripe object:
   - this event is older → **refused**, outcome `superseded`, 200.
   - this event is newer → applied.
   - the same second — Stripe's `created` is whole seconds and cannot separate
     them → the object is **re-fetched from Stripe** and the fetched state is
     applied. A re-fetch that fails is a 500, not a guess.
4. **Check the money-state rules** (`src/lib/billing/money-state.ts`), against
   the workspace's current row. Deposit paid and final paid are monotonic; a
   care plan follows Stripe's subscription lifecycle and a cancelled
   subscription id is terminal; only an `accepted` change request may be moved
   to `paid`.
5. **Write**, reading `{ error }` on every write. Any error throws, and a throw
   anywhere in a handler is a **500** with the ledger row left unprocessed.
6. **Stamp the outcome** — `processed`, `ignored` or `superseded`, all of which
   set `processed_at` and answer 200. If the stamp itself fails the response is
   still 500: the state landed, but we cannot promise not to process it twice,
   and every handler converges on a second run.

`ignored` is a real, deliberate outcome: an event type this app does not act on
(`charge.refunded`, say), or metadata pointing at no workspace of ours. Those
answer 200 and are never retried.

## The ledger table

`public.stripe_events`, created by
`supabase/migrations/20260912163000_stripe_events.sql`:

| column | meaning |
| --- | --- |
| `id` | Stripe's event id (`evt_...`), primary key. This is the dedup. |
| `type` | `event.type` |
| `created` | `event.created`. The ordering key — never `received_at`. |
| `object_id` | `event.data.object.id`: the `sub_`/`in_`/`pi_`/`cs_` the event is about. Ordering is compared within this. |
| `received_at` | when we first saw it |
| `processed_at` | set only when a handler finished. Null means unprocessed. |
| `outcome` | `processed` \| `ignored` \| `superseded` \| `failed` |
| `attempts` | how many times Stripe has delivered this event id |
| `last_error` | the message from the attempt that failed |

It is **not tenant scoped**, on purpose: its key is Stripe's event id, a Stripe
object maps to a workspace only through the metadata the event carries, and
several event types (a booking deposit from an anonymous prospect, an invoice
for a workspace that was never created) have no workspace at all while still
needing a row so they are not reprocessed. It is classified server-only — RLS
on, zero policies, no grant for `anon` or `authenticated` — and that
classification is proved on every CI run by
`apps/flowstarter-main/scripts/verify-rls-local.mjs`.

## Reading the state of the world

Against the local stack (never a hosted project):

```sql
-- What is stuck: delivered, never processed.
select id, type, object_id, attempts, last_error, received_at
from stripe_events
where processed_at is null
order by received_at desc;

-- Everything Stripe has said about one subscription, in event order.
select id, type, created, outcome, processed_at
from stripe_events
where object_id = 'sub_123'
order by created;

-- Events Stripe keeps bringing back.
select id, type, attempts, last_error from stripe_events where attempts > 3;
```

An event with a climbing `attempts` and a `last_error` is one Stripe cannot get
us to accept. Fix the cause, then reprocess it.

## Reprocessing one event by id

Stripe will retry an unacknowledged event on its own schedule for about three
days. To force it sooner, or to re-run one we already acknowledged:

1. **From the Stripe dashboard** — Developers → Webhooks → the endpoint → the
   event → *Resend*. This is the normal route and needs no database access.
   Stripe sends the same event id, so the ledger decides what happens:
   an event stamped `processed` is skipped and answered 200.

2. **To actually re-run a processed event**, clear its stamp first, then
   resend:

   ```sql
   update stripe_events
      set processed_at = null, outcome = null, last_error = null
    where id = 'evt_123';
   ```

   Then resend from the dashboard, or with the CLI against a local app:

   ```bash
   stripe events resend evt_123 --webhook-endpoint we_456
   ```

   Only do this when the state the handler writes is genuinely wrong or
   missing. The handlers converge rather than double-charging — the build
   enqueue is guarded by unique constraints, a status write is idempotent, a
   change request settles only from `accepted` — but a cleared stamp also
   clears the ordering fence, so an old event can win a race it should have
   lost. Re-run the newest event for the object, not an old one.

3. **Replaying a run of events** (after an outage where the app answered 500
   for a while): resend them oldest first. The ordering guard is what makes a
   wrong order safe, not what makes it correct — oldest-first means each one
   applies rather than being refused as superseded.

## Local development

`stripe listen --forward-to localhost:3000/api/webhooks/stripe` prints a
`whsec_...` for `STRIPE_WEBHOOK_SECRET`. Test mode only, always. `stripe
trigger customer.subscription.updated` produces a real signed event; sending
the same one twice is the quickest way to see the duplicate branch answer
`{ received: true, duplicate: true }`.

The behaviour above is pinned by
`src/app/api/webhooks/stripe/__tests__/route.test.ts` (durability, idempotency
and ordering each have their own describe block),
`src/lib/billing/__tests__/money-state.test.ts` (the rules, exhaustively) and
`src/lib/billing/__tests__/stripe-events.test.ts` (the ledger). Stripe is
mocked throughout; no test talks to a Stripe account.
