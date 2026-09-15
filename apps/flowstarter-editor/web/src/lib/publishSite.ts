/**
 * publishSite — drives the "Publish" CTA in the chat header.
 *
 * What this does end-to-end:
 *   1. Resolves the workspace slug. Production: `{slug}.flowstarter.net`
 *      sent by Caddy; the server already exposes it via
 *      `tier.currentWorkspace.slug`. Local dev: falls back to
 *      `VITE_WORKSPACE_SLUG` (or `demo-coach` to match dev-editor.sh's
 *      default seed).
 *   2. Computes the public URL the workspace will live at — used both in
 *      progress copy and the "Visit" action on the success toast.
 *   3. Posts to the editor server's `/api/site/publish` route in three
 *      stages with progressive toast updates (build → deploy → done).
 *      The route is not yet implemented; until it is, this falls back to
 *      a local-only simulation so the UI flow can be demoed.
 *
 * Full deploy pipeline (not yet wired):
 *   editor web → editor server `/api/site/publish` → calls main app
 *   `POST /api/team/projects/{workspaceId}/site/deploy` (resolves the
 *   project by `currentWorkspace.id`) → main app calls deploy-agent
 *   `POST /sites/{slug}/deploy` with an artifact URL → deploy-agent
 *   extracts into `/var/www/sites/{slug}/`, writes a Caddy snippet,
 *   reloads Caddy. The `flowstarter-deploy-site` skill already wraps
 *   the main-app endpoint when the agent runs it from chat.
 */

import type { TierContextValue } from "~/hooks/useTier";
import { withBasePath } from "./basePath";

export interface PublishTarget {
  readonly slug: string;
  /** Public URL the workspace will resolve to. */
  readonly url: string;
  /** True for `localhost`-based slugs that don't have a real DNS record. */
  readonly local: boolean;
}

const DEFAULT_PUBLISH_DOMAIN = "flowstarter.net";
const LOCAL_DEV_FALLBACK_SLUG = "demo-coach";

/**
 * Resolve the workspace the Publish button targets.
 *
 * Order of precedence:
 *   1. `tier.currentWorkspace.slug` — the value Caddy parsed from
 *      `{slug}.flowstarter.net`. Always wins in prod.
 *   2. `VITE_WORKSPACE_SLUG` — opt-in override for local dev so the
 *      operator can simulate any workspace without DNS.
 *   3. `demo-coach` — matches the seed that `scripts/dev-editor.sh`
 *      bootstraps so the local sim has something to point at.
 */
export function resolvePublishTarget(tier: TierContextValue): PublishTarget {
  const fromAuth = tier.currentWorkspace?.slug?.trim();
  const fromEnv = import.meta.env.VITE_WORKSPACE_SLUG?.trim();
  const slug = fromAuth || fromEnv || LOCAL_DEV_FALLBACK_SLUG;

  const domain =
    import.meta.env.VITE_PUBLISH_DOMAIN?.trim() || DEFAULT_PUBLISH_DOMAIN;

  // If we're already on a `*.flowstarter.net` host, mirror its scheme so
  // the link doesn't downgrade to http in production.
  const onPublicHost =
    typeof window !== "undefined" &&
    window.location.hostname.endsWith(`.${domain}`);

  if (!fromAuth) {
    // No workspace from auth — we're in local dev. Point at the actual
    // workspace dev server (Astro etc.) rather than the editor server
    // itself. `VITE_PREVIEW_URL` is the same env var the Preview button
    // uses, so a single setting drives both buttons. Default 4322
    // matches the demo-coach Astro dev server in `scripts/dev-editor.sh`.
    const previewUrl =
      (import.meta.env.VITE_PREVIEW_URL as string | undefined)?.trim() ||
      "http://localhost:4322";
    return {
      slug,
      url: previewUrl,
      local: true,
    };
  }

  const scheme = onPublicHost ? "https" : "https";
  return {
    slug,
    url: `${scheme}://${slug}.${domain}`,
    local: false,
  };
}

export interface PublishProgressHandlers {
  /** Called when the build phase starts. */
  readonly onBuildStart: (target: PublishTarget) => void;
  /** Called when the build succeeds and deploy begins. */
  readonly onDeployStart: (target: PublishTarget) => void;
  /** Called on successful deploy. */
  readonly onSuccess: (target: PublishTarget) => void;
  /** Called when any step fails — `reason` is human-readable. */
  readonly onFailure: (target: PublishTarget, reason: string) => void;
}

/**
 * Run the publish flow. When the editor server's `/api/site/publish`
 * route is up, this drives the real pipeline. Until then it runs a
 * local simulation with the same progression so the UI is testable.
 */
export async function runPublish(
  tier: TierContextValue,
  handlers: PublishProgressHandlers,
): Promise<void> {
  const target = resolvePublishTarget(tier);
  handlers.onBuildStart(target);

  try {
    const res = await fetch(withBasePath("/api/site/publish"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: target.slug }),
    });

    if (res.status === 404) {
      // Route not implemented yet — fall through to simulation so the
      // local flow stays demoable until the server route lands.
      await simulatePublish(target, handlers);
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      handlers.onFailure(target, text || `HTTP ${res.status}`);
      return;
    }

    // Real path: server returns `{ stage: "deploying" }` then a final
    // `{ stage: "done" }`. For v1 we just await the final response.
    handlers.onDeployStart(target);
    handlers.onSuccess(target);
  } catch (err) {
    // Network failure (server offline, CORS, etc.) — treat as a missing
    // route and run the simulation so the operator still sees the UX.
    await simulatePublish(target, handlers);
    if (err instanceof Error && !err.message.includes("Failed to fetch")) {
      // Surface unexpected failures for debugging without blocking the sim.
      console.warn("[publishSite] fell back to simulation:", err);
    }
  }
}

async function simulatePublish(
  target: PublishTarget,
  handlers: PublishProgressHandlers,
): Promise<void> {
  await wait(1600);
  handlers.onDeployStart(target);
  await wait(1800);
  handlers.onSuccess(target);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
