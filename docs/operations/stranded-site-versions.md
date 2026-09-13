# Stranded site versions

A `site_versions` row with `published_at` null that no change request and no
deploy points at. It is a finished, gate-clean build of what a client paid for,
and nothing in the product will ever show it to them.

They cannot be created any more. `CHANGE_REQUEST_BUILD` now commits before it
saves the version, and rolls the version back if anything after the save
throws (`packages/agentic-codegen/src/flowstarter/workflows.ts`,
`SupabaseFullSiteBuildJobStore.discardChangeRequestVersion`). This page is for
the ones that already exist.

## The one that exists

| Field      | Value                                                              |
| ---------- | ------------------------------------------------------------------ |
| Workspace  | `c009105e-f8ec-42bf-bdcf-cf92bb500f45`                             |
| Version    | 5 — 94 files, `published_at` null                                  |
| Summary    | `Paid change request 3227fa2b-2b82-4b37-b6ab-71c5dc3441fd`         |
| Created by | `system:change_request_build:b52b241f-686b-4871-bc64-21cf61fb5f79` |
| Written    | 2026-09-13, at the end of the third change-request run             |

Every gate passed and the version was saved; the commit step after it refused
`build: apply paid change request to site …`, because the commit policy held
two shapes and three kinds of build emitted one.

The live site is still version 10 of `deployments`, and request `3227fa2b` is
still `paid` with `built_version` null. Nothing about that is wrong: the
product's own rule is that a request reads `done` only for work that shipped.

**Neither script below has been run.** Version 5 is the Riverside removal
Darius paid for, built clean, and it may be worth publishing rather than
deleting. That is his call, not a migration's.

## Finding them

Read-only. Run it first, whichever option you then pick.

```sql
-- Every unpublished change-request version with no request pointing at it.
select
  v.workspace_id,
  v.version,
  v.summary,
  v.created_by,
  v.created_at,
  jsonb_array_length(coalesce(v.manifest -> 'files', '[]'::jsonb)) as files,
  (select max(d.version) from public.deployments d
    where d.workspace_id = v.workspace_id and d.status = 'live') as live_version
from public.site_versions v
where v.published_at is null
  and v.created_by like 'system:change_request_build:%'
  and not exists (
    select 1 from public.flowstarter_change_requests r
    where r.workspace_id = v.workspace_id and r.built_version = v.version
  )
order by v.workspace_id, v.version;
```

## Option A — publish it

The honest way is to let a fixed build produce it again: re-dispatch job
`b52b241f-…` from the operator board now that the commit policy knows about
change requests. The build reruns, saves version 6, publishes it, deploys it,
and moves the request `paid -> done` with the version on it — every row the
product depends on gets written by the code that is supposed to write it.

Publishing version 5 by hand does **not** do that. It would leave the request
at `paid` and `built_version` null, so the client's dashboard would show a
change they can see on their site as still outstanding. Only do this if the
rebuild is impossible, and do the second statement in the same transaction:

```sql
-- One workspace, one version. Set them and read them back before committing.
begin;

\set workspace_id 'c009105e-f8ec-42bf-bdcf-cf92bb500f45'
\set site_version 5
\set change_request_id '3227fa2b-2b82-4b37-b6ab-71c5dc3441fd'

-- Exactly one version may be published at a time, the same invariant
-- `markChangeRequestBuilt` keeps.
update public.site_versions
   set published_at = null
 where workspace_id = :'workspace_id'
   and published_at is not null;

update public.site_versions
   set published_at = now()
 where workspace_id = :'workspace_id'
   and version = :site_version
   and published_at is null;

update public.flowstarter_change_requests
   set status = 'done',
       built_version = :site_version,
       completed_via = 'build',
       completed_at = now(),
       updated_at = now()
 where id = :'change_request_id'
   and workspace_id = :'workspace_id'
   and status = 'paid';

-- The deploy is a separate, later step: publishing a version does not put
-- files on the host. Ship it through the deploy route, never by hand.
select version, published_at from public.site_versions
 where workspace_id = :'workspace_id' order by version;

commit;
```

## Option B — remove it

Only when the rebuild has already produced a newer version of the same change,
so the stranded row is a duplicate rather than the only copy.

```sql
begin;

\set workspace_id 'c009105e-f8ec-42bf-bdcf-cf92bb500f45'
\set site_version 5
\set job_id 'b52b241f-686b-4871-bc64-21cf61fb5f79'

-- The same four guards the worker's own rollback uses: the workspace, the
-- version, the job that wrote it, and still unpublished. A published version
-- or another job's matches none of them and nothing is deleted.
delete from public.site_versions
 where workspace_id = :'workspace_id'
   and version = :site_version
   and created_by = 'system:change_request_build:' || :'job_id'
   and published_at is null;

-- `flowstarter_project_artifacts.preview_manifest` mirrors the newest version
-- and is what the worker seeds the next build from, so put it back.
update public.flowstarter_project_artifacts a
   set preview_manifest = v.manifest,
       updated_at = now()
  from (
    select manifest from public.site_versions
     where workspace_id = :'workspace_id'
     order by version desc limit 1
  ) v
 where a.workspace_id = :'workspace_id';

select version, published_at from public.site_versions
 where workspace_id = :'workspace_id' order by version;

commit;
```

Run either against the workspace's own database — the CLI stack for a dev or
staging workspace, the hosted project for a production one — with
`ON_ERROR_STOP=1`, inside the transaction shown, and read the final `select`
before you commit.
