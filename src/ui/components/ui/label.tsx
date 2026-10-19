import React from 'react';
import { cn } from '@/lib/cn';

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  /** Appends a `text-destructive` asterisk after the text. */
  required?: boolean;
}

/** Form label: `text-sm font-medium text-foreground`. */
export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, required = false, children, ...props }, ref) => (
    <label ref={ref} className={cn('text-sm font-medium leading-none text-foreground', className)} {...props}>
      {children}
      {required && (
        <span className="ml-0.5 text-destructive" aria-hidden="true">
          *
        </span>
      )}
    </label>
  ),
);
Label.displayName = 'Label';

export interface FormFieldProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Label text rendered above the control. */
  label: React.ReactNode;
  /** Helper text under the control (hidden while `error` is set). */
  hint?: React.ReactNode;
  /** Error message under the control (`text-destructive`); replaces `hint` when present. */
  error?: React.ReactNode;
  /** Marks the label with a required asterisk. */
  required?: boolean;
  /** `id` of the control, wired to the label's `htmlFor`. */
  htmlFor?: string;
  /** The control (Input, Select, Textarea, ...). */
  children: React.ReactNode;
}

/**
 * Vertical stack: label, control, then error or hint (`gap-1.5`).
 * Pass `htmlFor` matching the control's `id` so the label focuses it.
 */
export const FormField = React.forwardRef<HTMLDivElement, FormFieldProps>(
  ({ label, hint, error, required = false, htmlFor, className, children, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col gap-1.5', className)} {...props}>
      {label != null && (
        <Label htmlFor={htmlFor} required={required}>
          {label}
        </Label>
      )}
      {children}
      {error != null && error !== false ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint != null && hint !== false ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  ),
);
FormField.displayName = 'FormField';
