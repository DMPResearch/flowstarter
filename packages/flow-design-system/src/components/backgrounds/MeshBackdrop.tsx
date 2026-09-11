/**
 * The gradient mesh the glass refracts.
 *
 * Liquid glass only reads as glass when there is something behind it worth
 * blurring. This is that something: a slow, full-bleed gradient in the brand's
 * warm cream and indigo, fixed to the viewport and painted at z-index 0 so a
 * layout can lift its content to z-index 10 over the top.
 *
 * It is a sibling of FlowBackground, not a replacement. FlowBackground draws
 * orbs and line work for marketing and admin; this draws the quieter field the
 * client dashboard sits on. Both take their colours from the same tokens.
 */
import { forwardRef, type HTMLAttributes } from 'react';

export type MeshBackdropVariant = 'app' | 'landing' | 'editor';

export interface MeshBackdropProps extends HTMLAttributes<HTMLDivElement> {
  /** How loud the atmosphere is. Never which colours it uses. */
  variant?: MeshBackdropVariant;
  className?: string;
}

export const MeshBackdrop = forwardRef<HTMLDivElement, MeshBackdropProps>(
  ({ variant = 'app', className = '', ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden="true"
      data-variant={variant}
      className={['fs-mesh-backdrop', className].filter(Boolean).join(' ')}
      {...props}
    />
  ),
);

MeshBackdrop.displayName = 'MeshBackdrop';
