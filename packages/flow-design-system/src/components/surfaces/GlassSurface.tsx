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

/**
 * The elevation ladder, thinnest pane to thickest. The variant is the only
 * thing a caller chooses; the blur, the fill and the drop that go with it are
 * decided once, in the tokens.
 */
export type GlassSurfaceVariant =
  | 'control'
  | 'chrome'
  | 'card'
  | 'panel'
  | 'overlay';

export interface GlassSurfaceProps extends HTMLAttributes<HTMLElement> {
  /**
   * Which rung of the elevation ladder this surface is on.
   * - `control`: a button or a pill. Thinnest blur, densest fill, no drop.
   * - `chrome`: a header or a sidebar. Square, and content stays readable through it.
   * - `card`: a single object.
   * - `panel`: a container for cards. Thicker blur, thinner fill, so the cards on it read as nearer.
   * - `overlay`: a modal, a banner or a toast floating over unblurred page
   *   content. Near-opaque, because the text underneath must not read through.
   */
  variant?: GlassSurfaceVariant;
  /** Tints the surface and its edge. Leave unset for plain glass. */
  tone?: Tone;
  /** Adds the hover lift and edge brighten. Set it only when the whole surface is clickable. */
  interactive?: boolean;
  /**
   * Tightens the surface's own padding (and, for a panel, the gap between
   * its children) to the 12px step.
   *
   * For surfaces that hold a grid of small objects rather than a page
   * section: a kanban column, and the cards stacked inside it. Three of
   * those nested at the default step spend 88px of a 179px column on padding
   * and leave 91px for a business name, which is not enough for one to wrap
   * without breaking mid-word.
   *
   * A prop and not a `p-3` at the call site because the variant padding is
   * unlayered CSS and Tailwind's utilities are not: a `p-*` written beside
   * `variant="panel"` loses the cascade and does nothing at all.
   */
  dense?: boolean;
  /** The element to render. Use a semantic one: section, header, aside, li. */
  as?: ElementType;
  className?: string;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<GlassSurfaceVariant, string> = {
  control: 'fs-glass--control',
  chrome: 'fs-glass--chrome',
  card: 'fs-glass--card',
  panel: 'fs-glass--panel',
  overlay: 'fs-glass--overlay',
};

export const GlassSurface = forwardRef<HTMLElement, GlassSurfaceProps>(
  (
    {
      variant = 'card',
      tone,
      interactive = false,
      dense = false,
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
      dense ? 'fs-glass--dense' : '',
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
