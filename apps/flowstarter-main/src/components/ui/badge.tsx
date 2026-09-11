import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import type { Tone } from '@flowstarter/flow-design-system';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground [a&]:[@media(hover:hover)]:hover:bg-primary/90',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground [a&]:[@media(hover:hover)]:hover:bg-secondary/90',
        destructive:
          'border-transparent bg-destructive text-white [a&]:[@media(hover:hover)]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline:
          'text-foreground [a&]:[@media(hover:hover)]:hover:bg-accent [a&]:[@media(hover:hover)]:hover:text-accent-foreground',
        /** A status pill in a tone's ink on its soft wash, edged with the
         * tone's own hairline — set `tone` to pick which one. Falls back to
         * `neutral` if `tone` is left unset. */
        tone: '',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function Badge({
  className,
  variant,
  tone,
  asChild = false,
  style,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean;
    /** Only read when `variant="tone"`. One of the design system's nine tones. */
    tone?: Tone;
  }) {
  const Comp = asChild ? Slot : 'span';
  const toneStyle: React.CSSProperties | undefined =
    variant === 'tone'
      ? {
          background: `var(--fs-tone-${tone ?? 'neutral'}-soft)`,
          color: `var(--fs-tone-${tone ?? 'neutral'})`,
          borderColor: `var(--fs-tone-${tone ?? 'neutral'}-edge)`,
          ...style,
        }
      : style;

  return (
    <Comp
      data-slot="badge"
      data-tone={variant === 'tone' ? tone ?? 'neutral' : undefined}
      className={cn(badgeVariants({ variant }), className)}
      style={toneStyle}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
