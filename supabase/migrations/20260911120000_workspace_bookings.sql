-- Bookings made on a client's own site, as rows this product can count.
--
-- Until now the whole of the Cal.com integration was one column,
-- `workspaces.cal_com_url`, and the dashboard could only say "Connected" or
-- "Not set up". A client who had taken nine bookings that week saw the same
-- word as a client who had taken none, which is a tile that costs a grid slot
-- and returns nothing.
--
-- Cal.com will post BOOKING_CREATED, BOOKING_RESCHEDULED and BOOKING_CANCELLED
-- to `/api/integrations/cal/{workspaceId}`, signed with a secret that belongs
-- to that one workspace. Each delivery lands here.
--
-- ONE ROW PER BOOKING, not one per delivery. The unique index below is the
-- idempotency key: Cal.com retries, and a retry that inserted a second row
-- would show the client a booking they do not have. A reschedule moves the
-- times on the row; a cancellation moves the status. The full body of the last
-- delivery is kept in `payload` so an operator can read what actually arrived
-- without us having guessed in advance which field would matter.
--
-- TENANCY. Members read their own workspace's bookings and nothing else. Only
-- the service role writes, which is what the webhook route uses after it has
-- verified the signature. `scripts/verify-rls-local.mjs` proves both halves
-- against a real Postgres on every CI run.

create table if not exists public.workspace_bookings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null default 'cal.com' check (provider in ('cal.com')),
  -- Cal.com's own booking uid, as it appears in `payload.uid`.
  external_uid text not null,
  -- The event type booked, e.g. `intro` or `30min`. Null when the body did
  -- not name one, which a malformed or future payload shape may do.
  event_type_slug text,
  title text,
  start_at timestamptz,
  end_at timestamptz,
  attendee_name text,
  attendee_email text,
  status text not null default 'booked'
    check (status in ('booked', 'rescheduled', 'cancelled')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The idempotency key. A redelivered webhook finds the row instead of making
-- a second one, and the provider is in the key so a second booking tool added
-- later cannot collide with Cal.com's uid space.
create unique index if not exists workspace_bookings_external_uid_idx
  on public.workspace_bookings (workspace_id, provider, external_uid);

-- The dashboard's two reads: the list, newest start first, and the upcoming
-- count, which filters out cancellations.
create index if not exists workspace_bookings_workspace_start_idx
  on public.workspace_bookings (workspace_id, start_at desc);

create index if not exists workspace_bookings_upcoming_idx
  on public.workspace_bookings (workspace_id, start_at)
  where status <> 'cancelled';

alter table public.workspace_bookings enable row level security;

drop policy if exists workspace_bookings_select_members on public.workspace_bookings;
create policy workspace_bookings_select_members
  on public.workspace_bookings for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- No insert, update or delete policy exists, and that absence is the deny: a
-- client may read what was booked with them and may not write it. The webhook
-- writes with the service role, which bypasses RLS.
revoke all on table public.workspace_bookings from anon, authenticated;
grant select on table public.workspace_bookings to authenticated;
grant all on table public.workspace_bookings to service_role;

comment on table public.workspace_bookings is
  'Bookings made through a workspace''s Cal.com calendar, one row per booking, written only by the signed Cal.com webhook.';
comment on column public.workspace_bookings.external_uid is
  'Cal.com booking uid. Unique per workspace and provider, which is what makes a redelivered webhook a no-op.';
comment on column public.workspace_bookings.payload is
  'The last webhook body verbatim, so an operator can see what arrived without us having chosen the fields in advance.';

-- ─── The secret Cal.com signs with ─────────────────────────────────────────
--
-- One per workspace, generated when the client connects their calendar and
-- shown to them so they can paste it into Cal.com's webhook settings. It lives
-- on `workspaces` rather than in a server-only table on purpose: the client is
-- meant to read it, it is theirs, and `workspaces` already only yields a row
-- to a member of that workspace. It is a shared secret between one tenant and
-- one webhook endpoint, not a platform credential.

alter table public.workspaces
  add column if not exists cal_com_webhook_secret text;

comment on column public.workspaces.cal_com_webhook_secret is
  'Per-workspace HMAC-SHA256 secret for the Cal.com webhook at /api/integrations/cal/{id}. Generated on connect, shown to the client, null when no calendar is connected.';
