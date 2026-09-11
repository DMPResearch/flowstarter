'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { useTranslations } from '@/lib/i18n';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { GlassSurface } from '@flowstarter/flow-design-system';

type ActivityTab = 'projects' | 'accounts';

export function DashboardActivityTabs({
  projectsMeta,
  accountsMeta,
  projectsContent,
  accountsContent,
  className = '',
}: {
  projectsMeta?: string;
  accountsMeta?: string;
  projectsContent: ReactNode;
  accountsContent: ReactNode;
  className?: string;
}) {
  const { t } = useTranslations();
  const [tab, setTab] = useState<ActivityTab>('projects');

  const meta = tab === 'projects' ? projectsMeta : accountsMeta;
  const viewAllHref =
    tab === 'projects'
      ? '/admin/dashboard/projects'
      : '/admin/dashboard/clients';

  const tabTriggerClass = cn(
    'h-auto flex-none rounded-none border-0 border-b-2 border-transparent bg-transparent px-1 py-2.5 sm:px-2',
    'font-mono text-[11px] uppercase leading-none tracking-[0.18em] text-[var(--fs-ink-faint)] shadow-none backdrop-blur-none',
    'data-[state=active]:!bg-transparent data-[state=active]:border-[var(--fs-tone-accent)] data-[state=active]:text-[var(--fs-tone-accent)]',
    'data-[state=active]:shadow-none',
    '[@media(hover:hover)]:hover:text-[var(--fs-ink-dim)]'
  );

  return (
    <GlassSurface
      as="section"
      variant="panel"
      className={cn('!gap-0 !p-0 overflow-hidden', className)}
    >
      <header className="fs-glass-header-row flex items-end justify-between gap-4 border-b border-[var(--fs-glass-edge)] px-5 py-3.5 sm:px-6">
        <div>
          <div
            className="fs-tone-text text-xs font-semibold uppercase tracking-widest"
            data-tone="accent"
          >
            {t('admin.dashboard.activity.eyebrow')}
          </div>
          <h2 className="mt-0.5 text-[15px] font-medium tracking-[-0.005em] text-[var(--fs-ink)]">
            {t('admin.dashboard.activity.title')}
          </h2>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 sm:gap-4">
          {meta ? (
            <span className="hidden max-w-md text-right text-[13px] leading-snug text-[var(--fs-ink-dim)] sm:inline">
              {meta}
            </span>
          ) : null}
          <Link
            href={viewAllHref}
            className="inline-flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--fs-ink-dim)] hover:text-[var(--fs-ink)]"
          >
            {t('admin.dashboard.viewAll')}
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      </header>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as ActivityTab)}
        className="gap-0"
      >
        <div className="border-b border-[var(--fs-glass-edge)] px-5 sm:px-6">
          <TabsList
            className={cn(
              'h-auto min-h-0 w-full justify-start gap-4 sm:gap-6',
              'rounded-none border-0 bg-transparent p-0 shadow-none backdrop-blur-none',
              'dark:border-transparent'
            )}
            style={{
              backgroundColor: 'transparent',
              boxShadow: 'none',
              border: 'none',
            }}
          >
            <TabsTrigger value="projects" className={tabTriggerClass}>
              {t('admin.dashboard.activity.tab.projects')}
            </TabsTrigger>
            <TabsTrigger value="accounts" className={tabTriggerClass}>
              {t('admin.dashboard.activity.tab.accounts')}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="projects" className="mt-0 outline-none">
          {projectsContent}
        </TabsContent>
        <TabsContent value="accounts" className="mt-0 outline-none">
          {accountsContent}
        </TabsContent>
      </Tabs>
    </GlassSurface>
  );
}
