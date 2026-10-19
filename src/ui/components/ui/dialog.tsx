/**
 * Dialog — modal overlay portaled into `document.body`.
 *
 * ```tsx
 * <Dialog open={open} onOpenChange={setOpen} size="md">
 *   <DialogHeader>
 *     <div className="min-w-0">
 *       <DialogTitle>Tiêu đề</DialogTitle>
 *       <DialogDescription>Mô tả ngắn</DialogDescription>
 *     </div>
 *     <DialogClose />
 *   </DialogHeader>
 *   <DialogBody>…</DialogBody>
 *   <DialogFooter>
 *     <Button variant="outline" onClick={() => setOpen(false)}>Huỷ</Button>
 *     <Button autoFocus>Lưu</Button>
 *   </DialogFooter>
 * </Dialog>
 * ```
 *
 * Behaviour: Escape closes only the topmost open dialog; a click on the backdrop closes unless the
 * press started inside the panel; body scroll is locked while any dialog is open; on open focus
 * moves to a child with `autoFocus` / `[data-autofocus]` or else to the panel; on close focus is
 * returned to the previously focused element; Tab is trapped inside the panel.
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
import { CloseIcon } from '@/components/common/icons';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

const SIZE_CLASSES: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[95vw]',
};

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

// ─── Module-level stack of open dialogs (bottom → top) ───────────────────────
// Only the topmost dialog handles Escape / Tab; body scroll is locked while the
// stack is non-empty and restored when the last dialog closes.
const openStack: string[] = [];
let savedBodyOverflow: string | null = null;

function pushDialog(id: string) {
  if (openStack.length === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  openStack.push(id);
}

function popDialog(id: string) {
  const index = openStack.lastIndexOf(id);
  if (index !== -1) openStack.splice(index, 1);
  if (openStack.length === 0 && savedBodyOverflow !== null) {
    document.body.style.overflow = savedBodyOverflow;
    savedBodyOverflow = null;
  }
}

function isTopDialog(id: string) {
  return openStack[openStack.length - 1] === id;
}

// ─── Context ──────────────────────────────────────────────────────────────────
interface DialogContextValue {
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
  setHasTitle: (has: boolean) => void;
  setHasDescription: (has: boolean) => void;
}

const noop = () => {};

const DialogContext = createContext<DialogContextValue>({
  onOpenChange: noop,
  titleId: '',
  descriptionId: '',
  setHasTitle: noop,
  setHasDescription: noop,
});

/** Access the enclosing dialog, e.g. a footer button: `const { close } = useDialogContext()`. */
export function useDialogContext() {
  const { onOpenChange } = useContext(DialogContext);
  return useMemo(() => ({ onOpenChange, close: () => onOpenChange(false) }), [onOpenChange]);
}

// ─── Dialog ───────────────────────────────────────────────────────────────────
export interface DialogProps extends React.HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  size?: DialogSize;
  /** Click on the backdrop closes the dialog (default `true`). */
  closeOnOverlay?: boolean;
  /** Escape closes the dialog (default `true`). The topmost dialog always swallows Escape. */
  closeOnEscape?: boolean;
}

