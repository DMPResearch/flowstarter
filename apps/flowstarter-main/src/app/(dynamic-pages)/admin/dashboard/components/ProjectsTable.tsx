'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { Plus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Pill } from '@flowstarter/flow-design-system/components/surfaces/Pill';
import { useTranslations } from '@/lib/i18n';
import { compactRelative } from '@/lib/format-utils';
import {
  useTeamRenameProject,
  useTeamDeleteProject,
} from '@/hooks/useTeamProjects';
import {
  STAGE_I18N_KEYS,
  TIER_I18N_KEYS,
  stageDotStyle,
} from './dashboard.constants';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProjectRow = {
  id: string;
  name: string | null;
  slug: string | null;
  client_name: string | null;
  client_business_name: string | null;
  concierge_stage: string | null;
  tier_name?: string | null;
  updated_at: string;
  created_at: string;
};

// ─── Shared table primitives ────────────────────────────────────────────────

export function ColHead({
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

export function RowsSkeleton({ n }: { n: number }) {
  return (
    <ul className="divide-y divide-[var(--ls-rule)]">
      {Array.from({ length: n }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-5 py-3">
          <span className="h-2 w-2 rounded-full bg-[var(--ls-rule)]" />
          <div className="h-3 flex-1 animate-pulse rounded-sm bg-[var(--ls-rule)]" />
          <div className="h-3 w-16 animate-pulse rounded-sm bg-[var(--ls-rule)]" />
        </li>
      ))}
    </ul>
  );
}

// ─── ProjectsTable ──────────────────────────────────────────────────────────

export function ProjectsTable({
  rows,
  loading,
  onOpen,
}: {
  rows: ProjectRow[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslations();
  if (loading) return <RowsSkeleton n={6} />;
  if (rows.length === 0) return <ProjectsEmpty />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13.5px]">
        <thead>
          <tr className="fs-glass-header-row">
            <ColHead className="w-[1.5rem] pl-5"> </ColHead>
            <ColHead>{t('admin.dashboard.table.project')}</ColHead>
            <ColHead>{t('admin.dashboard.table.account')}</ColHead>
            <ColHead>{t('admin.dashboard.table.tier')}</ColHead>
            <ColHead>{t('admin.dashboard.table.stage')}</ColHead>
            <ColHead className="text-right">
              {t('admin.dashboard.table.updated')}
            </ColHead>
            <ColHead className="w-12 pr-5 text-right"> </ColHead>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <ProjectRowItem key={p.id} project={p} onOpen={onOpen} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Row ────────────────────────────────────────────────────────────────────

function ProjectRowItem({
  project,
  onOpen,
}: {
  project: ProjectRow;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslations();
  const stage = project.concierge_stage || 'intake';
  const updatedAt = project.updated_at || project.created_at;
  const client =
    project.client_business_name ||
    project.client_name ||
    t('admin.dashboard.table.emptyAccount');
  const tierKey =
    project.tier_name && TIER_I18N_KEYS[project.tier_name]
      ? TIER_I18N_KEYS[project.tier_name]
      : null;
  const stageKey = STAGE_I18N_KEYS[stage];

  return (
    <tr
      onClick={() => onOpen(project.id)}
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
          {project.name || t('admin.dashboard.project.untitled')}
        </div>
        {project.slug && (
          <div className="truncate font-mono text-[10.5px] text-[var(--ls-ink-faint)]">
            {project.slug}
          </div>
        )}
      </td>
      <td className="max-w-[14rem] truncate px-3 py-3 text-[var(--ls-ink-dim)]">
        {client}
      </td>
      <td className="px-3 py-3">
        {tierKey ? (
          <Pill tone="neutral" size="sm">
            {t(tierKey)}
          </Pill>
        ) : (
          <span className="text-[var(--ls-ink-faint)]">-</span>
        )}
      </td>
      <td className="px-3 py-3">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--ls-ink-dim)]">
          {stageKey ? t(stageKey) : stage}
        </span>
      </td>
      <td
        className="px-3 py-3 text-right font-mono text-[10.5px] tabular-nums text-[var(--ls-ink-faint)]"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {updatedAt ? compactRelative(updatedAt) : '-'}
      </td>
      <td className="py-3 pr-5 text-right">
        <ProjectActions project={project} />
      </td>
    </tr>
  );
}

// ─── Actions menu ───────────────────────────────────────────────────────────

function ProjectActions({ project }: { project: ProjectRow }) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const rename = useTeamRenameProject();
  const remove = useTeamDeleteProject();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleRename = () => {
    setOpen(false);
    const next = window.prompt(
      t('admin.dashboard.project.renamePrompt'),
      project.name ?? ''
    );
    if (next == null || next.trim() === '' || next === project.name) return;
    rename.mutate({ id: project.id, name: next.trim() });
  };

  const handleDelete = () => {
    setOpen(false);
    const confirmText = project.name
      ? t('admin.dashboard.project.deleteConfirm', { name: project.name })
      : t('admin.dashboard.project.deleteConfirmUnnamed');
    if (!window.confirm(confirmText)) return;
    remove.mutate(project.id);
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--ls-ink-faint)] opacity-0 transition-opacity hover:bg-[var(--ls-rule)] hover:text-[var(--ls-ink)] group-hover:opacity-100"
        aria-label={t('admin.dashboard.project.actions.label')}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-[10px] border border-[var(--ls-rule)] bg-[var(--ls-bg)] py-1 text-[13px] shadow-[0_18px_40px_rgba(18,10,34,0.14)]"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleRename}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--ls-ink-dim)] hover:bg-[var(--ls-glass-bg)] hover:text-[var(--ls-ink)]"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t('admin.dashboard.project.actions.rename')}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('admin.dashboard.project.actions.delete')}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function ProjectsEmpty() {
  const { t } = useTranslations();
  return (
    <div className="px-5 py-12 text-center">
      <div className="ls-admin-label">
        {t('admin.dashboard.projects.emptyTitle')}
      </div>
      <p className="mx-auto mt-2.5 max-w-xs text-[13px] text-[var(--ls-ink-dim)]">
        {t('admin.dashboard.projects.emptyBody')}
      </p>
      <Link
        href="/admin/dashboard/new"
        className="ls-cta ls-cta--sm mx-auto mt-5 inline-flex items-center gap-1.5"
      >
        <Plus className="h-4 w-4 shrink-0" aria-hidden />
        {t('admin.dashboard.cta.newProject')}
      </Link>
    </div>
  );
}
