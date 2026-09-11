import { Mail, Phone } from 'lucide-react';
import { useTranslations } from '@/lib/i18n';
import { compactRelative, formatEuro, getInitials } from '@/lib/format-utils';
import { TIER_I18N_KEYS, type Client } from './dashboard.constants';
import { ColHead, RowsSkeleton } from './ProjectsTable';

// ─── ClientsTable ───────────────────────────────────────────────────────────

export function ClientsTable({
  rows,
  loading,
}: {
  rows: Client[];
  loading: boolean;
}) {
  const { t } = useTranslations();
  if (loading) return <RowsSkeleton n={6} />;
  if (rows.length === 0) return <ClientsEmpty />;

  return (
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
          {rows.map((c) => (
            <ClientRowItem key={c.key} client={c} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Row ────────────────────────────────────────────────────────────────────

function ClientRowItem({ client }: { client: Client }) {
  const { t } = useTranslations();
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
    <tr className="group border-b border-[var(--ls-rule)] last:border-b-0 transition-colors hover:bg-[var(--ls-glass-bg)]">
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
      <td className="py-3 pr-5 text-right">
        <div className="inline-flex items-center gap-1 opacity-0 group-hover:opacity-100">
          {client.email && (
            <a
              href={`mailto:${client.email}`}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--ls-ink-faint)] hover:bg-[var(--ls-rule)] hover:text-[var(--ls-ink)]"
              aria-label={t('admin.dashboard.clients.emailAria', {
                name: display,
              })}
              title={t('admin.dashboard.clients.emailAria', { name: display })}
            >
              <Mail className="h-3.5 w-3.5" />
            </a>
          )}
          {client.phone && (
            <a
              href={`tel:${client.phone}`}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--ls-ink-faint)] hover:bg-[var(--ls-rule)] hover:text-[var(--ls-ink)]"
              aria-label={t('admin.dashboard.clients.callAria', {
                name: display,
              })}
              title={t('admin.dashboard.clients.callAria', { name: display })}
            >
              <Phone className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function ClientsEmpty() {
  const { t } = useTranslations();
  return (
    <div className="px-5 py-12 text-center">
      <div className="ls-admin-label">
        {t('admin.dashboard.clients.emptyTitle')}
      </div>
      <p className="mx-auto mt-2.5 max-w-md text-[13px] text-[var(--ls-ink-dim)]">
        {t('admin.dashboard.clients.emptyBody')}
      </p>
    </div>
  );
}
