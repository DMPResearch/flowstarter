import type { ReactNode } from 'react';
import {
  FolderKanban,
  Globe,
  Users,
  Wallet,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { StatTile, type Tone } from '@flowstarter/flow-design-system';
import { useTranslations } from '@/lib/i18n';
import { formatTokenCount, formatEuro } from '@/lib/format-utils';
import type { useTeamDashboardStats } from '@/hooks/useTeamDashboardStats';

// ─── Tone per stat cell ─────────────────────────────────────────────────────
//
// Money reads `ok` (something is working), AI spend reads `warn` (a cost to
// watch), and the two pipeline-shaped counts — how many projects exist, how
// many are live — read `accent` then `teal` in that order: the funnel moves
// from the whole book of work (accent, the primary tone) to the state you
// actually want it to reach (teal, the same tone the client dashboard uses
// for scheduling and "this is happening now"). Clients is `pink`, the token
// the system reserves for audience and reach — this is the operator's count
// of who they serve, not a stage of a project.

export type StatCellKey = 'projects' | 'live' | 'clients' | 'revenue' | 'ai';

const STAT_CELL_TONE: Record<StatCellKey, Tone> = {
  projects: 'accent',
  live: 'teal',
  clients: 'pink',
  revenue: 'ok',
  ai: 'warn',
};

/** Exported for the mapping test — the one rule this file has an opinion on. */
export function statCellTone(key: StatCellKey): Tone {
  return STAT_CELL_TONE[key];
}

// ─── Types ──────────────────────────────────────────────────────────────────

type StatCellProps = {
  cellKey: StatCellKey;
  label: string;
  value: string | null;
  sub: ReactNode;
  icon: LucideIcon;
  /** Per-cell loading toggle so cells driven by different queries can show
   * skeletons independently of the shared stats query. */
  loadingOverride?: boolean;
};

// ─── StatsStrip ─────────────────────────────────────────────────────────────

export function StatsStrip({
  stats,
  loading,
  error,
  clientCount,
  clientsLoading,
}: {
  stats: ReturnType<typeof useTeamDashboardStats>['data'];
  loading: boolean;
  error: boolean;
  clientCount: number | null;
  clientsLoading: boolean;
}) {
  const { t } = useTranslations();

  const aiSub =
    stats == null
      ? '–'
      : stats.aiSessionsThisMonth === 0
      ? t('admin.dashboard.stats.aiThisMonthSubEmpty')
      : stats.aiSessionsThisMonth === 1
      ? t('admin.dashboard.stats.aiThisMonthSub', {
          tokens: stats.aiTokensThisMonth.toLocaleString('en-IE'),
        })
      : t('admin.dashboard.stats.aiThisMonthSubPlural', {
          tokens: stats.aiTokensThisMonth.toLocaleString('en-IE'),
          count: stats.aiSessionsThisMonth,
        });

  // One line: the ARR figure is the headline, the rest of the detail moved
  // out with the old multi-line sub — a StatTile note is plain English, not
  // a mini table.
  const revenueSub: ReactNode = stats
    ? t('admin.dashboard.stats.revenueSubArr', {
        arr: formatEuro(stats.monthlyRevenue * 12),
      })
    : '–';

  const clientsSub: ReactNode = clientsLoading
    ? '–'
    : clientCount === null
    ? '–'
    : clientCount === 0
    ? t('admin.dashboard.stats.clientsSubEmpty')
    : clientCount === 1
    ? t('admin.dashboard.stats.clientsSub', { count: clientCount })
    : t('admin.dashboard.stats.clientsSubPlural', { count: clientCount });

  const cells: StatCellProps[] = [
    {
      cellKey: 'projects',
      label: t('admin.dashboard.stats.projects'),
      value: stats ? String(stats.totalProjects) : null,
      sub: stats
        ? t('admin.dashboard.stats.projectsSub', {
            draft: stats.draftCount,
            building: stats.inProgressCount,
          })
        : '–',
      icon: FolderKanban,
      loadingOverride: loading,
    },
    {
      cellKey: 'live',
      label: t('admin.dashboard.stats.live'),
      value: stats ? String(stats.liveCount) : null,
      sub: stats?.liveCount
        ? t('admin.dashboard.stats.liveSubOn')
        : t('admin.dashboard.stats.liveSubOff'),
      icon: Globe,
      loadingOverride: loading,
    },
    {
      cellKey: 'clients',
      label: t('admin.dashboard.stats.clients'),
      value:
        clientsLoading || clientCount === null ? null : String(clientCount),
      sub: clientsSub,
      icon: Users,
      loadingOverride: loading || clientsLoading,
    },
    {
      cellKey: 'revenue',
      label: t('admin.dashboard.stats.revenue'),
      value: stats ? formatEuro(stats.monthlyRevenue) : null,
      sub: revenueSub,
      icon: Wallet,
      loadingOverride: loading,
    },
    {
      cellKey: 'ai',
      label: t('admin.dashboard.stats.aiThisMonth'),
      value: stats ? formatTokenCount(stats.aiTokensThisMonth) : null,
      sub: aiSub,
      icon: Sparkles,
      loadingOverride: loading,
    },
  ];

  return (
    <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5 lg:gap-4">
      {cells.map(({ loadingOverride, ...rest }) => (
        <StatCell
          key={rest.cellKey}
          {...rest}
          loading={loadingOverride ?? loading}
          error={error}
        />
      ))}
    </section>
  );
}

// ─── StatCell ───────────────────────────────────────────────────────────────

function StatCell({
  label,
  value,
  sub,
  icon: Icon,
  loading,
  error,
  cellKey,
}: StatCellProps & {
  loading: boolean;
  error: boolean;
}) {
  const displayValue = loading ? (
    <span className="inline-block h-8 w-16 animate-pulse rounded bg-[var(--fs-rule)] align-middle" />
  ) : error || value === null ? (
    <span className="text-[var(--fs-ink-faint)]">–</span>
  ) : (
    value
  );

  return (
    <StatTile
      label={label}
      value={displayValue}
      note={loading ? ' ' : sub}
      tone={statCellTone(cellKey)}
      icon={<Icon size={15} strokeWidth={2.25} aria-hidden="true" />}
      data-testid="admin-stat-tile"
      data-key={cellKey}
    />
  );
}
