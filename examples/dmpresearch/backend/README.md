# Database boundary

`schema.sql` is an opt-in reference bootstrap, not a product migration. It uses
separate `dmpresearch_` objects and does not modify the current application's
Clerk/workspace policies. In a product integration, reuse the existing workspace
and membership records instead of maintaining a second authorization directory.

Run the isolation test against the existing **local** Supabase Docker stack:

```sh
bash examples/dmpresearch/backend/test-local.sh
```

It creates and exercises the schema in one transaction and rolls everything back.
Run it before applying the bootstrap; it intentionally refuses to overwrite an
existing schema. To keep the example schema locally:

The product's `tenant-table-guard.mjs` inventories every `public` table with a
tenant key. Persisting this example adds an unregistered table and makes that
guard fail. Prefer the rolled-back test on the shared development stack. Before
keeping this schema as a product feature, register and prove its access model in
the product's tenant verifier; do not weaken the guard to hide the table. The
following command is therefore only for deliberate standalone exploration:

```sh
docker exec -i supabase_db_flowstarter psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 < examples/dmpresearch/backend/schema.sql
```

Trusted provisioning creates the tenant and grants a known, verified identity
membership. Replace the subject with the existing Supabase Auth user's UUID as
text (or the verified Clerk JWT `sub` when integrating Clerk):

For the standalone form, create the local user through local Supabase Studio's
Authentication user management and copy its ID. The client sets
`shouldCreateUser: false`, so sending a code never creates a customer or grants
membership. Configure the local Auth email template for magic-link sign-in to
include `{{ .Token }}`; the form verifies the numeric code rather than following
a magic link. Read development emails in the local mail catcher. Configure real
mail delivery and Auth rate limits before exposing this flow to customers.

Run the provisioning SQL as a trusted local database administrator:

```sql
insert into dmpresearch_private.workspaces (id, name)
values ('11111111-1111-4111-8111-111111111111', 'dmpresearch');
insert into dmpresearch_private.memberships (workspace_id, subject)
values ('11111111-1111-4111-8111-111111111111', '<verified-user-sub>');
```

The static client sends the publishable key, a verified user access token, and
`x-tenant-id: PUBLIC_TENANT_ID`. It inserts only `workspace_id`, `name`, `email`,
and `message` into `dmpresearch_submissions`. PostgREST verifies the JWT before
setting `auth.jwt()`; the database assigns `created_by`. The public header and
row ID must agree, but **membership is the authority**. A forged header, a
changed payload, or user-editable JWT metadata cannot grant access. Reads require
the same membership/context and are limited to the author's own submissions.
Deleting membership immediately removes access even with an unexpired token.

This example intentionally implements an invited client portal: signed-out
visitors cannot insert. A public contact form is a different access model.
The platform already has `/api/leads/capture`; review and harden that shared
endpoint before integrating it. It currently uses a process-local rate limiter,
accepts extra JSON, and has no CAPTCHA or public-intake enablement check. Do
not claim that a public UUID, CORS, or an Origin header authenticates a tenant.
A public endpoint necessarily accepts submissions addressed to any published
business; owner-only reads still require verified identity and membership.
If that endpoint uses a service role, it bypasses RLS and must explicitly scope
every write. Never ship a service role/secret key to static builds.

The SQL tests simulate PostgREST's verified role/claims inside local PostgreSQL.
They prove database policies and grants, not JWT verification, email delivery,
or HTTP gateway configuration. The private schema must stay outside the Data
API's exposed schemas. The form deliberately has no business-wide inbox policy;
add a separate explicit owner role if an operator inbox is needed.

References: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
and [Clerk third-party auth](https://supabase.com/docs/guides/auth/third-party/clerk).
