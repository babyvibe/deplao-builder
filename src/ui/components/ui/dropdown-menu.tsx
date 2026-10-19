/**
 * DropdownMenu — click-to-open menu portaled into `document.body` and positioned next to its
 * trigger with `getBoundingClientRect` (flips above when there is no room below, clamped to the
 * viewport, re-positioned on scroll/resize in a rAF).
 *
 * ```tsx
 * <DropdownMenu align="end" trigger={<Button variant="ghost" size="icon"><MoreIcon className="w-4 h-4" /></Button>}>
 *   <DropdownMenuLabel>Hội thoại</DropdownMenuLabel>
 *   <DropdownMenuItem icon={<EditIcon />} shortcut="F2" onSelect={rename}>Đổi tên</DropdownMenuItem>
 *   <DropdownMenuSeparator />
 *   <DropdownMenuItem destructive onSelect={remove}>Xoá</DropdownMenuItem>
 * </DropdownMenu>
 * ```
 *
 * Closes on outside click, Escape, item select, Tab and window blur. Keyboard: ↑/↓ (wrap),
 * Home/End, Enter/Space selects, Escape returns focus to the trigger. Works controlled
 * (`open` + `onOpenChange`) or uncontrolled.
 */
import React, {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

export type DropdownMenuAlign = 'start' | 'end';
export type DropdownMenuSide = 'bottom' | 'top';

const GAP = 4;
const VIEWPORT_MARGIN = 8;
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

interface MenuPosition {
  top: number;
  left: number;
  placement: DropdownMenuSide;
}

function computePosition(
  trigger: DOMRect,
  menuWidth: number,
  menuHeight: number,
  align: DropdownMenuAlign,
  side: DropdownMenuSide,
): MenuPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fitsBelow = trigger.bottom + GAP + menuHeight <= vh - VIEWPORT_MARGIN;
  const fitsAbove = trigger.top - GAP - menuHeight >= VIEWPORT_MARGIN;

  let placement: DropdownMenuSide = side;
  if (side === 'bottom' && !fitsBelow && fitsAbove) placement = 'top';
  else if (side === 'top' && !fitsAbove && fitsBelow) placement = 'bottom';

  const rawTop = placement === 'bottom' ? trigger.bottom + GAP : trigger.top - GAP - menuHeight;
  const rawLeft = align === 'start' ? trigger.left : trigger.right - menuWidth;

  return {
    top: Math.round(clamp(rawTop, VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - menuHeight)),
    left: Math.round(clamp(rawLeft, VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - menuWidth)),
    placement,
  };
}

function getItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) : [];
}

// ─── Context ──────────────────────────────────────────────────────────────────
interface DropdownMenuContextValue {
  /** Close the menu. `restoreFocus` (default `true`) moves focus back to the trigger. */
  close: (restoreFocus?: boolean) => void;
}

const DropdownMenuContext = createContext<DropdownMenuContextValue>({ close: () => {} });

// ─── DropdownMenu ─────────────────────────────────────────────────────────────
export interface DropdownMenuProps {
  /** Element that toggles the menu (usually a `<Button>`); rendered inside an inline-flex wrapper. */
  trigger: React.ReactNode;
  align?: DropdownMenuAlign;
  side?: DropdownMenuSide;
  /** Controlled open state; omit for uncontrolled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Classes for the menu panel. */
  className?: string;
  /** Classes for the trigger wrapper (e.g. `w-full`). */
  triggerClassName?: string;
  children: React.ReactNode;
}

export const DropdownMenu = forwardRef<HTMLSpanElement, DropdownMenuProps>(function DropdownMenu(
  { trigger, align = 'start', side = 'bottom', open, onOpenChange, className, triggerClassName, children },
  ref,
) {
  const menuId = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const initialFocusRef = useRef<'first' | 'last'>('first');

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? !!open : uncontrolledOpen;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const setTriggerRef = useCallback(
    (node: HTMLSpanElement | null) => {
      triggerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLSpanElement | null>).current = node;
    },
    [ref],
  );

  const setOpen = useCallback(
    (next: boolean) => {
      if (isOpenRef.current === next) return;
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChangeRef.current?.(next);
    },
    [isControlled],
  );

  const focusTrigger = useCallback(() => {
    const wrapper = triggerRef.current;
    if (!wrapper) return;
    const target = wrapper.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? wrapper;
    target.focus({ preventScroll: true });
  }, []);

  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      if (restoreFocus) focusTrigger();
    },
    [setOpen, focusTrigger],
  );

  const context = useMemo<DropdownMenuContextValue>(() => ({ close }), [close]);

  const onTriggerClick = (e: React.MouseEvent<HTMLSpanElement>) => {
    if (e.defaultPrevented) return;
    initialFocusRef.current = 'first';
    setOpen(!isOpenRef.current);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (e.defaultPrevented || isOpenRef.current) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      initialFocusRef.current = e.key === 'ArrowDown' ? 'first' : 'last';
      setOpen(true);
    }
  };

  return (
    <DropdownMenuContext.Provider value={context}>
      <span
        ref={setTriggerRef}
        className={cn('inline-flex', triggerClassName)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger}
      </span>
      {isOpen &&
        createPortal(
          <MenuPanel
            id={menuId}
            triggerRef={triggerRef}
            align={align}
            side={side}
            className={className}
            initialFocus={initialFocusRef.current}
            onClose={close}
          >
            {children}
          </MenuPanel>,
          document.body,
        )}
    </DropdownMenuContext.Provider>
  );
});
DropdownMenu.displayName = 'DropdownMenu';

