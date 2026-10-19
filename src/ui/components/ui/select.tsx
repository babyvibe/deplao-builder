import React from 'react';
import { cn } from '@/lib/cn';
import { ChevronDownIcon } from '@/components/common/icons';

/** Mirrors the Input control classes (kept inline so this file stays self-contained). */
const CONTROL_CLASSES =
  'flex h-9 w-full rounded-lg border border-input bg-muted px-3 py-1.5 text-sm text-foreground ' +
  'placeholder:text-subtle-foreground transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-transparent ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const INVALID_CLASSES = 'border-destructive focus-visible:ring-destructive';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Error state: destructive border and destructive focus ring; also sets `aria-invalid`. */
  invalid?: boolean;
  /** Classes for the outer `relative` wrapper (use it for width / margins). */
  wrapperClassName?: string;
}

/**
 * Native `<select>` styled like `Input`, with a chevron on the right.
 * Children are plain `<option>` / `<optgroup>` elements. `className` targets the
 * `<select>` itself; `wrapperClassName` targets the wrapper `<div>`.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, wrapperClassName, invalid = false, children, multiple, size, 'aria-invalid': ariaInvalid, ...props }, ref) => {
    // A listbox-style select (multiple / size > 1) has no dropdown, so no chevron.
    const isListbox = Boolean(multiple) || (typeof size === 'number' && size > 1);

    return (
      <div className={cn('relative', wrapperClassName)}>
        <select
          ref={ref}
          multiple={multiple}
          size={size}
          aria-invalid={invalid ? true : ariaInvalid}
          className={cn(
            'peer',
            CONTROL_CLASSES,
            isListbox ? 'h-auto' : 'cursor-pointer appearance-none pr-9',
            invalid && INVALID_CLASSES,
            className,
          )}
          {...props}
        >
          {children}
        </select>
        {!isListbox && (
          <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground peer-disabled:opacity-50" />
        )}
      </div>
    );
  },
);
Select.displayName = 'Select';
