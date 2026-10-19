import React, { useCallback, useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

/** Shared look of every text control (Select mirrors this string). */
const CONTROL_CLASSES =
  'flex h-9 w-full rounded-lg border border-input bg-muted px-3 py-1.5 text-sm text-foreground ' +
  'placeholder:text-subtle-foreground transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-transparent ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const INVALID_CLASSES = 'border-destructive focus-visible:ring-destructive';

/** Assigns a node to a forwarded ref (callback or object ref). */
function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as React.MutableRefObject<T | null>).current = value;
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Error state: destructive border and destructive focus ring; also sets `aria-invalid`. */
  invalid?: boolean;
}

/** Native `<input>` with the kit look. Height 36px; pair with `FormField` for label/hint/error. */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid = false, 'aria-invalid': ariaInvalid, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid ? true : ariaInvalid}
      className={cn(
        CONTROL_CLASSES,
        'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        invalid && INVALID_CLASSES,
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Error state: destructive border and destructive focus ring; also sets `aria-invalid`. */
  invalid?: boolean;
  /** Grow with the content (measured via `scrollHeight`); disables the manual resize handle. */
  autoResize?: boolean;
  /** With `autoResize`, stop growing after this many rows and scroll instead. */
  maxRows?: number;
}

/** Native `<textarea>` with the kit look. Default `min-h-[80px]`, vertically resizable. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    { className, invalid = false, autoResize = false, maxRows, onInput, value, defaultValue, 'aria-invalid': ariaInvalid, ...props },
    ref,
  ) => {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    const mergedRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        assignRef(ref, node);
      },
      [ref],
    );

    const resize = useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      // Collapse first so scrollHeight reflects the content, not the previous height.
      el.style.height = 'auto';
      if (el.scrollHeight === 0) return; // not rendered (display: none)

      const style = window.getComputedStyle(el);
      const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      let next = el.scrollHeight + borderY; // box-sizing: border-box
      let overflow = 'hidden';

      if (maxRows && maxRows > 0) {
        const parsedLineHeight = parseFloat(style.lineHeight);
        const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : parseFloat(style.fontSize) * 1.2;
        const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const max = lineHeight * maxRows + paddingY + borderY;
        if (next > max) {
          next = max;
          overflow = 'auto';
        }
      }

      el.style.height = `${Math.ceil(next)}px`;
      el.style.overflowY = overflow;
    }, [maxRows]);

    // Re-measure on controlled value changes (including programmatic clears).
    // The cleanup clears the inline height when autoResize is turned off or on unmount,
    // so a caller's own `style.height` is never touched while autoResize is false.
    useLayoutEffect(() => {
      if (!autoResize) return undefined;
      resize();
      const el = innerRef.current;
      return () => {
        if (el) {
          el.style.height = '';
          el.style.overflowY = '';
        }
      };
    }, [autoResize, resize, value, defaultValue]);

    const handleInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
      onInput?.(event);
      if (autoResize) resize();
    };

    return (
      <textarea
        ref={mergedRef}
        value={value}
        defaultValue={defaultValue}
        onInput={handleInput}
        aria-invalid={invalid ? true : ariaInvalid}
        className={cn(
          CONTROL_CLASSES,
          'h-auto min-h-[80px] py-2',
          autoResize ? 'resize-none' : 'resize-y',
          invalid && INVALID_CLASSES,
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';
