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
import type { PipelineBoard } from '@/hooks/usePipeline';
import type { ProjectRow } from '../admin/dashboard/components/ProjectsTable';

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
      upcoming: 0,
      nextAt: null,
      last30Days: 0,
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
      href: '/dashboard/projects/demo-ecommerce/booking/list',
      upcoming: 3,
      nextAt: '2026-09-15T09:30:00.000Z',
      last30Days: 11,
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

/**
 * All six columns of the cross-project pipeline board, in the order the state
 * machine allows, each with one to three cards so it reads as a populated
 * board rather than a placeholder, and one card stalled.
 *
 * All six, not the four it used to be, because four of them skipped two steps
 * of the accent ladder the board's colour now runs on — and a gallery that
 * shows a ladder with rungs missing is a gallery nobody can check the ladder
 * against. "Riverside Veterinary Clinic" is deliberately the longest name in
 * the set: it is the one a truncated title would clip first.
 */
export const galleryPipelineColumns: PipelineBoard['columns'] = [
  {
    state: ProjectState.INTAKE,
    stalledCount: 0,
    cards: [
      {
        workspaceId: 'demo-pipeline-intake-1',
        name: 'northside-bakery',
        businessName: 'Northside Bakery',
        clientEmail: 'owner@northsidebakery.example.com',
        projectState: ProjectState.INTAKE,
        quoteMinor: 59900,
        currency: 'eur',
        depositStatus: 'none',
        depositPaidAt: null,
        stateSince: '2026-09-10T09:00:00.000Z',
        timeInStateMs: 5_400_000,
        latestJob: null,
        stalled: false,
        stallReasons: [],
        createdAt: '2026-09-10T09:00:00.000Z',
      },
      {
        workspaceId: 'demo-pipeline-intake-2',
        name: 'fernbank-law',
        businessName: 'Fernbank Law Partners',
        clientEmail: 'hello@fernbanklaw.example.com',
        projectState: ProjectState.INTAKE,
        quoteMinor: 0,
        currency: 'eur',
        depositStatus: 'none',
        depositPaidAt: null,
        stateSince: '2026-09-11T07:20:00.000Z',
        timeInStateMs: 900_000,
        latestJob: null,
        stalled: false,
        stallReasons: [],
        createdAt: '2026-09-11T07:20:00.000Z',
      },
    ],
  },
  {
    state: ProjectState.PREVIEW_READY,
    stalledCount: 0,
    cards: [
      {
        workspaceId: 'demo-pipeline-preview-ready-1',
        name: 'kestrel-joinery',
        businessName: 'Kestrel Joinery',
        clientEmail: 'sean@kestreljoinery.example.com',
        projectState: ProjectState.PREVIEW_READY,
        quoteMinor: 74900,
        currency: 'eur',
        depositStatus: 'none',
        depositPaidAt: null,
        stateSince: '2026-09-10T16:40:00.000Z',
        timeInStateMs: 9_000_000,
        latestJob: {
          id: 'demo-job-preview-ready-1',
          kind: 'PREVIEW_GENERATE',
          status: 'succeeded',
          attemptCount: 1,
          maxAttempts: 3,
          createdAt: '2026-09-10T16:30:00.000Z',
          startedAt: '2026-09-10T16:31:00.000Z',
          finishedAt: '2026-09-10T16:40:00.000Z',
          errorCode: null,
          ageMs: 9_000_000,
        },
        stalled: false,
        stallReasons: [],
        createdAt: '2026-09-09T15:10:00.000Z',
      },
      {
        workspaceId: 'demo-pipeline-preview-ready-2',
        name: 'aldgate-optics',
        businessName: 'Aldgate Optics',
        clientEmail: 'reception@aldgateoptics.example.com',
        projectState: ProjectState.PREVIEW_READY,
        quoteMinor: 64900,
        currency: 'eur',
        depositStatus: 'none',
        depositPaidAt: null,
        stateSince: '2026-09-11T05:50:00.000Z',
        timeInStateMs: 4_500_000,
        latestJob: null,
        stalled: false,
        stallReasons: [],
        createdAt: '2026-09-10T18:05:00.000Z',
      },
    ],
  },
  {
    state: ProjectState.DEPOSIT_PAID,
    stalledCount: 0,
    cards: [
      {
        workspaceId: 'demo-pipeline-deposit-paid-1',
        name: 'clontarf-physio',
        businessName: 'Clontarf Physiotherapy',
        clientEmail: 'aoife@clontarfphysio.example.com',
        projectState: ProjectState.DEPOSIT_PAID,
        quoteMinor: 109900,
        currency: 'eur',
        depositStatus: 'paid',
        depositPaidAt: '2026-09-11T06:15:00.000Z',
        stateSince: '2026-09-11T06:15:00.000Z',
        timeInStateMs: 2_700_000,
        latestJob: null,
        stalled: false,
        stallReasons: [],
        createdAt: '2026-09-08T11:25:00.000Z',
      },
    ],
  },
  {
    state: ProjectState.AGENTS_WORKING,
    stalledCount: 1,
    cards: [
      {
        workspaceId: 'demo-pipeline-agents-working-1',
        name: 'harbour-fitness',
        businessName: 'Harbour Fitness Studio',
        clientEmail: 'hello@harbourfitness.example.com',
        projectState: ProjectState.AGENTS_WORKING,
        quoteMinor: 129900,
        currency: 'eur',
        depositStatus: 'paid',
        depositPaidAt: '2026-09-08T14:00:00.000Z',
        stateSince: '2026-09-09T11:00:00.000Z',
        timeInStateMs: 21_600_000,
        latestJob: {
          id: 'demo-job-agents-working-1',
          kind: 'FULL_SITE_BUILD',
          status: 'failed',
          attemptCount: 3,
          maxAttempts: 3,
          createdAt: '2026-09-09T11:00:00.000Z',
          startedAt: '2026-09-09T11:02:00.000Z',
          finishedAt: '2026-09-09T11:40:00.000Z',
          errorCode: 'FULL_SITE_BUILD_FAILED',
          ageMs: 21_600_000,
        },
        stalled: true,
        stallReasons: ['The site build failed 3 times in a row.'],
        createdAt: '2026-09-05T08:00:00.000Z',
      },
      {
        workspaceId: 'demo-pipeline-agents-working-2',
        name: 'pinehill-dental',
        businessName: 'Pinehill Dental Studio',
        clientEmail: 'hello@pinehilldental.example.com',
        projectState: ProjectState.AGENTS_WORKING,
        quoteMinor: 79900,
        currency: 'eur',
        depositStatus: 'paid',
        depositPaidAt: '2026-09-10T09:00:00.000Z',
        stateSince: '2026-09-10T09:30:00.000Z',
        timeInStateMs: 3_600_000,
        latestJob: {
          id: 'demo-job-agents-working-2',
          kind: 'FULL_SITE_BUILD',
          status: 'running',
          attemptCount: 1,
          maxAttempts: 3,
          createdAt: '2026-09-10T09:30:00.000Z',
          startedAt: '2026-09-10T09:31:00.000Z',
          finishedAt: null,
          errorCode: null,
          ageMs: 3_600_000,
        },
        stalled: false,
        stallReasons: [],
        createdAt: '2026-09-10T09:00:00.000Z',
      },
    ],
  },
  {
    state: ProjectState.HUMAN_QA,
    stalledCount: 0,
    cards: [
      {
        workspaceId: 'demo-pipeline-human-qa-1',
        name: 'riverside-vets',
        businessName: 'Riverside Veterinary Clinic',
        clientEmail: 'tom@riversidevets.example.com',
        projectState: ProjectState.HUMAN_QA,
        quoteMinor: 89900,
        currency: 'eur',
        depositStatus: 'paid',
        depositPaidAt: '2026-08-30T10:00:00.000Z',
        stateSince: '2026-09-11T08:00:00.000Z',
        timeInStateMs: 3_600_000,
        latestJob: {
          id: 'demo-job-human-qa-1',
          kind: 'FULL_SITE_BUILD',
          status: 'succeeded',
          attemptCount: 1,
          maxAttempts: 3,
          createdAt: '2026-09-11T07:00:00.000Z',
          startedAt: '2026-09-11T07:01:00.000Z',
          finishedAt: '2026-09-11T07:38:00.000Z',
          errorCode: null,
          ageMs: 3_600_000,
        },
        stalled: false,
        stallReasons: [],
        createdAt: '2026-08-25T09:00:00.000Z',
      },
      {
        workspaceId: 'demo-pipeline-human-qa-2',
        name: 'maple-street-dentistry',
        businessName: 'Maple Street Dentistry',
        clientEmail: 'reception@maplestreetdental.example.com',
        projectState: ProjectState.HUMAN_QA,
        quoteMinor: 99900,
        currency: 'eur',
        depositStatus: 'paid',
        depositPaidAt: '2026-08-28T10:00:00.000Z',
        stateSince: '2026-09-10T14:00:00.000Z',
        timeInStateMs: 68_400_000,
        latestJob: {
          id: 'demo-job-human-qa-2',
          kind: 'FULL_SITE_BUILD',
          status: 'succeeded',
          attemptCount: 2,
          maxAttempts: 3,
          createdAt: '2026-09-10T13:00:00.000Z',
          startedAt: '2026-09-10T13:01:00.000Z',
          finishedAt: '2026-09-10T13:42:00.000Z',
          errorCode: null,
          ageMs: 68_400_000,
        },
        stalled: false,
        stallReasons: [],
        createdAt: '2026-08-20T09:00:00.000Z',
      },
    ],
  },
  {
    state: ProjectState.LIVE_SUBSCRIPTION,
    stalledCount: 0,
    cards: [
      {
        workspaceId: 'demo-pipeline-live-1',
        name: 'salt-and-anchor',
        businessName: 'Salt & Anchor Bistro',
        clientEmail: 'maria@saltandanchor.example.com',
        projectState: ProjectState.LIVE_SUBSCRIPTION,
        quoteMinor: 149900,
        currency: 'eur',
        depositStatus: 'paid',
        depositPaidAt: '2026-07-05T10:00:00.000Z',
        stateSince: '2026-07-10T10:00:00.000Z',
        timeInStateMs: 5_270_400_000,
        latestJob: null,
        stalled: false,
        stallReasons: [],
        createdAt: '2026-07-02T10:00:00.000Z',
      },
      {
        workspaceId: 'demo-pipeline-live-2',
        name: 'riverside-dental',
        businessName: 'Riverside Dental',
        clientEmail: 'owner@riversidedental.example.com',
        projectState: ProjectState.LIVE_SUBSCRIPTION,
        quoteMinor: 79900,
        currency: 'eur',
        depositStatus: 'paid',
        depositPaidAt: '2026-05-01T10:00:00.000Z',
        stateSince: '2026-05-06T10:00:00.000Z',
        timeInStateMs: 10_713_600_000,
        latestJob: null,
        stalled: false,
        stallReasons: [],
        createdAt: '2026-04-28T10:00:00.000Z',
      },
      {
        workspaceId: 'demo-pipeline-live-3',
        name: 'harbourview-realty',
        businessName: 'Harbourview Realty Group',
        clientEmail: 'info@harbourviewrealty.example.com',
        projectState: ProjectState.LIVE_SUBSCRIPTION,
        quoteMinor: 199900,
        currency: 'eur',
        depositStatus: 'paid',
        depositPaidAt: '2026-03-01T10:00:00.000Z',
        stateSince: '2026-03-06T10:00:00.000Z',
        timeInStateMs: 15_552_000_000,
        latestJob: null,
        stalled: false,
        stallReasons: [],
        createdAt: '2026-02-25T10:00:00.000Z',
      },
    ],
  },
];

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
