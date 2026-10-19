import React from 'react';
import { cn } from '@/lib/cn';

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'destructive' | 'info' | 'outline';
export type BadgeSize = 'sm' | 'md';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-muted text-muted-foreground',
  primary: 'bg-primary/15 text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/15 text-destructive',
  info: 'bg-info/15 text-info',
  outline: 'border border-border text-foreground',
};

const SIZE_CLASSES: Record<BadgeSize, string> = {
  sm: 'h-5 px-1.5 text-[11px]',
  md: 'h-6 px-2 text-xs',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Colour scheme: tinted background + coloured text (never a solid fill). Default `default`. */
  variant?: BadgeVariant;
  /** Shows a small round dot in the current text colour before the content. */
  dot?: boolean;
  /** `md` 24px (default) or `sm` 20px tall. */
  size?: BadgeSize;
}

/** Inline status / count label. */
export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'default', size = 'md', dot = false, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1 rounded-md font-medium whitespace-nowrap',
        SIZE_CLASSES[size],
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    >
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  ),
);
Badge.displayName = 'Badge';
