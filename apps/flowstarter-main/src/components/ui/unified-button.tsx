import { forwardRef } from 'react';
import { Button as BaseButton, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type UnifiedButtonTone = 'primary' | 'secondary';

interface UnifiedButtonProps extends ButtonProps {
  tone?: UnifiedButtonTone;
}

const toneClasses: Record<UnifiedButtonTone, string> = {
  // Primary — solid `--purple` brand gradient. Top-left is the canonical
  // `--purple` hue, bottom-right is the same hue darkened so the button
  // reads as one unmistakably-brand surface rather than the previous
  // navy-leaning mix with `--fs-accent-hot`.
  primary:
    'bg-[linear-gradient(135deg,var(--purple)_0%,color-mix(in_oklab,var(--purple)_82%,#0f0520)_100%)] text-white shadow-lg shadow-[var(--purple)]/30 hover:brightness-110 hover:shadow-xl hover:shadow-[var(--purple)]/50 hover:-translate-y-px',
  // Secondary — the product's glass, at a control's size. It is the same
  // material as every panel it sits on, so a ghost CTA over the marketing mesh
  // refracts the gradient behind it instead of laying an opaque grey chip on
  // top of it. `--control` drops the card radius and the drop shadow; the
  // hover lift and the edge brighten still come from `--interactive`.
  secondary:
    'fs-glass fs-glass--control fs-glass--interactive hover:text-[var(--purple)]',
};

export const Button = forwardRef<HTMLButtonElement, UnifiedButtonProps>(
  ({ tone = 'primary', className, ...props }, ref) => (
    <BaseButton
      ref={ref}
      variant="transparent"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3 text-base font-semibold transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--purple-primary)]/30 focus-visible:ring-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        toneClasses[tone],
        className
      )}
      {...props}
    />
  )
);

Button.displayName = 'Button';
