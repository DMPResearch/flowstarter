/**
 * A stat card with a breakdown and a footer, kept for the call sites that
 * already use it.
 *
 * The zinc palette and the hand-written shadow stack are gone; the surface is
 * a GlassSurface card and the text reads --fs-ink tokens, so it now matches
 * the rest of the product in both modes. For a single number on tinted glass,
 * use StatTile instead.
 */
import React, { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { GlassSurface } from '../surfaces/GlassSurface';

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  value: ReactNode;
  breakdown?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
}

export const StatCard = forwardRef<HTMLDivElement, StatCardProps>(
  (
    { title, value, breakdown, action, footer, className = '', ...props },
    ref,
  ) => (
    <GlassSurface
      ref={ref as React.Ref<HTMLElement>}
      variant="card"
      className={className}
      {...props}
    >
      <div className="mb-2 flex items-start justify-between">
        <span className="text-sm text-[var(--fs-ink-dim)]">{title}</span>
        {action}
      </div>
      <div className="mb-2 text-2xl font-bold tabular-nums text-[var(--fs-ink)]">
        {value}
      </div>
      {breakdown && (
        <div className="flex flex-wrap items-center gap-3">{breakdown}</div>
      )}
      {footer && (
        <div className="mt-4 border-t border-[var(--fs-rule)] pt-3">
          {footer}
        </div>
      )}
    </GlassSurface>
  ),
);

StatCard.displayName = 'StatCard';
