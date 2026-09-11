'use client';

import { useQuery } from '@tanstack/react-query';
import { quoteMajorFrom } from '@/lib/flowstarter/quote';
import { StatTile, type Tone } from '@flowstarter/flow-design-system';
import {
  TeamDashboardShell,
  ShellCard,
} from '../components/TeamDashboardShell';
import {
  BarChart3,
  Globe,
  FileText,
  Sparkles,
  DollarSign,
  TrendingUp,
  Users,
  Clock,
} from 'lucide-react';
import { formatDistanceToNow, format, subDays, startOfDay } from 'date-fns';

interface Project {
  id: string;
  name: string;
  status: string;
  is_draft: boolean;
  published_url: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  ai_credits_used: number | null;
  generation_cost_usd: number | null;
  monthly_fee: number | null;
  is_paid: boolean | null;
  setup_fee: number | null;
  final_value_minor?: number | null;
  template_id: string | null;
  user_id: string;
  client_name: string | null;
}

function StatCardSkeleton() {
  return (
    <ShellCard className="!p-5 animate-pulse">
      <div className="w-9 h-9 rounded-xl bg-[var(--fs-bg-elevated)] mb-3" />
      <div className="h-2.5 w-20 rounded bg-[var(--fs-bg-elevated)] mb-2" />
      <div className="h-7 w-14 rounded bg-[var(--fs-bg-elevated)]" />
    </ShellCard>
  );
}

