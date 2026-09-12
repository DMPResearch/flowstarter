# Connect an existing Hetzner host

The installer adds Flowstarter's deployment services to an existing Ubuntu host
with Docker and Caddy. It does not provision another VM or deploy a customer site.
Existing platform Caddy snippets are preserved.

1. From the repository root, build the Linux binary:

   ```sh
   bun build apps/deploy-agent/src/index.ts --compile --target=bun-linux-x64 --outfile flowstarter-deploy-agent
   ```

   Use `bun-linux-arm64` for an ARM host.

2. Prepare two root-readable environment files with distinct random
   `DEPLOY_AGENT_SHARED_SECRET` values. Both use
   `DEPLOY_AGENT_SITE_RUNTIME=docker` and
   `DEPLOY_AGENT_BIND_ADDRESS=127.0.0.1`.

   The two agents serve two different hostname families and neither one may
   serve the other's. A final site is what a client paid for: permanent,
   indexed, named after their workspace. A preview is temporary, unguessable,
   noindexed and deleted on a schedule.

   The paid agent listens on 8443 and needs the final hostname template. Without
   it the agent writes an empty Caddy snippet for a workspace that has no custom
   domain, which is a deploy that reports success and a site nobody can open:

   ```dotenv
   DEPLOY_AGENT_SITE_DOMAIN_TEMPLATE={slug}.example.com
   ```

   The preview agent listens on 8444 and additionally uses:

   ```dotenv
   DEPLOY_AGENT_MODE=previews
   DEPLOY_AGENT_PORT=8444
   DEPLOY_AGENT_SITES_ROOT=/var/www/previews
   DEPLOY_AGENT_CADDY_SITES_DIR=/etc/caddy/previews/sites
   DEPLOY_AGENT_CADDY_RELOAD_CMD=systemctl reload caddy-previews
   DEPLOY_AGENT_TEMP_ROOT=/tmp/flowstarter-preview-deploys
   DEPLOY_AGENT_SITE_PORT=9080
   DEPLOY_AGENT_PREVIEW_HOST_SUFFIX=preview.example.com
   ```

3. Copy the binary, `deploy-agent.env`, `preview-deploy-agent.env`, and
   `scripts/install-existing-host-agent.sh` to a private directory on the host.
   Run the installer as root with that directory and the preview suffix as its
   two arguments. It validates Caddy before reloading and starts both agents.

   If the host's base Caddyfile already carries an `on_demand_tls` block, the
   installer checks whether it is the platform's own policy, the one
   cloud-init writes into every host it provisions with previews enabled,
   identified by a marker comment next to the directive. When it is, the
   installer integrates with it instead of adding a second one, so this
   script also works on hosts the platform already provisioned, for example
   to push a new agent binary onto one. When the on-demand policy is foreign,
   the installer still aborts with a message that says how to merge the two
   by hand before re-running it.

4. Point a DNS-only wildcard A record, `*.preview.example.com`, at the host for
   previews. Final site names are **not** a wildcard: the app writes one A
   record per site, `{slug}.example.com`, at deploy time, and refuses to
   overwrite a record that already points somewhere else.

   Caddy issues certificates only after the relevant agent's `/tls-ask`
   endpoint confirms it owns the requested hostname. Each agent answers only
   for names its own templates produce and that have a snippet on disk, so the
   paid agent answers for `{slug}.example.com` and the preview agent answers
   for `{slug}.preview.example.com`.

5. Configure Flowstarter's server-only `FLOWSTARTER_EXISTING_HOST_ID`,
   `FLOWSTARTER_EXISTING_HOST_AGENT_URL`, and
   `FLOWSTARTER_EXISTING_HOST_SECRET_REF`. The last value names another
   server-only environment variable containing the paid agent's bearer token.
   Use **Connect existing server** in the admin hosting page.

For a local development app, forward local ports to remote loopback ports 8443
and 8444 through SSH. Keep the database local. Configure
`FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL`,
`FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET`, and
`FLOWSTARTER_PREVIEW_DOMAIN_SUFFIX` separately from the paid agent. Use
`FLOWSTARTER_PREVIEW_ARTIFACT_TRANSPORT=bytes` when the remote server cannot fetch
the local database's signed Storage URLs.

The normal Flowstarter preview flow compiles the site before publication. The
deployment agent receives static assets, wraps them in its trusted Caddy image,
checks the new container, then changes routing. Generated source and tenant
Dockerfiles are not runtime build instructions.
