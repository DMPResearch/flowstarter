# dmpresearch: static tenant sites, shared data

This is an executable reference architecture, outside the pnpm workspace. Each
tenant gets an independently built Astro image; the browser communicates directly
with the shared Supabase API. There is no Node process or database credential in
the serving container. The sample request flow is for **pre-provisioned, signed-in
customers**. It deliberately does not accept anonymous database inserts.

## Fit with the current repository

The existing product is Next.js with Clerk and workspace-scoped Supabase data.
`apps/flowstarter-main/src/lib/tenancy.ts` supplies application query scoping;
database migrations supply membership-based RLS. The build worker uses a service
role and must filter every workspace query explicitly.

The current generation pipeline in
`packages/agentic-codegen/src/flowstarter/workflows.ts` obtains an Astro scaffold
from the template library and validates generated changes. The worker packages
static output; `apps/deploy-agent/src/index.ts` extracts artifacts and writes
host Caddy snippets. That is shared host file serving, rather than one serving
container per tenant. This reference adds the requested container model without
changing that production contract or patching generated output.

For adoption, register the starter as a source template, keep schema validation
in the deterministic build gate, and extend the trusted deployment adapter to
build/tag/run this image and update the verified domain's edge route. Continue
using the existing workspace UUID as tenant identity. Do not automatically copy
the sample customer membership table into the platform's staff memberships:
customers and operators have different permissions. Clerk integration must send
a JWT accepted by Supabase; the standalone example uses Supabase email OTP.
That adapter work includes registry credentials, container lifecycle management,
a tenant port allocator, per-tenant build configuration and image garbage
collection. None of those capabilities is added to the existing deploy agent by
this reference. The example is also outside the current CI and dependency-update
configuration; wire its tests and dependency maintenance into those systems when
adopting it.

```text
trusted metadata + reviewed MDX + public build arguments
                    |
             Astro validation/build
                    |
             immutable tenant image
                    |
Internet -> host Caddy (TLS) -> tenant Caddy (static HTML/assets)
                                  |
                         browser loads Supabase SDK
                                  |
                    shared Supabase Auth + Data API
                                  |
                      PostgreSQL grants + RLS
```

## Files

```text
backend/             SQL schema, provisioning instructions and isolation tests
site/
  astro.config.mjs   static output and MDX integration
  src/               content collection, validated metadata, native form
  package-lock.json  standalone, reproducible npm dependency resolution
Dockerfile           Node build stage, Caddy serving stage
compose.yaml         one restricted container per tenant
deploy/Caddyfile     static serving and cache rules
deploy/edge.Caddyfile  host-level domain routing example
```

## Tenant isolation

Store all submissions in one table, with a non-null `workspace_id` on every row.
Index tenant/owner lookup paths. Explicit grants determine which operations a
browser can attempt; RLS determines which rows those operations can affect.

The browser supplies `x-tenant-id` alongside the submission's `workspace_id`.
Neither value is trusted. The database requires both to match, checks the
verified JWT subject against a live private membership table, and requires the
row's `created_by` to match that subject. Reads are limited to that customer's
own submissions. Anonymous reads/inserts and client updates/deletes are denied.
The backend SQL contains the complete policies and a fixed-search-path helper.

A public build variable, `Origin`, or custom header alone cannot prove tenant
authorization. Everyone can inspect the public bundle and replay a request with
another tenant ID. User-editable JWT metadata must not decide access. Membership
revocation takes effect on the next database request without waiting for a token
refresh. Service roles bypass RLS, so retain manual tenant filters in workers.

The platform already has public intake at
`apps/flowstarter-main/src/app/api/leads/capture/route.ts`. It resolves a workspace,
inserts into `leads` with a service role, and sends a best-effort notification.
Before adopting it for this flow, address its process-local rate limiter, missing
CAPTCHA verification, unbounded extra JSON fields and lack of an explicit public
intake enablement check. Do not create a competing endpoint without reviewing
that existing contract. Public intake must explicitly assign the tenant to its
insert; it does not prove that the visitor belongs to the tenant. Keep reads
protected by membership. This reference does not integrate that endpoint or
enable anonymous table access.

## Content generation boundary

Astro's content collection validates generated business identity and design
choices before emitting HTML. Constrain design choices with enums and bounded
strings, rather than accepting raw CSS or arbitrary component names. Invalid
metadata must fail `npm run build` and must never reach an image release.

