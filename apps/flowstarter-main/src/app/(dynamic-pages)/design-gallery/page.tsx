/**
 * A permanent home for screenshots of signed-in surfaces.
 *
 * Client work and admin work both sit behind Clerk, so reviewing either one
 * used to mean a throwaway harness page nobody remembered to delete. This
 * route replaces that: it renders the real components on fixture data
 * instead of a lookalike, so a screenshot taken here is a screenshot of the
 * actual UI, not a page someone will have to keep in sync with it by hand.
 *
 * Its own top-level route, not a sub-page of `/about`. Living under `/about`
 * bought a public entry for free (`/about(.*)` in `route-manifest.ts`) and
 * cost the two things that make a screenshot worth taking: the marketing
 * header painted across the top of every admin surface, and the marketing
 * page's own `max-w-6xl` content column squeezed the admin board into
 * roughly half the width it has in the product. `/design-gallery(.*)` is
 * public in its own right and `NavigationWrapper` hides the marketing chrome
 * for it exactly as it does for `/admin`, so each section below renders
 * full-bleed at the viewport width.
 *
 * Production safety never came from the route being obscure; it comes from
 * the `notFound()` gate below. Only a non-production `NODE_ENV`, or the
 * explicit `FLOWSTARTER_DESIGN_GALLERY=1` opt-in, renders anything here.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MeshBackdrop } from '@flowstarter/flow-design-system/components/backgrounds/MeshBackdrop';
import { SiteOverview } from '@/components/flowstarter/SiteOverview';
import { siteOverviewTiles } from '@/components/flowstarter/site-overview';
import { BriefForm } from '@/components/flowstarter/BriefForm';
import { evaluateBriefReadiness } from '@/lib/flowstarter/brief-readiness';
import { AdminDashboardGallery, AdminPipelineGallery } from './AdminSection';
import { briefGallery, starterOverview, ecommerceOverview } from './fixtures';

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

/**
 * A section label. Only the labels are in a reading column; everything they
 * label is full-bleed, because an admin surface boxed into a text column is
 * a picture of a layout the product does not have.
 */
function SectionLabel({ id, title }: { id: string; title: string }) {
  return (
    <h2
      id={id}
      className="mx-auto w-full max-w-6xl px-6 text-xl font-bold text-[var(--fs-ink)]"
    >
      {title}
    </h2>
  );
}

export default function DesignGalleryPage() {
  if (!galleryAvailable()) notFound();

  const starterTiles = siteOverviewTiles(starterOverview.input);
  const ecommerceTiles = siteOverviewTiles(ecommerceOverview.input);

  return (
    <main className="flex w-full flex-col gap-12 py-12">
      <header className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-6">
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
        <SectionLabel
          id="design-gallery-client-dashboard"
          title="Client dashboard"
        />
        {/* Wrapped exactly like `dashboard/layout.tsx` wraps its children:
            the mesh behind, the content above it. `transform: translateZ(0)`
            is load-bearing here, not decorative: `MeshBackdrop` is
            `position: fixed` with an opaque fill, meant to be the outermost
            layer of a whole page. Nested in a gallery with other sections
            around it, an untransformed ancestor lets it escape this box and
            paint over this page's own header and h2, which are earlier in
            the DOM but non-positioned, so they lose to a fixed element in
            paint order. The transform gives it a containing block sized to
            this div instead of the viewport.
            No `min-h-screen`: the mesh fills whatever height this box
            actually has, driven by its own two `SiteOverview` panels. */}
        <div
          className="relative overflow-hidden"
          style={{ transform: 'translateZ(0)' }}
        >
          <MeshBackdrop variant="app" />
          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
            <SiteOverview state={starterOverview.state} tiles={starterTiles} />
            <SiteOverview
              state={ecommerceOverview.state}
              tiles={ecommerceTiles}
            />
          </div>
        </div>
      </section>

      <section
        aria-labelledby="design-gallery-client-brief"
        className="flex flex-col gap-6"
      >
        <SectionLabel id="design-gallery-client-brief" title="Client brief" />
        {/* The in-depth brief, the page a client fills in after the deposit.
            Wrapped the way `dashboard/layout.tsx` wraps its children, and in
            the same reading column the real route uses, so a screenshot taken
            here is the width the page actually has. */}
        <div
          className="relative overflow-hidden"
          style={{ transform: 'translateZ(0)' }}
        >
          <MeshBackdrop variant="app" />
          <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
            <header className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-[var(--purple-primary)]">
                Your brief
              </p>
              <h1 className="text-3xl font-bold leading-tight text-[var(--fs-ink)]">
                What your site is made from
              </h1>
              <p className="text-sm text-[var(--fs-ink-dim)]">
                Your build starts once this is complete. Everything here ends up
                on the site, so the more of it is yours, the less we have to
                invent.
              </p>
            </header>
            <BriefForm
              workspaceId={briefGallery.workspaceId}
              initialBrief={briefGallery.brief}
              initialReadiness={evaluateBriefReadiness({
                offer: briefGallery.brief.offer,
                projects: briefGallery.brief.projects,
                noProjects: briefGallery.brief.noProjects,
                designReferenceAssetIds:
                  briefGallery.brief.designReferenceAssetIds,
                photos: briefGallery.assets
                  .filter((asset) =>
                    briefGallery.brief.photoAssetIds.includes(asset.id)
                  )
                  .map((asset) => ({
                    assetId: asset.id,
                    kind: asset.kind,
                    width: asset.width,
                    height: asset.height,
                    rightsConfirmed: Boolean(asset.rightsConfirmedAt),
                  })),
              })}
              initialAssets={briefGallery.assets}
            />
          </div>
        </div>
      </section>

      {/* Two embeds rather than one long one, each the shape of the route it
          stands in for: a screenshot of "the pipeline board" should be a
          screenshot of `/admin/dashboard/pipeline`, page header and all, not
          of a board bolted to the bottom of the dashboard. */}
      <section
        aria-labelledby="design-gallery-admin-dashboard"
        className="flex flex-col gap-6"
      >
        <SectionLabel
          id="design-gallery-admin-dashboard"
          title="Admin dashboard"
        />
        <AdminDashboardGallery />
      </section>

      <section
        aria-labelledby="design-gallery-admin-pipeline"
        className="flex flex-col gap-6"
      >
        <SectionLabel
          id="design-gallery-admin-pipeline"
          title="Admin pipeline"
        />
        <AdminPipelineGallery />
      </section>
    </main>
  );
}
