-- ASSET_CAPTIONS: the column PR #119's fix could only paper over.
--
-- `original_name` (20260913121000) stopped the operator's change-request
-- picker from showing a sha256, but it could only ever fall back to a
-- filename, dimensions and a date -- because nothing wrote `assets.caption`.
-- The column has existed since the foundation migration and every downstream
-- reader (`changeRequestAssetLabel`, `describeBriefInput`, the change-request
-- build prompt) already treats it as the truth about what a picture shows.
-- The truth was just never recorded.
--
-- The night that caught up with us: workspace c009105e, job c8f48c1e. Six
-- client uploads with no caption showed as six identical "Untitled picture,
-- 1200x750, 12 Sep 2026" lines in the picker -- indistinguishable to the
-- operator ticking boxes -- and the build agent, correctly forbidden from
-- inventing what an uncaptioned file depicts, placed two screenshots on the
-- wrong case study under a caption it made up. The site said something untrue
-- about a client's business.
--
-- The fix is at the source: every client upload gets asked for a caption, and
-- an uncaptioned one gets a bounded vision-model guess instead of a blank.
-- Both need a place to land, and they are not the same fact:
--
--   caption          the one sentence every downstream reader already uses.
--                     Either the client's own words, or (until a client
--                     confirms or edits it) the model's guess at a subject.
--   caption_source    'client' or 'auto' -- who is answerable for `caption`
--                      being right. A client confirming or editing an
--                      auto-caption, unchanged or not, flips this to
--                      'client': the whole point is that a human looked at
--                      it and stood behind it.
--   auto_caption      the model's full structured guess, kept even after a
--                     client overwrites `caption`, so the placement rule and
--                     its gate (packages/agentic-codegen) have something
--                     other than prose to check a build against: what kind of
--                     picture it is, whether it shows a person, any visible
--                     product or company name, and its dominant colours.
--                     Null whenever no caption was ever produced -- the
--                     column is never a fabricated guess dressed as a fact.
--
-- `caption` stays free text with no new constraint: a client's own sentence
-- about their own picture is not something a check constraint gets to grade.
alter table public.assets
  add column if not exists caption_source text
    check (caption_source in ('client', 'auto')),
  add column if not exists auto_caption jsonb;

comment on column public.assets.caption is
  'What the picture shows, in one sentence: the client''s own words, or (until confirmed or edited) an auto-caption''s guess. Never invented past what caption_source admits to.';
comment on column public.assets.caption_source is
  '''client'' when a human typed or confirmed this caption; ''auto'' when it is still only the vision call''s guess, unconfirmed. Null before any caption exists. A client confirming or editing an auto-caption sets this to ''client'' -- the record of a human standing behind it.';
comment on column public.assets.auto_caption is
  'The bounded vision call''s full structured guess -- {subject, kind, showsPerson, visibleName, dominantColors} -- kept even after caption_source becomes ''client'' so the change-request placement gate has more than prose to check a build against. Null when no auto-caption was ever produced, including every fail-closed error path in asset-caption.ts.';

-- No RLS or grant change: `caption`/`caption_source`/`auto_caption` are
-- ordinary columns on a table already granted `select` on the whole row to
-- `authenticated` (20260829090100) and already writable only through the
-- service-role routes under apps/flowstarter-main/src/app/api/client/assets/
-- -- the same posture `original_name` landed under, for the same reason: a
-- client may read every column of their own asset, but a caption is not
-- self-attested by an UPDATE grant, it is set by a route that checks whose
-- workspace the row belongs to first.
