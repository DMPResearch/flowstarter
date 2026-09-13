# Accepted dependency findings

Findings closed by a version bump or override live in the `pnpm.overrides` block in the
root `package.json` and don't need an entry here. This file is only for findings
Dependabot reports where no upstream fix exists, so the fix is documented exposure
analysis instead of a version pin.

## image-size — GHSA-5p2g-fcmc-qvqq / GHSA-w3rx-r6r6-pgpr (accepted, 2026-09-14)

**What it is.** `image-size` through 2.0.2 has two infinite-loop denial-of-service bugs:
a zero-valued box-size field hangs the JXL/HEIF parser (CVE-2025-71329), and a
zero-valued entry-length field hangs the ICNS parser (CVE-2025-71330). Either can pin
the Node event loop at 100% given a crafted image buffer.

**Why it's not version-bumped.** `image-size`'s last release is 2.0.2 (2025-04-02); the
package has had no release since. Every published version, including latest, is inside
the vulnerable range. There is no version to override to.

**Where it resolves in our lockfile.** Two instances, both dev/build-time-only in
practice despite Dependabot's "runtime" scope label (that label reflects the top of the
dependency chain, not where the code actually executes):

1. `image-size@0.5.5` via `less@4.5.1`, which resolves as Vite's and Nx's optional
   CSS-preprocessor peer (`apps/flowstarter-library` → `@tailwindcss/vite` → `vite` →
   `less`, per `pnpm audit --prod`; also reachable from `@nx/webpack` /
   `less-loader` in the root build tooling). `less` and its own `image-size()` helper
   are only invoked if a `.less` file is actually compiled, against assets already
   checked into the repo — never user- or attacker-supplied bytes — and only during
   local dev and CI builds, never in a request path.

2. `image-size@1.2.1` via `metro` → `@react-native/community-cli-plugin` → `react-native`
   → `@solana-mobile/wallet-adapter-mobile` → `@solana/wallet-adapter-react` →
   `@clerk/ui`, which `apps/flowstarter-main` depends on directly (for
   `src/app/components/ClerkThemeWrapper.tsx`, theme tokens only). `@clerk/ui` bundles
   optional Web3/wallet-connect sign-in support, which pulls in React Native's bundler
   (`metro`) as a transitive dependency so the package resolves in any environment. We
   don't use Clerk's wallet sign-in, don't ship a React Native app, and Next.js's build
   and server never invoke `metro` — it sits in `node_modules` unreached. It resolves
   into the workspace only because pnpm has to satisfy `@clerk/ui`'s full dependency
   graph, not because our runtime calls into it.

**Exposure.** In both cases the code path that parses attacker-controlled image bytes
through the vulnerable parsers is never reached by anything Flowstarter runs in
production or CI. Accepted until `image-size` ships a fixed release; if it stays
unpatched, the follow-up is to replace path 2 by dropping `@clerk/ui` in favor of
`@clerk/nextjs`'s built-in theming (avoiding the Solana/React Native chain entirely) —
tracked as a follow-up, not blocking this pass since the current usage is inert.

**Recheck.** `npm view image-size versions` — re-open this note once a version above
2.0.2 exists and bump via `pnpm.overrides`.
