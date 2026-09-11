import React from "react";
import { createPortal } from "react-dom";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createBrowserHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClerkProvider } from "@clerk/clerk-react";
import { MeshBackdrop } from "@flowstarter/flow-design-system";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { AdminFilesPanel } from "./components/AdminFilesPanel";
import { ClerkSessionGate } from "./components/auth/ClerkSessionGate";
import { PreviewPanel } from "./components/PreviewPanel";

const history = createBrowserHistory();
const queryClient = new QueryClient();

const router = getRouter(history, queryClient);

document.title = APP_DISPLAY_NAME;

/**
 * Bypass the Clerk gate when:
 *   - the URL carries `?clerk-skip=true` (one-shot dev override), or
 *   - the build was started with VITE_DISABLE_CLERK_GATE=true (long-running
 *     local dev without a Clerk key set up).
 *
 * In production neither flag should fire, so the editor refuses to render
 * without a Clerk session.
 */
function shouldBypassClerkGate(): boolean {
  if (typeof window !== "undefined") {
    try {
      const flag = new URL(window.location.href).searchParams.get("clerk-skip");
      if (flag === "true" || flag === "1") return true;
    } catch {
      // Ignore unparseable hrefs.
    }
  }
  if (import.meta.env.VITE_DISABLE_CLERK_GATE === "true") return true;
  return false;
}

// Optional Clerk SDK on the web side. When the publishable key is set we
// mount <ClerkProvider> so components can use useUser / <UserButton /> /
// <SignedIn> directly. When it's missing (or the dev override is on) we
// skip it — the editor server still has its own Clerk JWT validation
// path via /api/clerk/me, so legacy / pairing-only flows keep working.
const clerkPublishableKey =
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim() || undefined;

function resolveClerkSignInUrl(): string {
  const explicit = import.meta.env.VITE_CLERK_SIGN_IN_URL?.trim();
  if (explicit) return explicit;
  const fromMain = import.meta.env.VITE_MAIN_APP_LOGIN_URL?.trim();
  if (fromMain) return fromMain;
  if (
    typeof window !== "undefined" &&
    import.meta.env.DEV &&
    import.meta.env.VITE_ASSUME_MAIN_ON_SAME_HOST === "true"
  ) {
    const host = window.location.hostname.trim().toLowerCase();
    if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      return `http://${window.location.hostname}:3000/login`;
    }
  }
  return "http://localhost:3000/login";
}

const clerkSignInUrl = resolveClerkSignInUrl();

/**
 * MeshBackdrop — imported directly from the shared design-system package,
 * `variant="editor"`. This is the field every `.fs-glass` surface in the
 * chrome/sidebar/panels/dialogs refracts (see index.css's liquid-glass
 * signature rules); a blurred surface with nothing colourful behind it just
 * reads as a grey box. The CSS lives in `index.css` (`.fs-mesh-backdrop`)
 * in the package, imported at the top of this app's own `index.css`.
 *
 * Previously this portal rendered `<FlowBackground variant="landing" />`
 * (the marketing-site orb treatment) — swapped for MeshBackdrop because
 * FlowBackground paints its own opaque `.fs-bg__base` fill, which fully
 * hides whatever is layered behind or in front of it, so the two can't
 * usefully coexist as one backdrop. MeshBackdrop's `editor` variant is
 * exactly the quieter, glass-refracting field the package ships for an
 * app-like working surface (see MeshBackdrop's own doc comment) — the
 * editor is somewhere you work for an hour, not a marketing hero.
 *
 * The layer is portaled into `#fs-flow-bg-mount` (sibling of `#root`
 * in `index.html`) so it sits under the full chrome stack — the package
 * component sets `z-index: 0` on a `position: fixed` element of its own,
 * which needs to be outside `#root`'s stacking context to actually sit
 * behind it, hence the portal to a body-level mount.
 */
function FlowstarterFlowBgPortal() {
  if (typeof document === "undefined") return null;
  const mount = document.getElementById("fs-flow-bg-mount");
  const tree = (
    <>
      <MeshBackdrop variant="editor" />
      {/* Dual-tone editorial wash + film grain — direct port of the admin
          dashboard's `.dashboard-atmosphere-*` overlays (see
          apps/flowstarter-main/src/styles/globals.css). Layered above the
          mesh and below the chrome glass so the cool-indigo / warm-rust
          horizon reads through the sidebar + chat surfaces. */}
      <div className="fs-dashboard-atmosphere-light" aria-hidden />
      <div className="fs-dashboard-atmosphere-dark" aria-hidden />
      <div className="fs-dashboard-atmosphere-grain" aria-hidden />
    </>
  );
  if (!mount) return tree;
  return createPortal(tree, mount);
}

/**
 * Wrap the editor in `.ls-scope` so every --ls-* token from the
 * marketing site's landing-design.css cascades through the React
 * tree. Components can use `.ls-cta`, `.ls-display`, `.ls-flourish`,
 * `.ls-eyebrow`, `.ls-link`, etc. directly.
 *
 * The class also sets `color: var(--ls-ink); font-family: var(--ls-sans)`
 * — that's the entire marketing-site type/colour stack on top of
 * everything inside.
 */
const tree = (
  <QueryClientProvider client={queryClient}>
    <FlowstarterFlowBgPortal />
    <div className="ls-scope" style={{ minHeight: "100vh" }}>
      <ClerkSessionGate bypass={shouldBypassClerkGate()}>
        <>
          <RouterProvider router={router} />
          {/* Side panels — require TierProvider from ClerkSessionGate */}
          <PreviewPanel />
          <AdminFilesPanel />
        </>
      </ClerkSessionGate>
    </div>
  </QueryClientProvider>
);

// Whole-page navigation router functions for Clerk. The editor doesn't
// run Clerk-hosted pages inside its own SPA — sign-in/up bounce to the
// main app, so window.location is the right primitive.
const clerkRouterPush = (to: string) => {
  if (typeof window !== "undefined") window.location.href = to;
};
const clerkRouterReplace = (to: string) => {
  if (typeof window !== "undefined") window.location.replace(to);
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {clerkPublishableKey ? (
      <ClerkProvider
        publishableKey={clerkPublishableKey}
        signInUrl={clerkSignInUrl}
        routerPush={clerkRouterPush}
        routerReplace={clerkRouterReplace}
      >
        {tree}
      </ClerkProvider>
    ) : (
      tree
    )}
  </React.StrictMode>,
);