// ─── Menu panel (mounted only while open, so position/focus state resets) ─────
interface MenuPanelProps {
  id: string;
  triggerRef: React.RefObject<HTMLElement>;
  align: DropdownMenuAlign;
  side: DropdownMenuSide;
  className?: string;
  initialFocus: 'first' | 'last';
  onClose: (restoreFocus?: boolean) => void;
  children: React.ReactNode;
}

function MenuPanel({ id, triggerRef, align, side, className, initialFocus, onClose, children }: MenuPanelProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const positionRef = useRef<MenuPosition | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    // offsetWidth/Height ignore the popupIn transform, unlike getBoundingClientRect on the menu.
    const next = computePosition(trigger.getBoundingClientRect(), menu.offsetWidth, menu.offsetHeight, align, side);
    const prev = positionRef.current;
    if (prev && prev.top === next.top && prev.left === next.left && prev.placement === next.placement) return;
    positionRef.current = next;
    setPosition(next);
  }, [triggerRef, align, side]);

  // Measure after mount (before paint) and follow the trigger on resize / any scroll.
  useLayoutEffect(() => {
    updatePosition();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updatePosition();
      });
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [updatePosition]);

  // Focus the first (or last) enabled item once the menu is positioned and visible.
  // `initialFocus` is intentionally read once, at the moment the menu becomes visible.
  const positioned = position !== null;
  const initialFocusRef = useRef(initialFocus);
  useEffect(() => {
    if (!positioned) return;
    const items = getItems(menuRef.current);
    const target = initialFocusRef.current === 'last' ? items[items.length - 1] : items[0];
    (target ?? menuRef.current)?.focus({ preventScroll: true });
  }, [positioned]);

  // Outside click, Escape (captured so it never reaches an enclosing Dialog) and window blur.
  useEffect(() => {
    const onDocumentMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onCloseRef.current(false);
    };
    const onDocumentKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current(true);
    };
    const onWindowBlur = () => onCloseRef.current(false);

    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown, true);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [triggerRef]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // Close and hand focus back to the trigger; the browser then continues tabbing from there.
      onCloseRef.current(true);
      return;
    }
    const items = getItems(menuRef.current);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    switch (e.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % items.length;
        break;
      case 'ArrowUp':
        next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        // Enter / Space on a focused <button role="menuitem"> fire its native click → select.
        return;
    }
    e.preventDefault();
    items[next].focus({ preventScroll: true });
  };

  return (
    <div
      ref={menuRef}
      id={id}
      role="menu"
      tabIndex={-1}
      data-side={position?.placement}
      className={cn(
        'fixed z-[60] max-h-[calc(100vh-1rem)] min-w-[10rem] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-foreground shadow-xl outline-none',
        className,
      )}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? undefined : 'hidden',
        transformOrigin: position?.placement === 'top' ? 'bottom' : 'top',
        animation: position ? 'popupIn 120ms ease-out' : undefined,
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

// ─── Items ────────────────────────────────────────────────────────────────────
export interface DropdownMenuItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  /** Called after the menu closes. */
  onSelect?: () => void;
  icon?: React.ReactNode;
  destructive?: boolean;
  /** Right-aligned hint, e.g. `⌘K` or `F2`. */
  shortcut?: React.ReactNode;
}

export const DropdownMenuItem = forwardRef<HTMLButtonElement, DropdownMenuItemProps>(
  function DropdownMenuItem(
    {
      onSelect,
      icon,
      destructive = false,
      disabled = false,
      shortcut,
      className,
      children,
      onClick,
      onMouseEnter,
      onMouseLeave,
      ...rest
    },
    ref,
  ) {
    const { close } = useContext(DropdownMenuContext);
    return (
      <button
        ref={ref}
        type="button"
        role="menuitem"
        tabIndex={-1}
        disabled={disabled}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground hover:bg-muted focus:bg-muted focus:outline-none disabled:pointer-events-none disabled:opacity-50',
          destructive && 'text-destructive hover:bg-destructive/10 focus:bg-destructive/10',
          className,
        )}
        onClick={(e) => {
          onClick?.(e);
          if (e.defaultPrevented || disabled) return;
          close();
          onSelect?.();
        }}
        // Roving focus follows the pointer so hover and keyboard highlight never disagree.
        onMouseEnter={(e) => {
          onMouseEnter?.(e);
          if (!disabled) e.currentTarget.focus({ preventScroll: true });
        }}
        onMouseLeave={(e) => {
          onMouseLeave?.(e);
          if (document.activeElement !== e.currentTarget) return;
          e.currentTarget.closest<HTMLElement>('[role="menu"]')?.focus({ preventScroll: true });
        }}
        {...rest}
      >
        {icon != null && (
          <span
            className={cn(
              'inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4',
              !destructive && 'text-muted-foreground',
            )}
          >
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {shortcut != null && (
          <span className="ml-auto pl-3 text-xs text-subtle-foreground">{shortcut}</span>
        )}
      </button>
    );
  },
);
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuSeparator = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function DropdownMenuSeparator({ className, ...rest }, ref) {
    return <div ref={ref} role="separator" className={cn('my-1 h-px bg-border', className)} {...rest} />;
  },
);
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

export const DropdownMenuLabel = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function DropdownMenuLabel({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn('px-2 py-1.5 text-xs font-medium text-subtle-foreground', className)}
        {...rest}
      />
    );
  },
);
DropdownMenuLabel.displayName = 'DropdownMenuLabel';
