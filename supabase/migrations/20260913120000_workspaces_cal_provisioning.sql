-- The booking page the platform made for a client, and whether it worked.
--
-- `cal_com_url` has existed since 20260831200000, but it could only ever hold
-- a link the client went and got for themselves. Most never did, so the
-- booking page on the site we built them was the one thing on it that did not
-- work. The platform now runs its own Cal.com and creates the client's
-- calendar for them on claim (see docs/operations/cal.md and
-- apps/flowstarter-main/src/lib/flowstarter/cal-provisioning.ts), writing the
-- resulting link into that same column — so nothing downstream changes.
--
-- These four columns are what that run leaves behind. They exist for two
-- readers:
--
--   - the provisioner, which must be idempotent. A rerun finds the Cal user by
--     email rather than trusting these, but `cal_provisioned_at` is what stops
--     it emailing the client a second time about a page they already have.
--   - the bookings tile, which says Provisioned, Not yet, or Failed with the
--     reason. `cal_provisioning_error` is the reason, in a sentence written for
--     the client; the operator's version of the same event, with the real
--     error, goes to `project_events` and the log.
--
-- The two id columns are integers because Cal's own primary keys are: they are
-- a foreign key into a database this product does not own, kept so an operator
-- can join what they see in the dashboard to what they see in Cal.
--
-- TENANCY. These sit on `workspaces` alongside `cal_com_url` and
-- `cal_com_webhook_secret`, which already only yields a row to a member of
-- that workspace. Nothing here is a platform credential: the link is public by
-- design, the ids are Cal's, and the error is the client's own news.

alter table public.workspaces
  add column if not exists cal_user_id integer,
  add column if not exists cal_event_type_id integer,
  add column if not exists cal_provisioned_at timestamptz,
  add column if not exists cal_provisioning_error text;

comment on column public.workspaces.cal_user_id is
  'Cal.com user id on the platform''s own instance, for the user provisioned for this workspace. Null when no booking page has been provisioned.';
comment on column public.workspaces.cal_event_type_id is
  'Cal.com event type id for this workspace''s intro call. Null when no booking page has been provisioned.';
comment on column public.workspaces.cal_provisioned_at is
  'When the booking page was first successfully provisioned. Also the guard that keeps the "your booking page is ready" email to one send.';
comment on column public.workspaces.cal_provisioning_error is
  'Why the last provisioning attempt failed, phrased for the client and shown on the bookings tile. Cleared by a run that succeeds.';

-- The operator's question is "which paid projects still have no booking page",
-- which is a scan of a small, partial set rather than of every workspace.
create index if not exists workspaces_cal_unprovisioned_idx
  on public.workspaces (created_at desc)
  where cal_provisioned_at is null;
