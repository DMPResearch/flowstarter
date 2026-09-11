/**
 * A permanent home for screenshots of signed-in surfaces.
 *
 * Client work and admin work both sit behind Clerk, so reviewing either one
 * used to mean a throwaway harness page nobody remembered to delete. This
 * route replaces that: it renders the real components on fixture data
 * instead of a lookalike, so a screenshot taken here is a screenshot of the
 * actual UI, not a page someone will have to keep in sync with it by hand.
 *
 * `/about(.*)` is public in `src/lib/route-manifest.ts`, which is why this
 * lives under `/about` rather than a route the auth middleware would gate --
 * an underscore folder would make it a private Next.js segment name, not a
 * public route. Production safety comes from the `notFound()` gate below
 * instead: only a non-production `NODE_ENV`, or the explicit
 * `FLOWSTARTER_DESIGN_GALLERY=1` opt-in, renders anything here.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MeshBackdrop } from '@flowstarter/flow-design-system/components/backgrounds/MeshBackdrop';
import { SiteOverview } from '@/components/flowstarter/SiteOverview';
import { siteOverviewTiles } from '@/components/flowstarter/site-overview';
import { AdminGallerySection } from './AdminSection';
import { starterOverview, ecommerceOverview } from './fixtures';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Read inside the component, not hoisted to a module-level constant: Next
 * only fixes `NODE_ENV` at build time, but a module-level constant would
 * also freeze the opt-in env var at first import, which is exactly the kind
 * of staleness a test (and a `FLOWSTARTER_DESIGN_GALLERY` flip without a
 * rebuild) needs this to not have.
 */
function galleryAvailable(): boolean {
  return (
    process.env.NODE_ENV !== 'production' ||
    process.env.FLOWSTARTER_DESIGN_GALLERY === '1'
  );
}

export default function DesignGalleryPage() {
  if (!galleryAvailable()) notFound();

  const starterTiles = siteOverviewTiles(starterOverview.input);
  const ecommerceTiles = siteOverviewTiles(ecommerceOverview.input);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--purple-primary)]">
          Development only
        </p>
        <h1 className="text-3xl font-bold leading-tight text-[var(--fs-ink)]">
          Design gallery
        </h1>
        <p className="max-w-2xl text-sm text-[var(--fs-ink-dim)]">
          Signed-in surfaces, rendered on fixture data for screenshots. Not
          indexed, and not reachable once the app is built for production.
        </p>
      </header>

      <section
        aria-labelledby="design-gallery-client-dashboard"
        className="flex flex-col gap-6"
      >
        <h2
          id="design-gallery-client-dashboard"
          className="text-xl font-bold text-[var(--fs-ink)]"
        >
          Client dashboard
        </h2>
        {/* Wrapped exactly like `dashboard/layout.tsx` wraps its children:
            the mesh behind, the content above it. */}
        <div className="relative min-h-screen overflow-hidden rounded-2xl">
          <MeshBackdrop variant="app" />
          <div className="relative z-10 flex flex-col gap-6 p-6">
            <SiteOverview state={starterOverview.state} tiles={starterTiles} />
            <SiteOverview
              state={ecommerceOverview.state}
              tiles={ecommerceTiles}
            />
          </div>
        </div>
      </section>

      <section
        aria-labelledby="design-gallery-admin"
        className="flex flex-col gap-6"
      >
        <h2
          id="design-gallery-admin"
          className="text-xl font-bold text-[var(--fs-ink)]"
        >
          Admin
        </h2>
        <AdminGallerySection />
      </section>
    </main>
  );
}
