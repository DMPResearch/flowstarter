'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  FolderOpen,
  Plus,
  Search,
  ShoppingBag,
  ChevronRight,
} from 'lucide-react';
import { useTranslations, type TranslationKeys } from '@/lib/i18n';
import { compactRelative } from '@/lib/format-utils';
import { TeamDashboardShell } from '../components/TeamDashboardShell';
import { Panel } from '../components/Panel';
import { useTeamProjects } from '@/hooks/useTeamProjects';
import {
  STAGE_I18N_KEYS,
  stageDotStyle,
} from '../components/dashboard.constants';

const TIER_I18N_KEYS: Partial<Record<string, TranslationKeys>> = {
  essential: 'admin.tier.essential',
  pro: 'admin.tier.pro',
  commerce: 'admin.tier.commerce',
  custom: 'admin.tier.custom',
};

function ListRowsSkeleton({ n }: { n: number }) {
  return (
    <ul className="divide-y divide-[var(--ls-rule)]">
      {Array.from({ length: n }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-5 py-3">
          <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--ls-rule)]" />
          <div className="h-3 flex-1 animate-pulse rounded-sm bg-[var(--ls-rule)]" />
          <div className="hidden h-3 w-16 animate-pulse rounded-sm bg-[var(--ls-rule)] sm:block" />
        </li>
      ))}
    </ul>
  );
}

function ColHead({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`ls-admin-label border-b border-[var(--ls-rule)] px-3 py-2.5 text-left font-medium ${className}`}
    >
      {children}
    </th>
  );
}

