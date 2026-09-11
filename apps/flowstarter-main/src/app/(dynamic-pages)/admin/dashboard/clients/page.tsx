'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Mail, Phone, Plus, Search, Users, ChevronRight } from 'lucide-react';
import { useTranslations, type TranslationKeys } from '@/lib/i18n';
import { compactRelative, formatEuro, getInitials } from '@/lib/format-utils';
import { TeamDashboardShell } from '../components/TeamDashboardShell';
import { Panel } from '../components/Panel';

/** Mirrors `GET /api/admin/clients` response rows. */
interface Client {
  key: string;
  name: string;
  email: string;
  phone: string;
  businessName: string;
  projectCount: number;
  totalFee: number;
  stages: string[];
  tiers: string[];
  deployStatuses: string[];
  lastActivity: string;
  commerceProjectCount?: number;
  commerceProductCount?: number;
  commerceProviders?: string[];
  commerceStatuses?: string[];
  commerceProductTypes?: string[];
}

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

function ClientRowItem({ client }: { client: Client }) {
  const { t } = useTranslations();
  const router = useRouter();
  const dash = t('admin.dashboard.table.emptyAccount');
  const display =
    client.businessName ||
    client.name ||
    client.email ||
    t('admin.dashboard.clients.unnamed');
  const subline =
    client.businessName && client.name
      ? client.name
      : client.email && (client.businessName || client.name)
      ? client.email
      : '';
  const initials = getInitials(
    client.businessName || client.name || client.email
  );
  const tierLabel = client.tiers
    .map((tier) => (TIER_I18N_KEYS[tier] ? t(TIER_I18N_KEYS[tier]!) : tier))
    .filter(Boolean)
    .join(', ');

  return (
    <tr
      onClick={() =>
        router.push(`/admin/dashboard?client=${encodeURIComponent(client.key)}`)
      }
      className="group cursor-pointer border-b border-[var(--ls-rule)] last:border-b-0 transition-colors hover:bg-[var(--ls-glass-bg)]"
    >
      <td className="py-3 pl-5">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--ls-rule)] bg-[var(--ls-bg)] font-mono text-[10.5px] font-medium uppercase text-[var(--ls-ink-dim)]">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium text-[var(--ls-ink)]">
              {display}
            </div>
            {subline && (
              <div className="truncate text-[11.5px] text-[var(--ls-ink-faint)]">
                {subline}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="max-w-[14rem] truncate px-3 py-3 text-[var(--ls-ink-dim)]">
        <div className="flex flex-col">
          {client.email ? (
            <span className="truncate text-[13px]">{client.email}</span>
          ) : null}
          {client.phone ? (
            <span className="font-mono text-[10.5px] text-[var(--ls-ink-faint)]">
              {client.phone}
            </span>
          ) : null}
          {!client.email && !client.phone && (
            <span className="text-[var(--ls-ink-faint)]">–</span>
          )}
        </div>
      </td>
      <td className="px-3 py-3">
        {tierLabel ? (
          <span className="rounded-full border border-[var(--ls-rule)] px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--ls-ink-dim)]">
            {tierLabel}
          </span>
        ) : (
          <span className="text-[var(--ls-ink-faint)]">–</span>
        )}
      </td>
      <td
        className="px-3 py-3 text-right font-mono text-[12.5px] tabular-nums text-[var(--ls-ink)]"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {client.projectCount}
      </td>
      <td
        className="px-3 py-3 text-right font-mono text-[12.5px] tabular-nums text-[var(--ls-ink-dim)]"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {formatEuro(client.totalFee || 0)}
      </td>
      <td
        className="px-3 py-3 text-right font-mono text-[10.5px] tabular-nums text-[var(--ls-ink-faint)]"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {client.lastActivity ? compactRelative(client.lastActivity) : dash}
      </td>
      <td className="py-3 pr-5 text-right text-[var(--ls-ink-faint)]">
        <div className="inline-flex items-center justify-end gap-1">
          <div className="inline-flex items-center gap-1 opacity-0 group-hover:opacity-100">
            {client.email && (
              <a
                href={`mailto:${client.email}`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--ls-ink-faint)] hover:bg-[var(--ls-rule)] hover:text-[var(--ls-ink)]"
                aria-label={t('admin.dashboard.clients.emailAria', {
                  name: display,
                })}
                title={t('admin.dashboard.clients.emailAria', {
                  name: display,
                })}
              >
                <Mail className="h-3.5 w-3.5" />
              </a>
            )}
            {client.phone && (
              <a
                href={`tel:${client.phone}`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--ls-ink-faint)] hover:bg-[var(--ls-rule)] hover:text-[var(--ls-ink)]"
                aria-label={t('admin.dashboard.clients.callAria', {
                  name: display,
                })}
                title={t('admin.dashboard.clients.callAria', {
                  name: display,
                })}
              >
                <Phone className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
          <ChevronRight className="ml-1 h-4 w-4 shrink-0" aria-hidden />
        </div>
      </td>
    </tr>
  );
}

