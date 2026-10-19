import React, { useId } from 'react';
import { cn } from '@/lib/cn';
import { CheckIcon } from '@/components/common/icons';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** Button attributes that the toggle controls manage themselves. */
type ToggleButtonAttributes = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'role' | 'aria-checked' | 'onChange' | 'checked' | 'defaultChecked'
>;

interface ToggleBaseProps extends ToggleButtonAttributes {
  /** Current state (controlled). */
  checked: boolean;
  /** Called with the next state when the control or its label is clicked / toggled by keyboard. */
  onCheckedChange: (checked: boolean) => void;
  /** Text shown to the right of the control; clicking it toggles too. */
  label?: React.ReactNode;
  /** Smaller secondary text under the label. */
  description?: React.ReactNode;
  /** Disables the control and dims the whole row. */
  disabled?: boolean;
  /** Classes for the outer `<label>` row (layout / spacing). */
  className?: string;
  /** `id` of the underlying `<button>` (so an external `<Label htmlFor>` can target it). */
  id?: string;
}

interface ToggleRowProps {
  className?: string;
  disabled: boolean;
  label?: React.ReactNode;
  description?: React.ReactNode;
  labelId: string;
  descriptionId: string;
  children: React.ReactNode;
}

/**
 * Shared row layout: a `<label>` wrapping the control, so clicking the text activates
 * the button (a `<button>` is a labelable element) without needing `htmlFor`.
 * Dimming lives here (not on the button) to avoid double opacity.
 */
function ToggleRow({ className, disabled, label, description, labelId, descriptionId, children }: ToggleRowProps) {
  const hasText = label != null || description != null;
  return (
    <label
      className={cn(
        'inline-flex items-start gap-2 select-none',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      {children}
      {hasText && (
        <span className="flex min-w-0 flex-col gap-0.5">
          {label != null && (
            <span id={labelId} className="text-sm font-medium leading-5 text-foreground">
              {label}
            </span>
          )}
          {description != null && (
            <span id={descriptionId} className="text-xs text-muted-foreground">
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  );
}

export type CheckboxProps = ToggleBaseProps;

/**
 * Controlled checkbox rendered as `<button role="checkbox">` (keyboard: Space / Enter toggle).
 * 16px box: `bg-muted` + `border-input`, filled `bg-primary` with a check when `checked`.
 */
export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked, onCheckedChange, label, description, disabled = false, className, onClick, ...props }, ref) => {
    const autoId = useId();
    const labelId = `${autoId}-label`;
    const descriptionId = `${autoId}-desc`;

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented || disabled) return;
      onCheckedChange(!checked);
    };

    return (
      <ToggleRow
        className={className}
        disabled={disabled}
        label={label}
        description={description}
        labelId={labelId}
        descriptionId={descriptionId}
      >
        <button
          ref={ref}
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-labelledby={label != null ? labelId : undefined}
          aria-describedby={description != null ? descriptionId : undefined}
          disabled={disabled}
          data-state={checked ? 'checked' : 'unchecked'}
          onClick={handleClick}
          className={cn(
            // mt-0.5 centres the 16px box on the first 20px text line
            'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
            FOCUS_RING,
            'disabled:cursor-not-allowed',
            checked
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input bg-muted hover:border-border-strong',
          )}
          {...props}
        >
          {checked && <CheckIcon className="h-3.5 w-3.5 [stroke-width:3]" />}
        </button>
      </ToggleRow>
    );
  },
);
Checkbox.displayName = 'Checkbox';

export type SwitchSize = 'sm' | 'md';

export interface SwitchProps extends ToggleBaseProps {
  /** `md` = 36×20 track (default), `sm` = 28×16 track. */
  size?: SwitchSize;
}

const SWITCH_TRACK: Record<SwitchSize, string> = {
  md: 'h-5 w-9',
  sm: 'mt-0.5 h-4 w-7',
};

const SWITCH_KNOB: Record<SwitchSize, { base: string; on: string; off: string }> = {
  md: { base: 'h-4 w-4', off: 'translate-x-0.5', on: 'translate-x-[18px]' },
  sm: { base: 'h-3 w-3', off: 'translate-x-0.5', on: 'translate-x-3.5' },
};

/**
 * Controlled toggle rendered as `<button role="switch">`. Label sits on the right by default;
 * pass `className="flex-row-reverse justify-between"` for a settings-row layout.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, label, description, disabled = false, size = 'md', className, onClick, ...props }, ref) => {
    const autoId = useId();
    const labelId = `${autoId}-label`;
    const descriptionId = `${autoId}-desc`;
    const knob = SWITCH_KNOB[size];

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented || disabled) return;
      onCheckedChange(!checked);
    };

    return (
      <ToggleRow
        className={className}
        disabled={disabled}
        label={label}
        description={description}
        labelId={labelId}
        descriptionId={descriptionId}
      >
        <button
          ref={ref}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={label != null ? labelId : undefined}
          aria-describedby={description != null ? descriptionId : undefined}
          disabled={disabled}
          data-state={checked ? 'checked' : 'unchecked'}
          onClick={handleClick}
          className={cn(
            'relative inline-flex shrink-0 items-center rounded-full transition-colors',
            FOCUS_RING,
            'disabled:cursor-not-allowed',
            SWITCH_TRACK[size],
            checked ? 'bg-primary' : 'bg-accent',
          )}
          {...props}
        >
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none block rounded-full bg-white shadow transition-transform',
              knob.base,
              checked ? knob.on : knob.off,
            )}
          />
        </button>
      </ToggleRow>
    );
  },
);
Switch.displayName = 'Switch';