export default function TeamProjectsPage() {
  const router = useRouter();
  const { t } = useTranslations();
  const { data: projects, isLoading, error } = useTeamProjects();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const all = projects ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((p) => {
      const haystack = [
        p.name,
        p.slug,
        p.client_name,
        p.client_business_name,
        p.client_email,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [projects, search]);

  const total = projects?.length;
  const title =
    total === undefined
      ? t('admin.nav.projects')
      : `${t('admin.nav.projects')} · ${total}`;

  const panelMeta =
    total === undefined
      ? undefined
      : t('admin.dashboard.recent.metaTotal', { count: total });

  return (
    <TeamDashboardShell
      title={title}
      subtitle={t('admin.dashboard.projects.shellSubtitle')}
      icon={<FolderOpen className="h-5 w-5" aria-hidden />}
      actions={
        <Link
          href="/admin/dashboard/new"
          className="ls-cta ls-cta--sm inline-flex shrink-0 items-center gap-1.5"
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t('admin.dashboard.cta.newProject')}
        </Link>
      }
    >
      <Panel
        eyebrow={t('admin.dashboard.accounts.eyebrow')}
        title={t('admin.nav.projects')}
        meta={panelMeta}
        flush
      >
        <div className="border-b border-[var(--ls-rule)] px-5 py-3 sm:px-6">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ls-ink-faint)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, client, slug…"
              className="w-full rounded-xl border border-[var(--ls-rule)] bg-[var(--ls-glass-bg)] py-2 pl-9 pr-3 text-[13px] text-[var(--ls-ink)] placeholder:text-[var(--ls-ink-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--purple)]/25 dark:focus:ring-white/15"
            />
          </div>
        </div>

        {isLoading && <ListRowsSkeleton n={8} />}

        {error && !isLoading && (
          <div className="px-5 py-12 text-center sm:px-6">
            <p className="text-[13px] text-[var(--ls-ink-dim)]">
              Couldn&apos;t load projects. Refresh or check your access.
            </p>
          </div>
        )}

        {!isLoading && !error && filtered.length === 0 && (
          <div className="px-5 py-12 text-center sm:px-6">
            <div className="ls-admin-label">
              {search ? 'No matches' : t('admin.dashboard.projects.emptyTitle')}
            </div>
            <p className="mx-auto mt-2.5 max-w-xs text-[13px] text-[var(--ls-ink-dim)]">
              {search
                ? 'Try a different search term.'
                : t('admin.dashboard.projects.emptyBody')}
            </p>
            {!search && (
              <Link
                href="/admin/dashboard/new"
                className="ls-cta ls-cta--sm mx-auto mt-5 inline-flex items-center gap-1.5"
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden />
                {t('admin.dashboard.cta.newProject')}
              </Link>
            )}
          </div>
        )}

        {!isLoading && filtered.length > 0 && !error && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="fs-glass-header-row">
                  <ColHead className="w-[1.5rem] pl-5">{'\u00a0'}</ColHead>
                  <ColHead>{t('admin.dashboard.table.project')}</ColHead>
                  <ColHead>{t('admin.dashboard.table.account')}</ColHead>
                  <ColHead>{t('admin.dashboard.table.stage')}</ColHead>
                  <ColHead>{t('admin.dashboard.table.tier')}</ColHead>
                  <ColHead>Commerce</ColHead>
                  <ColHead className="text-right">
                    {t('admin.dashboard.table.updated')}
                  </ColHead>
                  <ColHead className="w-12 pr-5 text-right">{'\u00a0'}</ColHead>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const stage = (p.concierge_stage as string) || 'intake';
                  const tier = (p.tier_name as string) || '';
                  const hasCommerce =
                    (p.commerce_mode as string) &&
                    (p.commerce_mode as string) !== 'none';
                  const updatedAt = p.updated_at || p.created_at;
                  const tierKey =
                    tier && TIER_I18N_KEYS[tier] ? TIER_I18N_KEYS[tier] : null;
                  const stageKey = STAGE_I18N_KEYS[stage];
                  const client =
                    p.client_business_name ||
                    p.client_name ||
                    t('admin.dashboard.table.emptyAccount');

                  return (
                    <tr
                      key={p.id}
                      onClick={() =>
                        router.push(`/admin/dashboard/projects/${p.id}`)
                      }
                      className="group cursor-pointer border-b border-[var(--ls-rule)] last:border-b-0 transition-colors hover:bg-[var(--ls-glass-bg)]"
                    >
                      <td className="py-3 pl-5">
                        <span
                          aria-hidden
                          className="inline-block h-2 w-2 rounded-full"
                          style={stageDotStyle(stage)}
                        />
                      </td>
                      <td className="px-3 py-3">
                        <div className="truncate font-medium text-[var(--ls-ink)]">
                          {p.name || t('admin.dashboard.project.untitled')}
                        </div>
                        {p.slug && (
                          <div className="truncate font-mono text-[10.5px] text-[var(--ls-ink-faint)]">
                            {p.slug}
                          </div>
                        )}
                      </td>
                      <td className="max-w-[14rem] truncate px-3 py-3 text-[var(--ls-ink-dim)]">
                        <div className="truncate">{client}</div>
                        {p.client_email && (
                          <div className="truncate font-mono text-[10.5px] text-[var(--ls-ink-faint)]">
                            {p.client_email}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--ls-ink-dim)]">
                          {stageKey ? t(stageKey) : stage}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        {tierKey ? (
                          <span className="rounded-full border border-[var(--ls-rule)] px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--ls-ink-dim)]">
                            {t(tierKey)}
                          </span>
                        ) : (
                          <span className="text-[var(--ls-ink-faint)]">–</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {hasCommerce ? (
                          <span className="inline-flex items-center gap-1 text-xs text-[var(--ls-ink-dim)]">
                            <ShoppingBag className="h-3 w-3" aria-hidden />
                            {(p.commerce_provider as string) || 'custom'}
                          </span>
                        ) : (
                          <span className="text-xs text-[var(--ls-ink-faint)]">
                            –
                          </span>
                        )}
                      </td>
                      <td
                        className="px-3 py-3 text-right font-mono text-[10.5px] tabular-nums text-[var(--ls-ink-faint)]"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {updatedAt ? compactRelative(updatedAt) : '–'}
                      </td>
                      <td className="py-3 pr-5 text-right text-[var(--ls-ink-faint)]">
                        <ChevronRight className="ml-auto h-4 w-4" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </TeamDashboardShell>
  );
}