export default function ClientsPage() {
  const { t } = useTranslations();
  const [search, setSearch] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['team-clients'],
    queryFn: async (): Promise<Client[]> => {
      const res = await fetch('/api/admin/clients', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load clients');
      const json = (await res.json()) as { clients: Client[] };
      return json.clients ?? [];
    },
    staleTime: 20_000,
    retry: 1,
  });

  const clients = data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => {
      const haystack = [c.name, c.email, c.phone, c.businessName, c.key]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [clients, search]);

  const count = data === undefined ? undefined : clients.length;
  const title =
    count === undefined
      ? t('admin.nav.accounts')
      : `${t('admin.nav.accounts')} · ${count}`;
  const panelMeta =
    count === undefined
      ? undefined
      : t('admin.dashboard.accounts.meta', { count });

  return (
    <TeamDashboardShell
      title={title}
      icon={<Users className="h-5 w-5" aria-hidden />}
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
        title={t('admin.nav.accounts')}
        meta={panelMeta}
        flush
      >
        <div className="border-b border-[var(--ls-rule)] px-5 py-3 sm:px-6">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ls-ink-faint)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, phone…"
              className="w-full rounded-xl border border-[var(--ls-rule)] bg-[var(--ls-glass-bg)] py-2 pl-9 pr-3 text-[13px] text-[var(--ls-ink)] placeholder:text-[var(--ls-ink-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--purple)]/25 dark:focus:ring-white/15"
            />
          </div>
        </div>

        {isLoading && <ListRowsSkeleton n={8} />}

        {error && !isLoading && (
          <div className="px-5 py-12 text-center sm:px-6">
            <p className="text-[13px] text-[var(--ls-ink-dim)]">
              Couldn&apos;t load accounts. Refresh or check your access.
            </p>
          </div>
        )}

        {!isLoading && !error && filtered.length === 0 && (
          <div className="px-5 py-12 text-center sm:px-6">
            <div className="ls-admin-label">
              {search ? 'No matches' : t('admin.dashboard.clients.emptyTitle')}
            </div>
            <p className="mx-auto mt-2.5 max-w-xs text-[13px] text-[var(--ls-ink-dim)]">
              {search
                ? 'Try a different search term.'
                : t('admin.dashboard.clients.emptyBody')}
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
                  <ColHead className="pl-5">
                    {t('admin.dashboard.clients.col.account')}
                  </ColHead>
                  <ColHead>{t('admin.dashboard.clients.col.contact')}</ColHead>
                  <ColHead>{t('admin.dashboard.clients.col.tier')}</ColHead>
                  <ColHead className="text-right">
                    {t('admin.dashboard.clients.col.projects')}
                  </ColHead>
                  <ColHead className="text-right">
                    {t('admin.dashboard.clients.col.setupPaid')}
                  </ColHead>
                  <ColHead className="text-right">
                    {t('admin.dashboard.clients.col.lastActivity')}
                  </ColHead>
                  <ColHead className="w-24 pr-5 text-right">
                    {t('admin.dashboard.clients.col.actions')}
                  </ColHead>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <ClientRowItem key={c.key} client={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </TeamDashboardShell>
  );
}
