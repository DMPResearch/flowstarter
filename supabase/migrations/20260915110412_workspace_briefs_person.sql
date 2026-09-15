-- Who the client actually is, and what they actually do.
--
-- A portfolio shipped on 2026-09-15 with a stock graph for a hero, studio
-- copy nobody wrote, an empty box captioned "A photograph of me will follow
-- here", and the platform's own name where the client's should have been.
-- Nothing had failed. Every gate passed, because nothing in the funnel, the
-- brief, the builder or the gates had ever asked who the person was: this
-- table held an offer, a project list and a set of file ids, and none of
-- those is a person.
--
-- The whole section is one jsonb column rather than a dozen text columns for
-- the reason `projects` is one: it is a single form section, written and read
-- as a whole by one route, and the shape is defined and defensively parsed in
-- exactly one place (`packages/agentic-codegen/src/flowstarter/person.ts`,
-- `parsePerson`). A column per question would put the schema in two places
-- and guarantee they drift.
--
-- NULL IS LOAD-BEARING. Null means nobody was ever asked, which is every
-- workspace taken before today; the `PERSON_ABSENT` gate stays silent for
-- those and the readiness rule does not block them. A stored object whose
-- fields are all empty is the different, stricter answer "asked, and they
-- skipped it". The two must never collapse into each other, which is why
-- there is no default of `'{}'::jsonb` here.
--
-- Everything inside is the client's own words. Nothing in this column is ever
-- generated, and `sourcedBio` in particular holds a quotation read from a
-- page the client pointed us at, with the URL it came from and the instant
-- they approved it. Until `adoptedAt` is set it is a proposal on a form and
-- may not be published.

alter table public.workspace_briefs
  add column if not exists person jsonb;

comment on column public.workspace_briefs.person is
  'Who the client is and what they do, in their own words: name, headline, story, howIWork, values, feel, toneWords, links, proudestWork, activity and an optional sourcedBio with its provenance. Parsed by parsePerson in packages/agentic-codegen/src/flowstarter/person.ts. NULL means the question was never asked (every brief taken before 2026-09-15); an object with empty fields means the client was asked and skipped. The readiness rule and the PERSON_ABSENT build gate both read that difference, so do not default this column.';

-- The defining migration grants SELECT to `authenticated` on an explicit
-- column list rather than the whole row, so a column added since is invisible
-- to a member until it is granted here too.
grant select (person) on table public.workspace_briefs to authenticated;
