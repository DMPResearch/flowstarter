/**
 * Fixed inputs for the design gallery, kept out of `page.tsx` so the page
 * itself stays readable.
 *
 * Every number that a rules module can derive is derived here, not
 * hardcoded: the two `SiteOverview` panels feed `editCreditPosition` and
 * `siteOverviewTiles` real inputs and let those modules phrase the tiles,
 * exactly as the client project page does.
 */
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { editCreditPosition } from '@/lib/flowstarter/edit-credits';
import type { SiteOverviewInput } from '@/components/flowstarter/site-overview';
import type { TeamDashboardStatsPayload } from '@/lib/team-dashboard/team-dashboard-stats';
import type { ProjectRow } from '../../admin/dashboard/components/ProjectsTable';

/**
 * Starter plan, mid-build. The site is not serving yet, so enquiries reads
 * "not live" rather than a made-up zero, and there is nothing to connect a
 * booking link to.
 */
export const starterOverview: {
  state: ProjectState;
  input: SiteOverviewInput;
} = {
  state: ProjectState.AGENTS_WORKING,
  input: {
    live: false,
    tier: 'starter',
    credits: editCreditPosition({ tier: 'starter', usedThisMonth: 4 }),
    enquiries: { total: 0, last30Days: 0, unread: 0 },
    edits: { appliedThisMonth: 3 },
    booking: {
      connected: false,
      href: '/dashboard/projects/demo-starter/booking',
    },
    store: { products: 0 },
    editorHref: '/dashboard/projects/demo-starter/editor',
  },
};

/**
 * Ecommerce plan, live and busy: a real enquiry queue, a connected booking
 * link and a catalogue worth showing the shop tile for.
 */
export const ecommerceOverview: {
  state: ProjectState;
  input: SiteOverviewInput;
} = {
  state: ProjectState.LIVE_SUBSCRIPTION,
  input: {
    live: true,
    siteHref: 'https://acme-goods.example.com',
    tier: 'ecommerce',
    credits: editCreditPosition({ tier: 'ecommerce', usedThisMonth: 12 }),
    enquiries: { total: 62, last30Days: 14, unread: 3 },
    edits: { appliedThisMonth: 27 },
    booking: {
      connected: true,
      href: '/dashboard/projects/demo-ecommerce/booking',
    },
    store: { products: 42 },
    editorHref: '/dashboard/projects/demo-ecommerce/editor',
  },
};

/** Fixture stats for the admin `StatsStrip`. */
export const galleryStats: TeamDashboardStatsPayload = {
  totalProjects: 48,
  draftCount: 9,
  inProgressCount: 14,
  liveCount: 25,
  totalSetupFees: 32_000,
  monthlyRevenue: 8_400,
  paidCount: 21,
  outstandingCount: 4,
  aiTokensThisMonth: 184_000,
  newThisWeek: 6,
  pipelineValue: 132_000,
  stageBreakdown: {
    intake: 9,
    brief: 5,
    build: 8,
    internal_review: 6,
    client_review: 4,
    launched: 3,
    care: 22,
  },
  aiSessionsThisMonth: 57,
  leadsThisMonth: 31,
  recentProject: null,
};

/** Fixture count for the admin `StatsStrip`'s clients cell. */
export const galleryClientCount = 19;

/** Four fixture rows for the admin `ProjectsTable`. */
export const galleryProjectRows: ProjectRow[] = [
  {
    id: 'demo-acme-dental',
    name: 'Acme Dental',
    slug: 'acme-dental',
    client_name: 'Priya Shah',
    client_business_name: null,
    concierge_stage: 'build',
    tier_name: 'essential',
    updated_at: '2026-09-10T09:15:00.000Z',
    created_at: '2026-08-20T11:00:00.000Z',
  },
  {
    id: 'demo-riverside-vets',
    name: 'Riverside Vets',
    slug: 'riverside-vets',
    client_name: 'Tom Doyle',
    client_business_name: 'Riverside Veterinary Clinic',
    concierge_stage: 'client_review',
    tier_name: 'pro',
    updated_at: '2026-09-09T16:40:00.000Z',
    created_at: '2026-08-11T08:30:00.000Z',
  },
  {
    id: 'demo-blue-anchor',
    name: 'Blue Anchor Cafe',
    slug: 'blue-anchor-cafe',
    client_name: 'Maria Costa',
    client_business_name: null,
    concierge_stage: 'launched',
    tier_name: 'commerce',
    updated_at: '2026-09-08T12:05:00.000Z',
    created_at: '2026-07-02T10:00:00.000Z',
  },
  {
    id: 'demo-whitmore-legal',
    name: 'Whitmore Legal',
    slug: 'whitmore-legal',
    client_name: 'Jonas Whitmore',
    client_business_name: null,
    concierge_stage: 'intake',
    tier_name: null,
    updated_at: '2026-09-11T07:20:00.000Z',
    created_at: '2026-09-11T07:20:00.000Z',
  },
];
