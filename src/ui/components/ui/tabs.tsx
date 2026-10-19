/**
 * Tabs — controlled tab set with `underline` (default) or `pills` styling.
 *
 * ```tsx
 * <Tabs value={tab} onValueChange={setTab}>
 *   <TabsList>
 *     <TabsTrigger value="all" count={12}>Tất cả</TabsTrigger>
 *     <TabsTrigger value="unread" icon={<MessageIcon />}>Chưa đọc</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="all">…</TabsContent>
 *   <TabsContent value="unread">…</TabsContent>
 * </Tabs>
 * ```
 *
 * Keyboard: ←/→ (wrap) and Home/End move between enabled triggers inside a list and activate
 * the focused tab. Only the active `TabsContent` is rendered.
 */
import React, { createContext, forwardRef, useContext, useId, useMemo } from 'react';
import { cn } from '@/lib/cn';

export type TabsVariant = 'underline' | 'pills';

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  variant: TabsVariant;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error(`<${component}> phải được đặt bên trong <Tabs>`);
  return context;
}

/** Turn an arbitrary tab value into a safe id token. */
function slug(value: string) {
  return value.replace(/[^\w-]+/g, '_');
}

function tabIds(baseId: string, value: string) {
  const token = slug(value);
  return { tabId: `${baseId}-tab-${token}`, panelId: `${baseId}-panel-${token}` };
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
  variant?: TabsVariant;
}

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  { value, onValueChange, variant = 'underline', className, children, ...rest },
  ref,
) {
  const baseId = useId();
  const context = useMemo<TabsContextValue>(
    () => ({ value, onValueChange, variant, baseId }),
    [value, onValueChange, variant, baseId],
  );
  return (
    <TabsContext.Provider value={context}>
      <div ref={ref} data-variant={variant} className={className} {...rest}>
        {children}
      </div>
    </TabsContext.Provider>
  );
});
Tabs.displayName = 'Tabs';

// ─── TabsList ─────────────────────────────────────────────────────────────────
const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

export const TabsList = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function TabsList({ className, onKeyDown, ...rest }, ref) {
    const { variant } = useTabsContext('TabsList');

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented || !NAV_KEYS.includes(e.key)) return;
      const tabs = Array.from(
        e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
      );
      if (tabs.length === 0) return;
      const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return; // focus is on something else inside the list — leave it alone
      let next: number;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      else if (e.key === 'ArrowRight') next = (current + 1) % tabs.length;
      else next = (current - 1 + tabs.length) % tabs.length;
      e.preventDefault();
      tabs[next].focus();
      tabs[next].click(); // activate on focus move
    };

    return (
      <div
        ref={ref}
        role="tablist"
        aria-orientation="horizontal"
        className={cn(
          variant === 'pills'
            ? 'inline-flex items-center gap-1 rounded-lg bg-muted p-1'
            : 'flex items-center gap-1 border-b border-border',
          className,
        )}
        onKeyDown={handleKeyDown}
        {...rest}
      />
    );
  },
);
TabsList.displayName = 'TabsList';

// ─── TabsTrigger ──────────────────────────────────────────────────────────────
export interface TabsTriggerProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  value: string;
  icon?: React.ReactNode;
  /** Small counter pill after the label. */
  count?: number | string;
}

export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(function TabsTrigger(
  { value, icon, count, disabled, className, children, onClick, ...rest },
  ref,
) {
  const { value: activeValue, onValueChange, variant, baseId } = useTabsContext('TabsTrigger');
  const active = activeValue === value;
  const { tabId, panelId } = tabIds(baseId, value);

  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={tabId}
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      disabled={disabled}
      data-state={active ? 'active' : 'inactive'}
      data-value={value}
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
        variant === 'pills'
          ? cn('h-7 rounded-md px-3 text-muted-foreground hover:text-foreground', active && 'bg-card text-foreground shadow-sm')
          : cn('relative h-9 px-3 font-medium text-muted-foreground hover:text-foreground', active && 'text-foreground'),
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented && !active) onValueChange(value);
      }}
      {...rest}
    >
      {icon != null && (
        <span className="mr-1.5 inline-flex shrink-0 items-center [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      )}
      {children}
      {count != null && (
        <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[11px] leading-4 tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
      {variant === 'underline' && active && (
        <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />
      )}
    </button>
  );
});
TabsTrigger.displayName = 'TabsTrigger';

// ─── TabsContent ──────────────────────────────────────────────────────────────
export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(function TabsContent(
  { value, className, ...rest },
  ref,
) {
  const { value: activeValue, baseId } = useTabsContext('TabsContent');
  if (activeValue !== value) return null;
  const { tabId, panelId } = tabIds(baseId, value);
  return (
    <div
      ref={ref}
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId}
      className={cn('focus-visible:outline-none', className)}
      {...rest}
    />
  );
});
TabsContent.displayName = 'TabsContent';
