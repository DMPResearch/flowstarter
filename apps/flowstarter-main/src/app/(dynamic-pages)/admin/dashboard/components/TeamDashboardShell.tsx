'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { GlassSurface } from '@flowstarter/flow-design-system';
import { cn } from '@/lib/utils';
import { AdminDashboardSubheadline } from './AdminDashboardSubheadline';

interface TeamDashboardShellProps {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
  showBackButton?: boolean;
  maxWidth?:
    | 'sm'
    | 'md'
    | 'lg'
    | 'xl'
    | '2xl'
    | '3xl'
    | '4xl'
    | '5xl'
    | '6xl'
    | '7xl'
    /** Same horizontal cap as `DashboardChrome` / main admin dashboard. */
    | 'dashboard';
  /** Merged onto the outer shell wrapper (e.g. scoped theme classes). */
  className?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}

export function TeamDashboardShell({
  icon,
  title,
  subtitle,
  backHref = '/admin/dashboard',
  backLabel = 'Dashboard',
  showBackButton = false,
  maxWidth = 'dashboard',
  className,
  children,
  actions,
}: TeamDashboardShellProps) {
  const maxWidthClass = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '3xl': 'max-w-3xl',
    '4xl': 'max-w-4xl',
    '5xl': 'max-w-5xl',
    '6xl': 'max-w-6xl',
    '7xl': 'max-w-7xl',
    dashboard: 'max-w-[1280px] w-full',
  }[maxWidth];

  return (
    <div
      className={cn(
        'ls-scope ls-admin-dashboard px-4 pb-16 pt-8 sm:px-6 lg:px-8',
        className
      )}
    >
      <div className={cn(maxWidthClass, 'mx-auto')}>
        {/* Back */}
        {showBackButton && (
          <Link
            href={backHref}
            className="mb-6 inline-flex items-center gap-1.5 text-sm text-[var(--ls-ink-dim)] transition-colors hover:text-[var(--ls-ink)]"
          >
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {backLabel}
          </Link>
        )}

        {/* Page header */}
        {(icon || title) && (
          <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              {icon && (
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[var(--ls-rule)] bg-[var(--ls-glass-bg)] text-[var(--ls-accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                  aria-hidden
                >
                  {icon}
                </div>
              )}
              <div className="min-w-0">
                <h1 className="ls-display ls-display--sm">{title}</h1>
                {subtitle ? (
                  <AdminDashboardSubheadline text={subtitle} />
                ) : null}
              </div>
            </div>
            {actions && (
              <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
                {actions}
              </div>
            )}
          </header>
        )}

        {children}
      </div>
    </div>
  );
}

// Reusable section card used inside the shell — the shared GlassSurface, not
// a hand-rolled `bg-white backdrop-blur` box, so every tab and card that
// reaches for `ShellCard` picks up the material for free.
export function ShellCard({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <GlassSurface variant="card" className={className}>
      {children}
    </GlassSurface>
  );
}

// Section title inside a card
export function ShellSection({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {title && (
        <h2 className="mb-4 text-sm font-semibold tracking-tight text-[var(--ls-ink-dim)]">
          {title}
        </h2>
      )}
      {children}
    </div>
  );
}
