import type { CSSProperties } from 'react';

/**
 * glass.ts — Shared glass card style utilities.
 *
 * Use these instead of hand-rolling bg-white/95 backdrop-blur-2xl patterns.
 * All values come from --fs-* design tokens defined in brand.css.
 *
 * Usage:
 *   <div className={glassClass} style={glassStyle}>...</div>
 *   <div className={`${glassClass} p-6`} style={glassStyle}>...</div>
 *
 * Or just use <GlassCard> from '@flowstarter/flow-design-system' which wraps this.
 */

/** Tailwind structural classes — no color values */
export const glassClass =
  'rounded-[var(--fs-radius-xl)] border backdrop-blur-xl backdrop-saturate-125';

/** Inline style object — resolves --fs-* tokens at runtime for dark/light */
export const glassStyle: CSSProperties = {
  background: 'var(--fs-glass-bg)',
  borderColor: 'var(--fs-glass-edge)',
  boxShadow: 'var(--fs-card-shadow)',
};

/** Hover variant — adds lift on interactive cards */
export const glassHoverClass =
  'rounded-[var(--fs-radius-xl)] border backdrop-blur-xl backdrop-saturate-125 transition-all duration-200 hover:-translate-y-0.5';

/** Skeleton pulse placeholder using token colors */
export const skeletonClass = 'bg-[var(--fs-rule)] rounded animate-pulse';

export const sidebarNavBaseClass =
  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150';
/** The accent tone wash, the same pairing `.fs-glass-tile[data-tone='accent']`
 * uses: the soft tint as the fill, the tone ink as the text, the edge token
 * as a hairline ring — so the active item reads as "this surface's accent"
 * rather than a one-off purple pill. */
export const sidebarNavActiveClass =
  'bg-[var(--fs-tone-accent-soft)] text-[var(--fs-tone-accent)] font-semibold shadow-[inset_0_0_0_1px_var(--fs-tone-accent-edge)]';
export const sidebarNavIdleClass =
  'text-[var(--fs-ink-dim)] hover:bg-[var(--fs-bg-elevated)]/75 hover:text-[var(--fs-ink)]';
export const sidebarSectionLabelClass =
  'mb-2 px-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--fs-ink-faint)]';

export function getSidebarToggleButtonClass(
  resolvedTheme: 'light' | 'dark' | undefined
): string {
  const darkClass =
    'border-white/20 bg-white/[0.10] text-white shadow-[0_8px_22px_rgba(0,0,0,0.35)] hover:border-white/30 hover:bg-white/[0.16]';
  const lightClass =
    'border-slate-300/90 bg-white text-slate-700 shadow-[0_8px_20px_rgba(15,23,42,0.14)] hover:border-slate-400/85 hover:bg-slate-50';
  return [
    'group inline-flex h-8 w-8 items-center justify-center rounded-md border transition-all duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fs-accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent',
    resolvedTheme === 'dark' ? darkClass : lightClass,
  ].join(' ');
}

export const sidebarFooterToggleClass = [
  'group w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150',
  'text-[var(--fs-ink-faint)] hover:bg-[var(--fs-bg-elevated)]/75 hover:text-[var(--fs-ink)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fs-accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent',
].join(' ');
