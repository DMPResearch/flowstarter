/**
 * The field the glass refracts.
 *
 * Liquid glass only reads as glass when there is something behind it worth
 * blurring, and the trick is that the something has to be worth blurring
 * without being worth looking at. This is that: the page's own background tone
 * with a very slow, very low-chroma modulation washed across it, fixed to the
 * viewport and painted at z-index 0 so a layout can lift its content to
 * z-index 10 over the top. It is still, because a working surface that is
 * never quite the same twice is a surface people keep re-reading.
 *
 * `variant` says how loud it is and never which colours it uses — see the
 * field section of the package README for why that distinction is load-bearing
 * rather than stylistic.
 *
 * It is a sibling of FlowBackground, not a replacement. FlowBackground draws
 * orbs and line work for the auth pages; this draws the field the client
 * dashboard, admin and the editor sit on. Both take their colours from the
 * same tokens.
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
