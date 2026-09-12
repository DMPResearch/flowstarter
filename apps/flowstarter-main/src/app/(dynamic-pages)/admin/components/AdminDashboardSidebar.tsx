'use client';

import { DashboardSidebarShell } from '@/components/ui/dashboard-sidebar-shell';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations, type TranslationKeys } from '@/lib/i18n';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { useSidebar } from '@/contexts/SidebarContext';
import {
  LayoutDashboard,
  BarChart3,
  Users,
  ShieldCheck,
  Sparkles as SparklesIcon,
  FolderOpen,
  GitBranch,
  Inbox,
  MessageSquare,
  Server,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect } from 'react';
import {
  sidebarNavActiveClass,
  sidebarNavBaseClass,
  sidebarNavIdleClass,
  sidebarSectionLabelClass,
} from '@/lib/glass';

type NavItem = {
  labelKey: TranslationKeys;
  href: string;
  icon: LucideIcon;
};

/**
 * Left navigation for `/admin/dashboard/*`.
 * (Previously misnamed `TeamSidebar` — this is operator admin UI, not end-user "team" product chrome.)
 */
export function AdminDashboardSidebar() {
  const pathname = usePathname();
  const { t } = useTranslations();
  const { isCollapsed, setIsCollapsed, isMobileOpen, setIsMobileOpen } =
    useSidebar();

  const operationsItems: ReadonlyArray<NavItem> = [
    {
      labelKey: 'admin.nav.projects',
      href: '/admin/dashboard/projects',
      icon: FolderOpen,
    },
    {
      labelKey: 'admin.nav.pipeline',
      href: '/admin/dashboard/pipeline',
      icon: GitBranch,
    },
    {
      labelKey: 'admin.nav.accounts',
      href: '/admin/dashboard/clients',
      icon: Users,
    },
    {
      labelKey: 'admin.nav.leads',
      href: '/admin/dashboard/leads',
      icon: Inbox,
    },
    {
      labelKey: 'admin.nav.inquiries',
      href: '/admin/dashboard/inquiries',
      icon: MessageSquare,
    },
    {
      labelKey: 'admin.nav.contactMessages',
      href: '/admin/dashboard/contact-messages',
      icon: Inbox,
    },
  ];

  const infrastructureItems: ReadonlyArray<NavItem> = [
    {
      labelKey: 'admin.nav.hosting',
      href: '/admin/dashboard/hosting',
      icon: Server,
    },
  ];

  const insightsItems: ReadonlyArray<NavItem> = [
    {
      labelKey: 'admin.nav.analytics',
      href: '/admin/dashboard/analytics',
      icon: BarChart3,
    },
    {
      labelKey: 'admin.nav.aiUsage',
      href: '/admin/dashboard/ai-usage',
      icon: SparklesIcon,
    },
  ];

  const workspaceItems: ReadonlyArray<NavItem> = [
    {
      labelKey: 'admin.nav.teamMembers',
      href: '/admin/dashboard/team',
      icon: ShieldCheck,
    },
    {
      labelKey: 'admin.nav.settings',
      href: '/admin/dashboard/profile',
      icon: SettingsIcon,
    },
  ];

  useEffect(() => {
    setIsMobileOpen(false);
  }, [pathname, setIsMobileOpen]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMobileOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [setIsMobileOpen]);

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href;
    return pathname?.startsWith(href);
  };

  const NavLink = ({
    href,
    icon: Icon,
    label,
    exact,
    showLabel = true,
  }: {
    href: string;
    icon: LucideIcon;
    label: string;
    exact?: boolean;
    showLabel?: boolean;
  }) => {
    const linkNode = (
      <Link
        href={href}
        onClick={() => setIsMobileOpen(false)}
        className={cn(
          sidebarNavBaseClass,
          isActive(href, exact) ? sidebarNavActiveClass : sidebarNavIdleClass,
          !showLabel && 'justify-center !px-0 w-11 mx-auto'
        )}
      >
        <Icon className="h-4 w-4 flex-shrink-0" />
        {showLabel && <span className="truncate">{label}</span>}
      </Link>
    );

    if (!showLabel) {
      return (
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>{linkNode}</TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {label}
          </TooltipContent>
        </Tooltip>
      );
    }

    return linkNode;
  };

  const renderContent = (showLabel: boolean) => (
    <div
      className={cn(
        'flex h-full flex-col space-y-6 py-4 pl-4 pr-6',
        !showLabel && 'items-center'
      )}
    >
      <div className={cn('space-y-1', !showLabel && 'w-full')}>
        <NavLink
          href="/admin/dashboard"
          icon={LayoutDashboard}
          label={t('admin.nav.dashboard')}
          exact
          showLabel={showLabel}
        />
      </div>

      <div className={cn(!showLabel && 'w-full')}>
        {showLabel && (
          <h3 className={sidebarSectionLabelClass}>
            {t('admin.sidebar.section.operations')}
          </h3>
        )}
        <div className="space-y-1">
          {operationsItems.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={t(item.labelKey)}
              showLabel={showLabel}
            />
          ))}
        </div>
      </div>

      <div className={cn(!showLabel && 'w-full')}>
        {showLabel && (
          <h3 className={sidebarSectionLabelClass}>
            {t('admin.sidebar.section.infrastructure')}
          </h3>
        )}
        <div className="space-y-1">
          {infrastructureItems.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={t(item.labelKey)}
              showLabel={showLabel}
            />
          ))}
        </div>
      </div>

      <div className={cn(!showLabel && 'w-full')}>
        {showLabel && (
          <h3 className={sidebarSectionLabelClass}>
            {t('admin.sidebar.section.insights')}
          </h3>
        )}
        <div className="space-y-1">
          {insightsItems.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={t(item.labelKey)}
              showLabel={showLabel}
            />
          ))}
        </div>
      </div>

      <div className={cn(!showLabel && 'w-full')}>
        {showLabel && (
          <h3 className={sidebarSectionLabelClass}>
            {t('admin.sidebar.section.workspace')}
          </h3>
        )}
        <div className="space-y-1">
          {workspaceItems.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={t(item.labelKey)}
              showLabel={showLabel}
            />
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <DashboardSidebarShell
      collapsed={isCollapsed}
      onToggleCollapsed={() => setIsCollapsed(!isCollapsed)}
      isMobileOpen={isMobileOpen}
      setIsMobileOpen={setIsMobileOpen}
      renderContent={renderContent}
      expandedWidthClass="w-52 lg:w-60"
      mobileTopArea={
        <div className="flex items-center justify-between border-b border-[var(--fs-rule)] px-4 py-3">
          <span className="text-sm text-[var(--fs-ink-dim)]">
            {t('admin.mobile.theme')}
          </span>
          <ThemeToggle />
        </div>
      }
    />
  );
}
