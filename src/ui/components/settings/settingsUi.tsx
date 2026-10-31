/**
 * Khung dùng chung của mọi trang Cài đặt, để các trang trông và đọc như nhau:
 * - SettingsPage: tiêu đề + 1 dòng mô tả + nút bên phải; độ rộng `form` (trang chỉnh, dễ đọc), `wide` (danh sách, bảng)
 *   hoặc `full`; `fill` cho trang tự chia vùng cuộn (Hội thoại, Nhật ký…).
 * - SettingsSection: một khối có tiêu đề nhỏ phía trên, nội dung trong thẻ; các dòng bên trong có vạch ngăn.
 * - SettingsRow: tên + mô tả ngắn bên trái, điều khiển bên phải; `children` = phần mở rộng ngay dưới dòng.
 * - Notice: dải thông báo (dùng chung với Internet & Đám mây).
 * Chỉ dùng token màu (bg-card, text-foreground, primary…) nên đúng cả giao diện sáng và tối.
 */
import React from 'react';
import { cn } from '@/lib/cn';

export { Notice, type NoticeTone } from './cloud/cloudUi';

type PageWidth = 'form' | 'wide' | 'full';

const PAGE_WIDTH: Record<PageWidth, string> = {
  form: 'max-w-3xl',
  wide: 'max-w-5xl',
  full: '',
};

export function SettingsPage({ title, description, actions, width = 'form', fill, className, children }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  width?: PageWidth;
  /** Trang cao đúng khung (vùng cuộn nằm bên trong trang). */
  fill?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('px-6 py-5', fill && 'flex h-full min-h-0 flex-col', className)}>
      <div className={cn('w-full', PAGE_WIDTH[width], fill && 'flex min-h-0 flex-1 flex-col')}>
        <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold leading-tight text-foreground">{title}</h2>
            {description != null && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions != null && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
        <div className={cn(fill ? 'flex min-h-0 flex-1 flex-col' : 'space-y-6')}>{children}</div>
      </div>
    </div>
  );
}

export function SettingsSection({ title, description, action, footer, flush, className, bodyClassName, children }: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Ghi chú nhỏ ngay dưới thẻ. */
  footer?: React.ReactNode;
  /** Không tự chia dòng / không lề trong: nội dung tự trình bày (danh sách, bảng…). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn('space-y-2', className)}>
      {(title != null || action != null) && (
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 px-1">
          <div className="min-w-0">
            {title != null && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
            {description != null && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {action != null && <div className="flex flex-shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      <div
        className={cn(
          'rounded-xl border border-border/60 bg-card',
          !flush && 'divide-y divide-border/60 px-4',
          bodyClassName,
        )}
      >
        {children}
      </div>
      {footer != null && <div className="px-1 text-xs leading-relaxed text-muted-foreground">{footer}</div>}
    </section>
  );
}

export function SettingsRow({ title, description, control, className, children }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  className?: string;
  /** Phần mở rộng ngay dưới dòng (thanh trượt, ô nhập…). */
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('py-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description != null && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {control != null && <div className="flex flex-shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children != null && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** Đường dẫn / địa chỉ dạng mã, cắt gọn một dòng (di chuột xem đủ). */
export function PathText({ value, className }: { value: string; className?: string }) {
  return (
    <code title={value} className={cn('block truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs text-foreground', className)}>
      {value}
    </code>
  );
}

/** Nhóm nút chọn một dạng viên (tab nhỏ trong trang). */
export function SegmentedControl<T extends string>({ value, options, onChange, label, className }: {
  value: T;
  options: { value: NoInfer<T>; label: React.ReactNode; count?: number }[];
  onChange: (value: NoInfer<T>) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn('inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1', className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => { if (!active) onChange(opt.value); }}
            className={cn(
              'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.label}
            {opt.count != null && opt.count > 0 && (
              <span className={cn('rounded-full px-1.5 text-[10px] leading-4', active ? 'bg-primary/10 text-primary' : 'bg-accent text-muted-foreground')}>
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