export default function AnalyticsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['team-projects-analytics'],
    queryFn: async () => {
      const res = await fetch('/api/admin/projects');
      if (!res.ok) throw new Error('Failed');
      return res.json() as Promise<{ projects: Project[] }>;
    },
  });

  const projects = data?.projects ?? [];

  // Core counts
  const total = projects.length;
  const live = projects.filter(
    (p) => p.published_url || p.status === 'live'
  ).length;
  const drafts = projects.filter(
    (p) => p.is_draft || p.status === 'draft'
  ).length;
  const inProgress = projects.filter((p) =>
    ['in_progress', 'building', 'new'].includes(p.status)
  ).length;

  // Revenue
  const totalSetupFee = projects.reduce((s, p) => s + quoteMajorFrom(p), 0);
  const totalMonthly = projects.reduce((s, p) => s + (p.monthly_fee ?? 0), 0);
  const paidCount = projects.filter((p) => p.is_paid).length;

  // AI
  const totalCredits = projects.reduce(
    (s, p) => s + (p.ai_credits_used ?? 0),
    0
  );
  const totalCostUsd = projects.reduce(
    (s, p) => s + (p.generation_cost_usd ?? 0),
    0
  );
  const totalCostEur = totalCostUsd * 0.92;
  const aiGeneratedCount = projects.filter(
    (p) => (p.ai_credits_used ?? 0) > 0
  ).length;

  // Activity — projects created last 30 days by day
  const last30 = Array.from({ length: 30 }, (_, i) => {
    const day = startOfDay(subDays(new Date(), 29 - i));
    const label = format(day, 'MMM d');
    const count = projects.filter((p) => {
      const d = startOfDay(new Date(p.created_at));
      return d.getTime() === day.getTime();
    }).length;
    return { label, count };
  });
  const maxCount = Math.max(...last30.map((d) => d.count), 1);

  // Recent projects
  const recent = [...projects]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    .slice(0, 8);

  // Status breakdown
  const statusGroups = projects.reduce<Record<string, number>>((acc, p) => {
    const s = p.status || 'unknown';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const statusTones: Record<string, Tone> = {
    live: 'ok',
    published: 'ok',
    in_progress: 'info',
    building: 'info',
    draft: 'neutral',
    new: 'warn',
    error: 'danger',
    unknown: 'neutral',
  };

  return (
    <TeamDashboardShell
      title="Platform Analytics"
      subtitle="Usage and performance stats across all projects"
      icon={<BarChart3 className="w-5 h-5 text-[var(--purple)]" />}
    >
      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {isLoading ? (
          [1, 2, 3, 4, 5, 6, 7, 8].map((i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <StatTile
              icon={<FileText className="w-4 h-4" />}
              tone="accent"
              label="Total projects"
              value={total}
            />
            <StatTile
              icon={<Globe className="w-4 h-4" />}
              tone="ok"
              label="Live sites"
              value={live}
              note={`${drafts} draft · ${inProgress} in progress`}
            />
            <StatTile
              icon={<DollarSign className="w-4 h-4" />}
              tone="ok"
              label="Monthly recurring"
              value={`€${totalMonthly.toFixed(0)}/mo`}
              note={`${paidCount} paid clients`}
            />
            <StatTile
              icon={<TrendingUp className="w-4 h-4" />}
              tone="ok"
              label="Setup revenue"
              value={`€${totalSetupFee.toFixed(0)}`}
              note="total collected"
            />
            <StatTile
              icon={<Sparkles className="w-4 h-4" />}
              tone="accent"
              label="AI usage units"
              value={totalCredits.toLocaleString()}
              note={`${aiGeneratedCount} sites generated`}
            />
            <StatTile
              icon={<DollarSign className="w-4 h-4" />}
              tone="warn"
              label="AI cost"
              value={`€${totalCostEur.toFixed(2)}`}
              note={`$${totalCostUsd.toFixed(2)} USD`}
            />
            <StatTile
              icon={<Users className="w-4 h-4" />}
              tone="pink"
              label="Clients"
              value={
                new Set(projects.map((p) => p.client_name).filter(Boolean)).size
              }
              note="unique clients"
            />
            <StatTile
              icon={<Clock className="w-4 h-4" />}
              tone="neutral"
              label="This month"
              value={
                projects.filter(
                  (p) => new Date(p.created_at) > subDays(new Date(), 30)
                ).length
              }
              note="new projects"
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        {/* Activity chart */}
        <ShellCard className="lg:col-span-2 !p-5">
          <p className="fs-glass-header-row text-sm font-semibold text-[var(--fs-ink)] mb-4">
            Projects created: last 30 days
          </p>
          {isLoading ? (
            <div className="h-24 animate-pulse rounded-lg bg-[var(--fs-bg-elevated)]" />
          ) : (
            <div className="flex items-end gap-1 h-24">
              {last30.map((day, i) => (
                <div
                  key={i}
                  className="flex-1 flex flex-col items-center gap-1 group relative"
                >
                  <div
                    className="w-full rounded-sm bg-[var(--purple)]/20 group-hover:bg-[var(--purple)]/60 transition-colors"
                    style={{
                      height: `${(day.count / maxCount) * 100}%`,
                      minHeight: day.count > 0 ? '4px' : '2px',
                    }}
                  />
                  {day.count > 0 && (
                    <span className="absolute -top-5 text-[0.6rem] text-[var(--fs-ink-faint)] opacity-0 group-hover:opacity-100 transition-opacity">
                      {day.count}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {!isLoading && (
            <div className="flex justify-between mt-2">
              <span className="text-[0.6rem] text-[var(--fs-ink-faint)]">
                {last30[0].label}
              </span>
              <span className="text-[0.6rem] text-[var(--fs-ink-faint)]">
                {last30[29].label}
              </span>
            </div>
          )}
        </ShellCard>

        {/* Status breakdown */}
        <ShellCard className="!p-5">
          <p className="fs-glass-header-row text-sm font-semibold text-[var(--fs-ink)] mb-4">
            Status breakdown
          </p>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-2 animate-pulse">
                  <div className="w-2 h-2 rounded-full bg-[var(--fs-bg-elevated)]" />
                  <div className="flex-1 h-2.5 rounded bg-[var(--fs-bg-elevated)]" />
                  <div className="w-6 h-2.5 rounded bg-[var(--fs-bg-elevated)]" />
                </div>
              ))}
            </div>
          ) : total === 0 ? (
            <p className="text-sm text-[var(--fs-ink-faint)] text-center py-6">
              No projects yet
            </p>
          ) : (
            <div className="space-y-3">
              {Object.entries(statusGroups)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <div key={status} className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        backgroundColor: `var(--fs-tone-${
                          statusTones[status] ?? 'neutral'
                        })`,
                      }}
                    />
                    <span className="flex-1 text-sm text-[var(--fs-ink-dim)] capitalize">
                      {status.replace('_', ' ')}
                    </span>
                    <span className="text-sm font-semibold text-[var(--fs-ink)]">
                      {count}
                    </span>
                    <span className="text-xs text-[var(--fs-ink-faint)] w-8 text-right">
                      {Math.round((count / total) * 100)}%
                    </span>
                  </div>
                ))}
            </div>
          )}
        </ShellCard>
      </div>

      {/* Recent projects */}
      <ShellCard className="!p-0 overflow-hidden">
        <div className="fs-glass-header-row px-5 py-4 border-b border-[var(--fs-rule)]">
          <p className="text-sm font-semibold text-[var(--fs-ink)]">
            Recent projects
          </p>
        </div>
        {isLoading ? (
          <div className="divide-y divide-[var(--fs-rule)]">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="flex items-center gap-4 px-5 py-3 animate-pulse"
              >
                <div className="w-8 h-8 rounded-lg bg-[var(--fs-bg-elevated)] shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-32 rounded bg-[var(--fs-bg-elevated)]" />
                  <div className="h-2.5 w-20 rounded bg-[var(--fs-bg-elevated)]" />
                </div>
                <div className="h-5 w-14 rounded-full bg-[var(--fs-bg-elevated)]" />
              </div>
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <FileText className="w-8 h-8 text-[var(--fs-ink-faint)] mx-auto mb-2" />
            <p className="text-sm text-[var(--fs-ink-faint)]">
              No projects yet
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--fs-rule)]">
            {recent.map((p) => {
              const statusTone = statusTones[p.status] ?? 'neutral';
              const ago = formatDistanceToNow(new Date(p.created_at), {
                addSuffix: true,
              });
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-[var(--fs-bg-elevated)]/50 transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-[var(--purple)]/10 flex items-center justify-center shrink-0">
                    <FileText className="w-4 h-4 text-[var(--purple)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--fs-ink)] truncate">
                      {p.name}
                    </p>
                    <p className="text-xs text-[var(--fs-ink-faint)]">
                      {p.client_name ? `${p.client_name} · ` : ''}
                      {ago}
                    </p>
                  </div>
                  <span
                    className="fs-tone-text inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.6rem] font-semibold uppercase tracking-wide"
                    data-tone={statusTone}
                    style={{ background: `var(--fs-tone-${statusTone}-soft)` }}
                  >
                    {p.status?.replace('_', ' ') ?? 'unknown'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </ShellCard>
    </TeamDashboardShell>
  );
}
