/**
 * The one glass surface.
 *
 * Everything translucent in the product is this component with a variant: a
 * card, a panel that holds cards, or the chrome behind a header or sidebar.
 * It owns no colours of its own; the material and the tones come from the
 * --fs-* tokens in brand.css and the .fs-glass classes in index.css, so a
 * theme change or a contrast fix lands everywhere at once.
 *
 * There is deliberately no `blur` or `background` prop. A surface that can be
 * tuned per call site is a surface that drifts, and the drift is what the
 * three overlapping glass layers in flowstarter-main already cost us.
 */
import {
  createElement,
  forwardRef,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

/** Every tone the design system will colour content with. */
export const TONES = [
  'accent',
  'ok',
  'info',
  'warn',
  'danger',
  'violet',
  'pink',
  'teal',
  'neutral',
] as const;

export type Tone = (typeof TONES)[number];

export type GlassSurfaceVariant = 'card' | 'panel' | 'chrome';

export interface GlassSurfaceProps extends HTMLAttributes<HTMLElement> {
  /** card: a single object. panel: a container for cards. chrome: header/sidebar. */
  variant?: GlassSurfaceVariant;
  /** Tints the surface and its edge. Leave unset for plain glass. */
  tone?: Tone;
  /** Adds the hover lift and edge brighten. Set it only when the whole surface is clickable. */
  interactive?: boolean;
  /** The element to render. Use a semantic one: section, header, aside, li. */
  as?: ElementType;
  className?: string;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<GlassSurfaceVariant, string> = {
  card: 'fs-glass--card',
  panel: 'fs-glass--panel',
  chrome: 'fs-glass--chrome',
};

export const GlassSurface = forwardRef<HTMLElement, GlassSurfaceProps>(
  (
    {
      variant = 'card',
      tone,
      interactive = false,
      as = 'div',
      className = '',
      children,
      ...props
    },
    ref,
  ) => {
    const classes = [
      'fs-glass',
      VARIANT_CLASS[variant],
      tone ? 'fs-glass--toned' : '',
      interactive ? 'fs-glass--interactive' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return createElement(
      as,
      { ref, className: classes, 'data-tone': tone, ...props },
      children,
    );
  },
);

GlassSurface.displayName = 'GlassSurface';