MDX compiles component-driven content to static HTML; dynamic content generation
happens at build time. MDX is executable code: metadata validation is **not** a
sandbox for arbitrary AI-generated imports or expressions. Keep component/layout
MDX trusted and feed AI output through the strict metadata schema. Run builds in
an isolated builder without deployment credentials, privileged mounts, or access
to the Docker socket. The native form adds only the SDK/client script, with no
hydrated UI framework.

## Run locally

1. Use the repository's local Supabase stack at `127.0.0.1:54321`. Follow
   [backend/README.md](backend/README.md) to apply the reference schema and
   provision a local user and customer membership. Configure email OTP as
   described there; a membership is required in addition to successful login.
2. From this directory, copy `.env.example` to `.env`, insert the **local public**
   publishable key (or legacy anon key), and use the same tenant UUID in the
   membership and build arguments. Never use a privileged key.
3. Build and run the tenant:

   ```sh
   docker compose --project-name dmpresearch-tenant-a build
   docker compose --project-name dmpresearch-tenant-a up -d --no-build
   curl --fail http://127.0.0.1:8088/
   node deploy/smoke.mjs http://127.0.0.1:8088
   docker compose --project-name dmpresearch-tenant-a stats --no-stream
   ```

   Open `http://127.0.0.1:8088` in a browser. The Supabase URL is resolved by the
   browser, so local loopback works here even though the site runs in Docker.
   No backend access is required during static compilation.

4. To stop just this reference:

   ```sh
   docker compose --project-name dmpresearch-tenant-a down
   ```

For frontend iteration, use `npm ci` inside `site`, copy the three public
variables into `site/.env`, then run `npm run dev`. The parent Compose `.env` is
not automatically loaded by Astro. Run `npm test` and `npm run build` there to
validate changes.

## Automated release boundary

The trusted orchestrator assigns a tenant UUID, a unique loopback port and a
release ID (for example, a commit SHA), validates the tenant's domain ownership,
then runs the same Compose build and start commands with a separate project name
and env file per tenant. It must check image/HTTP readiness before changing the
edge route. Do not accept arbitrary shell commands, paths, image names or Caddy
configuration from generated content.

Only host Caddy binds public ports 80/443. Import a route like
`deploy/edge.Caddyfile`, validate the complete host configuration, and reload
Caddy after the new container passes its HTTP smoke check. The supplied route
assumes Caddy runs on the host; containerized edge Caddy needs a private Docker
network instead of the host's loopback address. Preserve the edge's TLS data.
Use a browser-reachable HTTPS Supabase endpoint when deploying a HTTPS site;
local development and validation here only touch the local stack.

The simple `compose up` replaces one tenant container and can have brief
downtime. For uninterrupted releases, start the new release on a spare port,
smoke-test it, switch the edge route, then stop the old container. Keep the old
image/port for rollback until the release is accepted. Changing public build
values requires rebuilding the image; runtime `environment:` cannot change an
already compiled bundle. Use immutable tags and pin base image digests in the
release system; update those digests through normal dependency maintenance.

## Resource expectations

The final stage copies only `dist` from the builder, plus Caddy configuration.
It has no npm dependencies, source MDX, SSR process, scheduler or health polling
loop. It runs as UID 10001 on port 8080, with a read-only root filesystem,
dropped capabilities, bounded logs, and small tmpfs mounts. Compose caps memory
at 64 MiB and CPU at half a core; tune these after representative load tests.

Caddy serves hashed assets with immutable caching and asks browsers to revalidate
HTML. Unknown paths return 404 rather than an SPA fallback. Compression consumes
CPU only while serving requests. Idle CPU should be negligible and may display
0.00%, but exact zero CPU and a fixed RAM footprint cannot be guaranteed: runtime
maintenance, connections and monitoring still cost resources. One process per
tenant also costs more memory than the repository's shared host Caddy model.

## References

Validation performed locally: database isolation assertions passed inside a
rolled-back transaction; nine schema/config tests passed; Astro check reported
zero diagnostics; the multi-stage image built and served successfully as UID
10001 with all capabilities dropped. The HTTP smoke checked the page, script,
cache/security headers and 404 handling. One Docker sample measured 11.9 MiB RAM
and 0.05% CPU, not a capacity guarantee. The smoke image used a dummy public key;
email delivery and a browser-to-Auth-to-database submission were not exercised.
Provision a local identity and test that flow before deployment.

- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Astro content collections](https://docs.astro.build/en/guides/content-collections/)
- [Astro MDX](https://docs.astro.build/en/guides/integrations-guide/mdx/)
- [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Docker build variables](https://docs.docker.com/build/building/variables/)
- [Caddy static file serving](https://caddyserver.com/docs/caddyfile/directives/file_server)
