/**
 * One number, said once.
 *
 * A tile is an eyebrow label, a big tabular number and a line of plain English
 * under it, on glass. The tone colours the value, the icon chip and a thin rim,
 * and leaves the tile itself alone, so a grid of them reads as one surface with
 * a few accents instead of a bag of coloured cards. `emphasis` is the exception
 * and is meant to be used once per page.
 *
 * The link and the static tile render the same children, in the same order,
 * with the same classes. Only the wrapper element differs, so a test that
 * asserts on the body does not have to know whether the tile happens to be
 * clickable today.
 *
 * `linkComponent` exists because this package must not depend on Next: the app
 * passes its own Link in, and the tile stays framework-free.
 */
import {
  createElement,
  forwardRef,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import type { Tone } from './GlassSurface';

export interface StatTileProps
  extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** Small caps eyebrow. Says what the number is. */
  label: ReactNode;
  /** The number, or a short word like "Connected". */
  value: ReactNode;
  /** One line of plain English under the value. */
  note?: ReactNode;
  /** Tints the value, the icon chip and the edge. Defaults to neutral. */
  tone?: Tone;
  /**
   * Turns the whisper wash up to the full tone and adds the bloom under the
   * tile. Meant for one tile on a page: the thing the reader has to act on.
   * A grid where every tile asks for emphasis is a grid with none.
   */
  emphasis?: boolean;
  /** A Lucide icon, sized by the caller. Decorative only. */
  icon?: ReactNode;
  /** When set the tile becomes a link and picks up the hover lift. */
  href?: string;
  /** The link element to render, e.g. Next's Link. Defaults to a plain anchor. */
  linkComponent?: ElementType;
  className?: string;
  /** Anything data-* the caller needs for tests or analytics rides through. */
  [key: `data-${string}`]: unknown;
}

export const StatTile = forwardRef<HTMLElement, StatTileProps>(
  (
    {
      label,
      value,
      note,
      tone = 'neutral',
      emphasis = false,
      icon,
      href,
      linkComponent,
      className = '',
      ...props
    },
    ref,
  ) => {
    const classes = [
      'fs-glass',
      'fs-glass-tile',
      'fs-glass-ring',
      href ? 'fs-glass--interactive' : '',
      emphasis ? 'fs-glass-tile--emphasis' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const body = [
      createElement(
        'div',
        { key: 'head', className: 'fs-glass-tile__head' },
        createElement('span', { className: 'fs-glass-tile__label' }, label),
        icon
          ? createElement(
              'span',
              { className: 'fs-glass-tile__icon', 'aria-hidden': 'true' },
              icon,
            )
          : null,
      ),
      createElement(
        'span',
        { key: 'value', className: 'fs-glass-tile__value' },
        value,
      ),
      note
        ? createElement(
            'span',
            { key: 'note', className: 'fs-glass-tile__note' },
            note,
          )
        : null,
    ];

    // The tone goes on both attributes. A caller that needs `data-tone` for a
    // meaning of its own overrides it through the spread, and `data-palette`
    // still carries the tone that actually paints.
    const shared = {
      ref,
      className: classes,
      'data-tone': tone,
      'data-palette': tone,
      ...props,
    };

    if (href) {
      return createElement(linkComponent ?? 'a', { ...shared, href }, body);
    }

    return createElement('div', shared, body);
  },
);

StatTile.displayName = 'StatTile';
