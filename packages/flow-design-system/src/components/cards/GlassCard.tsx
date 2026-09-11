/**
 * A card, kept for the call sites that already use it.
 *
 * The glass now comes from GlassSurface, so this file holds nothing but the
 * mapping from the old props to the new ones. Reach for GlassSurface directly
 * in new code; this stays so the migration does not have to be one commit.
 */
import React, {
  forwardRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { GlassSurface } from '../surfaces/GlassSurface';

export interface GlassCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: ReactNode;
  /** Visual weight variant */
  variant?: 'default' | 'elevated' | 'subtle';
  /** Disable hover lift & glow effects */
  noHover?: boolean;
  /** Render as a link (wraps in <a>) */
  href?: string;
  /** Render as a button (wraps in <button>) */
  as?: 'div' | 'button' | 'link';
  style?: CSSProperties;
}

export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  (
    {
      children,
      className = '',
      onClick,
      href,
      as = 'div',
      style,
      variant = 'default',
      noHover = false,
      ...props
    },
    ref,
  ) => {
    // `elevated` is the strong fill; `subtle` drops the drop shadow and keeps
    // only the refractive edge. Neither needs its own colours any more.
    const weight =
      variant === 'elevated'
        ? 'fs-glass--strong'
        : variant === 'subtle'
          ? 'shadow-none'
          : '';

    return (
      <GlassSurface
        ref={ref as React.Ref<HTMLElement>}
        variant="card"
        interactive={!noHover}
        as={
          as === 'link' && href
            ? 'a'
            : as === 'button' || onClick
              ? 'button'
              : 'div'
        }
        className={[weight, 'flex flex-col', className]
          .filter(Boolean)
          .join(' ')}
        style={style}
        onClick={onClick}
        {...(as === 'link' && href ? { href } : {})}
        {...(as === 'button' || (onClick && as !== 'link')
          ? { type: 'button' as const }
          : {})}
        {...props}
      >
        {children}
      </GlassSurface>
    );
  },
);

GlassCard.displayName = 'GlassCard';
