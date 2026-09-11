import type React from 'react';
import { GlassSurface } from '@flowstarter/flow-design-system';

export function Panel({
  eyebrow,
  title,
  meta,
  action,
  className = '',
  flush = false,
  children,
}: {
  eyebrow?: string;
  title: string;
  meta?: string;
  action?: React.ReactNode;
  className?: string;
  /** When true, the body has zero padding — for tables and the kanban that
   * manage their own internal layout. */
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <GlassSurface
      as="section"
      variant="panel"
      className={`!gap-0 !p-0 overflow-hidden ${className}`}
    >
      <header className="fs-glass-header-row flex items-end justify-between gap-4 border-b border-[var(--fs-glass-edge)] px-5 py-3.5 sm:px-6">
        <div>
          {eyebrow && (
            <div
              className="fs-tone-text text-xs font-semibold uppercase tracking-widest"
              data-tone="accent"
            >
              {eyebrow}
            </div>
          )}
          <h2 className="mt-0.5 text-[15px] font-medium tracking-[-0.005em] text-[var(--fs-ink)]">
            {title}
          </h2>
        </div>
        <div className="flex items-center gap-4">
          {meta && (
            <span className="hidden max-w-md text-right text-[13px] leading-snug text-[var(--fs-ink-dim)] sm:inline">
              {meta}
            </span>
          )}
          {action}
        </div>
      </header>
      <div className={flush ? '' : 'p-5 sm:p-6'}>{children}</div>
    </GlassSurface>
  );
}
