/**
 * A status, said in one word.
 *
 * The small tinted shape that labels a row: a project state, a plan name, a
 * count. It was being redrawn at every call site, which is how the product
 * ended up with badges at four radii and three heights, some with a coloured
 * dot in front and some without.
 *
 * It follows the same rule the tiles do. A pill is tone-coloured ink on a
 * whisper of the tone's wash inside a thin rim of it, never a block of solid
 * colour, so a table with a pill on every row stays a table rather than
 * becoming a bar chart. The one exception is `emphasis`, which takes the full
 * wash, and like the tiles it is meant for one pill in a view.
 *
 * `dot` is off by default on purpose. A coloured dot in front of a coloured
 * word says the same thing twice. Turn it on only where the pill reports
 * something genuinely live, such as a host that is up or down.
 */
import {
  createElement,
  forwardRef,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import type { Tone } from './GlassSurface';

export type PillSize = 'sm' | 'md';

export interface PillProps extends HTMLAttributes<HTMLElement> {
  /** Tints the ink, the rim and the wash. Defaults to neutral. */
  tone?: Tone;
  /** sm is for dense table rows, md for a pill that stands on its own. */
  size?: PillSize;
  /** Takes the full tone wash. Meant for one pill in a view. */
  emphasis?: boolean;
  /** Shows a leading dot. Only for something genuinely live. */
  dot?: boolean;
  /** A Lucide icon, sized by the caller. Decorative only. */
  icon?: ReactNode;
  /** The element to render. Use a semantic one where there is one. */
  as?: ElementType;
  className?: string;
  children?: ReactNode;
}

export const Pill = forwardRef<HTMLElement, PillProps>(
  (
    {
      tone = 'neutral',
      size = 'sm',
      emphasis = false,
      dot = false,
      icon,
      as = 'span',
      className = '',
      children,
      ...props
    },
    ref,
  ) => {
    const classes = [
      'fs-pill',
      size === 'sm' ? 'fs-pill--sm' : '',
      emphasis ? 'fs-pill--emphasis' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return createElement(
      as,
      { ref, className: classes, 'data-tone': tone, ...props },
      dot
        ? createElement('span', {
            key: 'dot',
            className: 'fs-pill__dot',
            'aria-hidden': 'true',
          })
        : null,
      icon
        ? createElement(
            'span',
            { key: 'icon', className: 'fs-pill__icon', 'aria-hidden': 'true' },
            icon,
          )
        : null,
      children,
    );
  },
);

Pill.displayName = 'Pill';
