import React from 'react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Icon shown inside a 48px `bg-muted` circle (pass `className="h-6 w-6"` on the icon). */
  icon?: React.ReactNode;
  /** Main line, `text-sm font-medium`. */
  title: React.ReactNode;
  /** Secondary line, muted, max width `max-w-sm`. */
  description?: React.ReactNode;
  /** Call to action rendered under the text (usually a `Button`). */
  action?: React.ReactNode;
  /** Tighter vertical padding (`py-6` instead of `py-12`) for small panels. */
  compact?: boolean;
}

/** Centred placeholder for empty lists / search results / error panels. */
export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ icon, title, description, action, compact = false, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex flex-col items-center justify-center px-4 text-center', compact ? 'py-6' : 'py-12', className)}
      {...props}
    >
      {icon != null && (
        <div className="mb-3 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description != null && (
        <p className="mt-1 max-w-sm text-center text-sm text-muted-foreground">{description}</p>
      )}
      {action != null && <div className="mt-2 flex items-center justify-center gap-2">{action}</div>}
    </div>
  ),
);
EmptyState.displayName = 'EmptyState';
