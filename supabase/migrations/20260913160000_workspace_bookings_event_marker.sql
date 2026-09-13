-- An ordering marker for `workspace_bookings`, so a write can be a
-- compare-and-set instead of a read-then-write.
--
-- Cal.com does not guarantee webhook delivery order. Before this column,
-- `recordCalBooking` decided whether a delivery was an update or a replay
-- from status and start/end time alone — which cannot tell a genuinely
-- later reschedule from an older one replayed after a newer one, because
-- both just look like "a different time than what's stored now". The
-- marker is Cal.com's own `updatedAt`/`createdAt` for the delivery, or the
-- time this server received it when the body carries neither (see
-- `CalBookingEvent.eventMarker` in apps/flowstarter-main). Comparing it is
-- what lets an older reschedule replay be recognised as stale and skipped
-- instead of applied as if it were a new change.
--
-- The column is also the compare-and-set predicate itself: application code
-- updates a row with `where event_marker < :incoming`, so a concurrent
-- delivery that already advanced the marker past this one causes the update
-- to match zero rows rather than silently overwriting newer state with
-- older. See `recordCalBooking` in
-- apps/flowstarter-main/src/lib/flowstarter/bookings-data.ts.

alter table public.workspace_bookings
  add column if not exists event_marker timestamptz;

-- Backfill from each row's own last-known update time — the best available
-- proxy for "when this state was last true" for rows written before this
-- column existed.
update public.workspace_bookings
  set event_marker = coalesce(updated_at, created_at, now())
  where event_marker is null;

alter table public.workspace_bookings
  alter column event_marker set not null;

-- A default for completeness (e.g. a manual insert outside the webhook
-- path); the webhook route always supplies its own marker explicitly.
alter table public.workspace_bookings
  alter column event_marker set default now();

comment on column public.workspace_bookings.event_marker is
  'Ordering marker for this booking''s last applied transition: Cal.com''s own updatedAt/createdAt for the delivery, or the time this server received it when the body carries neither. Writes are a compare-and-set against this column so an out-of-order or concurrent delivery cannot overwrite newer state with older.';