export const Dialog = forwardRef<HTMLDivElement, DialogProps>(function Dialog(
  {
    open,
    onOpenChange,
    size = 'md',
    closeOnOverlay = true,
    closeOnEscape = true,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [hasTitle, setHasTitle] = useState(false);
  const [hasDescription, setHasDescription] = useState(false);

  // Latest-value refs so the keydown listener (registered once per open) never goes stale.
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const closeOnEscapeRef = useRef(closeOnEscape);
  closeOnEscapeRef.current = closeOnEscape;

  // Element to restore focus to. Captured during the render that opens the dialog, i.e. before
  // a child with `autoFocus` steals focus in the commit phase. `wasOpenRef` is synced in a layout
  // effect so re-renders triggered by children (e.g. DialogTitle registering) do not re-capture.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current) {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
  }
  useLayoutEffect(() => {
    wasOpenRef.current = open;
  }, [open]);

  const setPanelRef = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [ref],
  );

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    pushDialog(id);

    // Initial focus: keep a child React already auto-focused, else [autofocus]/[data-autofocus],
    // else the panel itself.
    const active = document.activeElement;
    if (!(active instanceof HTMLElement && panel.contains(active))) {
      const target = panel.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? panel;
      target.focus({ preventScroll: true });
    }

    // Keys are handled only when they originate inside this panel (or from <body> when nothing is
    // focused). Keys coming from other overlays stacked above (e.g. a portaled menu, a legacy
    // ConfirmDialog) are left to those overlays.
    const originatesHere = (target: EventTarget | null) =>
      target === document.body ||
      target === document.documentElement ||
      (target instanceof Node && panel.contains(target));

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTopDialog(id) || !originatesHere(e.target)) return;

      if (e.key === 'Escape') {
        e.stopPropagation();
        if (closeOnEscapeRef.current) {
          e.preventDefault();
          onOpenChangeRef.current(false);
        }
        return;
      }

      if (e.key === 'Tab') {
        const focusable = getFocusable(panel);
        if (focusable.length === 0) {
          e.preventDefault();
          panel.focus({ preventScroll: true });
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const current = document.activeElement as HTMLElement | null;
        const inside = !!current && panel.contains(current);
        if (e.shiftKey) {
          if (!inside || current === first || current === panel) {
            e.preventDefault();
            last.focus();
          }
        } else if (!inside || current === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      popDialog(id);

      // Restore focus only when it was lost (body) or is still inside the (now detached) panel —
      // never steal focus the user has deliberately moved elsewhere.
      const toRestore = restoreFocusRef.current;
      const activeNow = document.activeElement;
      if (
        toRestore &&
        toRestore.isConnected &&
        typeof toRestore.focus === 'function' &&
        (!activeNow || activeNow === document.body || panel.contains(activeNow))
      ) {
        toRestore.focus({ preventScroll: true });
      }
    };
  }, [open, id]);

  const context = useMemo<DialogContextValue>(
    () => ({ onOpenChange, titleId, descriptionId, setHasTitle, setHasDescription }),
    [onOpenChange, titleId, descriptionId, setHasTitle, setHasDescription],
  );

  // Track where the press started so a drag that begins inside the panel and ends on the
  // backdrop (e.g. selecting text) does not close the dialog.
  const pressedOnBackdrop = useRef(false);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const onBackdrop = e.target === e.currentTarget && pressedOnBackdrop.current;
        pressedOnBackdrop.current = false;
        if (onBackdrop && closeOnOverlay) onOpenChange(false);
      }}
    >
      <div
        ref={setPanelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={hasTitle ? titleId : undefined}
        aria-describedby={hasDescription ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[90vh] w-full flex-col rounded-2xl border border-border bg-popover text-foreground shadow-2xl outline-none',
          SIZE_CLASSES[size],
          className,
        )}
        style={{ animation: 'popupIn 150ms ease-out', ...style }}
        {...rest}
      >
        <DialogContext.Provider value={context}>{children}</DialogContext.Provider>
      </div>
    </div>,
    document.body,
  );
});
Dialog.displayName = 'Dialog';

// ─── Sub-components ───────────────────────────────────────────────────────────
export const DialogHeader = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function DialogHeader({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn('flex items-start justify-between gap-4 px-5 pt-5 pb-3', className)}
        {...rest}
      />
    );
  },
);
DialogHeader.displayName = 'DialogHeader';

export const DialogTitle = forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  function DialogTitle({ className, ...rest }, ref) {
    const { titleId, setHasTitle } = useContext(DialogContext);
    useLayoutEffect(() => {
      setHasTitle(true);
      return () => setHasTitle(false);
    }, [setHasTitle]);
    return (
      <h2
        ref={ref}
        id={titleId || undefined}
        className={cn('text-base font-semibold leading-6 text-foreground', className)}
        {...rest}
      />
    );
  },
);
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function DialogDescription({ className, ...rest }, ref) {
  const { descriptionId, setHasDescription } = useContext(DialogContext);
  useLayoutEffect(() => {
    setHasDescription(true);
    return () => setHasDescription(false);
  }, [setHasDescription]);
  return (
    <p
      ref={ref}
      id={descriptionId || undefined}
      className={cn('mt-1 text-sm text-muted-foreground', className)}
      {...rest}
    />
  );
});
DialogDescription.displayName = 'DialogDescription';

export const DialogBody = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function DialogBody({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-2', className)}
        {...rest}
      />
    );
  },
);
DialogBody.displayName = 'DialogBody';

export const DialogFooter = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function DialogFooter({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn('flex items-center justify-end gap-2 px-5 pb-5 pt-3', className)}
        {...rest}
      />
    );
  },
);
DialogFooter.displayName = 'DialogFooter';

/**
 * Icon button that closes the enclosing dialog. Place it as the last child of `DialogHeader`
 * (pushed to the right by `justify-between`) or anywhere in the panel with
 * `className="absolute right-3 top-3"`.
 */
export const DialogClose = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  function DialogClose({ className, onClick, children, ...rest }, ref) {
    const { onOpenChange } = useContext(DialogContext);
    return (
      <button
        ref={ref}
        type="button"
        aria-label="Đóng"
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          className,
        )}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented) onOpenChange(false);
        }}
        {...rest}
      >
        {children ?? <CloseIcon className="w-4 h-4" />}
      </button>
    );
  },
);
DialogClose.displayName = 'DialogClose';
