import React from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'disabled:pointer-events-none disabled:opacity-50';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
  secondary: 'bg-muted text-foreground hover:bg-accent',
  outline: 'border border-input bg-transparent text-foreground hover:bg-muted',
  ghost: 'text-foreground hover:bg-muted',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  // `h-auto p-0` intentionally overrides the size classes (cn() resolves the conflict).
  link: 'h-auto p-0 text-primary underline-offset-4 hover:underline',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3',
  md: 'h-9 px-4',
  lg: 'h-10 px-4',
  icon: 'h-9 w-9 p-0',
};

export interface ButtonVariantOptions {
  /** Visual style. Default `primary`. */
  variant?: ButtonVariant;
  /** Control height: `sm` 32px, `md` 36px, `lg` 40px, `icon` 36×36 square. Default `md`. */
  size?: ButtonSize;
  /** Extra classes merged last (can override anything). */
  className?: string;
}

/**
 * Returns the Button class string without rendering a `<button>`, so anchors or
 * router links can look like buttons: `<a className={buttonVariants({ variant: 'outline' })}>`.
 */
export function buttonVariants({ variant = 'primary', size = 'md', className }: ButtonVariantOptions = {}): string {
  return cn(BASE_CLASSES, SIZE_CLASSES[size], VARIANT_CLASSES[variant], className);
}

/** Inline spinner (uses `currentColor`, so it matches the button text colour of any variant). */
function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('h-4 w-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. Default `primary`. */
  variant?: ButtonVariant;
  /** Control height: `sm` 32px, `md` 36px, `lg` 40px, `icon` 36×36 square. Default `md`. */
  size?: ButtonSize;
  /**
   * Shows a centred spinner and disables the button. The content stays in the DOM
   * (hidden with `visibility`) so the button keeps its width and nothing shifts.
   */
  loading?: boolean;
  /** Icon rendered before the children (pass `className="h-4 w-4"` on the icon). */
  leftIcon?: React.ReactNode;
  /** Icon rendered after the children. */
  rightIcon?: React.ReactNode;
}

/**
 * Base button. `type` defaults to `"button"` so it never submits a form by accident.
 * For an icon-only button use `size="icon"` and pass an `aria-label`.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      leftIcon,
      rightIcon,
      className,
      children,
      disabled,
      type = 'button',
      ...props
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        data-loading={loading || undefined}
        className={buttonVariants({ variant, size, className: cn(loading && 'relative', className) })}
        {...props}
      >
        {loading && (
          <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
            <Spinner />
          </span>
        )}
        {leftIcon != null && (
          <span className={cn('inline-flex shrink-0', loading && 'invisible')} aria-hidden="true">
            {leftIcon}
          </span>
        )}
        {children != null && (
          // `contents` keeps the children as direct flex items (gap still applies);
          // `visibility` is inherited, so `invisible` hides them while loading.
          <span className={cn('contents', loading && 'invisible')}>{children}</span>
        )}
        {rightIcon != null && (
          <span className={cn('inline-flex shrink-0', loading && 'invisible')} aria-hidden="true">
            {rightIcon}
          </span>
        )}
      </button>
    );
  },
);
Button.displayName = 'Button';
