/**
 * A panel, kept for the call sites that already use it.
 *
 * The hand-rolled two-tone border it used to draw is now the refractive edge
 * on GlassSurface, so the borrowed --glass-* aliases are gone and the panel
 * reads from the same tokens as everything else. Prefer GlassSurface with
 * variant="panel" in new code.
 */
import React, { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { GlassSurface } from '../surfaces/GlassSurface';

export interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  shadow?: 'none' | 'subtle' | 'elevated' | 'glass';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  children: ReactNode;
}

/** The old shadow names, mapped onto the token scale. */
const shadowStyles: Record<NonNullable<GlassPanelProps['shadow']>, string> = {
  none: 'shadow-none',
  subtle: 'shadow-[var(--fs-shadow-sm)]',
  elevated: 'shadow-[var(--fs-shadow-lg)]',
  glass: '',
};

/** The old padding names. `md` is what GlassSurface already gives a panel. */
const paddings: Record<NonNullable<GlassPanelProps['padding']>, string> = {
  none: 'p-0',
  sm: 'p-3',
  md: 'p-5',
  lg: '',
};

export const GlassPanel = forwardRef<HTMLDivElement, GlassPanelProps>(
  (
    { shadow = 'glass', padding = 'md', children, className = '', ...props },
    ref,
  ) => (
    <GlassSurface
      ref={ref as React.Ref<HTMLElement>}
      variant="panel"
      className={[shadowStyles[shadow], paddings[padding], className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
    </GlassSurface>
  ),
);

GlassPanel.displayName = 'GlassPanel';
