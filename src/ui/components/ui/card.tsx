import React from 'react';
import { cn } from '@/lib/cn';

export type CardProps = React.HTMLAttributes<HTMLDivElement>;

/** Panel surface: `bg-card`, 1px `border-border`, `rounded-xl`. No padding of its own. */
export const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('rounded-xl border border-border bg-card text-foreground', className)} {...props} />
));
Card.displayName = 'Card';

export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Right-aligned controls (buttons, badges) rendered beside the title block. */
  actions?: React.ReactNode;
}

/**
 * Top block of a card (`p-4 pb-0`). Children (CardTitle / CardDescription) stack vertically;
 * with `actions` they sit in a row with the actions on the right.
 */
export const CardHeader = React.forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className, actions, children, ...props }, ref) => {
    if (actions == null) {
      return (
        <div ref={ref} className={cn('flex flex-col gap-1 p-4 pb-0', className)} {...props}>
          {children}
        </div>
      );
    }
    return (
      <div ref={ref} className={cn('flex items-start justify-between gap-3 p-4 pb-0', className)} {...props}>
        <div className="flex min-w-0 flex-col gap-1">{children}</div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    );
  },
);
CardHeader.displayName = 'CardHeader';

export type CardTitleProps = React.HTMLAttributes<HTMLHeadingElement>;

/** `<h3>` title, `text-sm font-semibold`. */
export const CardTitle = React.forwardRef<HTMLHeadingElement, CardTitleProps>(({ className, ...props }, ref) => (
  <h3 ref={ref} className={cn('text-sm font-semibold leading-none text-foreground', className)} {...props} />
));
CardTitle.displayName = 'CardTitle';

export type CardDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;

/** `<p>` secondary text under the title. */
export const CardDescription = React.forwardRef<HTMLParagraphElement, CardDescriptionProps>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  ),
);
CardDescription.displayName = 'CardDescription';

export type CardContentPadding = 'none' | 'sm' | 'md';

const CONTENT_PADDING: Record<CardContentPadding, string> = {
  none: 'p-0',
  sm: 'p-3',
  md: 'p-4',
};

export interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** `md` = 16px (default), `sm` = 12px, `none` = 0 (for lists / tables that fill the card). */
  padding?: CardContentPadding;
}

/** Main body of a card. */
export const CardContent = React.forwardRef<HTMLDivElement, CardContentProps>(
  ({ className, padding = 'md', ...props }, ref) => (
    <div ref={ref} className={cn(CONTENT_PADDING[padding], className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

export type CardFooterProps = React.HTMLAttributes<HTMLDivElement>;

/** Bottom row for actions (`p-4 pt-0`, horizontal flex with `gap-2`). */
export const CardFooter = React.forwardRef<HTMLDivElement, CardFooterProps>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex items-center gap-2 p-4 pt-0', className)} {...props} />
));
CardFooter.displayName = 'CardFooter';
