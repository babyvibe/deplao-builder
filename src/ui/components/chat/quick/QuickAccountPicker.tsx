/**
 * Chọn tài khoản cho thao tác nhanh: nút hiện tài khoản đang chọn, bấm mở danh sách ngay bên dưới
 * (gộp trang: tài khoản của trang gộp trước). Tài khoản không làm được thao tác hiện mờ kèm lý do.
 */
import React, { useState } from 'react';
import { cn } from '@/lib/cn';
import { toLocalMediaUrl } from '@/lib/localMedia';
import ChannelBadge from '@/components/common/ChannelBadge';
import { CheckIcon, ChevronDownIcon } from '@/components/common/icons';
import type { Channel } from '../../../../configs/channelConfig';
import {
  CHANNEL_SHORT_LABEL,
  accountChannel,
  accountLabel,
  type QuickAccountEntry,
  type QuickAccountLike,
} from './quickActions';

export function QuickAccountAvatar({ account, size = 28, className }: { account: QuickAccountLike; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const channel = accountChannel(account) as Channel;
  const src = account.avatar_url ? toLocalMediaUrl(account.avatar_url) : '';
  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      {src && !failed ? (
        <img src={src} alt="" onError={() => setFailed(true)} className="h-full w-full rounded-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-foreground/80">
          {(accountLabel(account) || '?').charAt(0).toUpperCase()}
        </span>
      )}
      {/* Avatar nhỏ (24–28px): thu nhỏ huy hiệu kênh, đẩy ra góc để không che chữ cái đầu */}
      <span className="absolute -bottom-1 -right-1 flex origin-bottom-right scale-[0.8] rounded-full ring-2 ring-popover">
        <ChannelBadge channel={channel} size="xs" />
      </span>
    </span>
  );
}

export interface QuickAccountPickerProps<T extends QuickAccountLike> {
  entries: QuickAccountEntry<T>[];
  value: string | null;
  onChange: (account: T) => void;
  /** Lý do không chọn được (null = chọn được). */
  disabledReason?: (account: T) => string | null;
  label?: string;
  className?: string;
}

export function QuickAccountPicker<T extends QuickAccountLike>({
  entries, value, onChange, disabledReason, label = 'Tài khoản', className,
}: QuickAccountPickerProps<T>) {
  const [open, setOpen] = useState(false);
  const selected = entries.find(entry => entry.account.zalo_id === value)?.account || null;
  const hasMergedSection = entries.some(entry => entry.inMerged);

  return (
    <div className={cn('space-y-1.5', className)}>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-lg border border-input bg-muted/50 px-2.5 py-1.5 text-left transition-colors hover:border-border-strong">
        {selected ? <QuickAccountAvatar account={selected} size={26} /> : <span className="h-[26px] w-[26px] rounded-full bg-muted" />}
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] uppercase tracking-wide text-subtle-foreground">{label}</span>
          <span className="block truncate text-[13px] font-medium text-foreground">
            {selected ? accountLabel(selected) : 'Chọn tài khoản'}
            {selected && <span className="font-normal text-muted-foreground"> · {CHANNEL_SHORT_LABEL[accountChannel(selected)] || accountChannel(selected)}</span>}
          </span>
        </span>
        <ChevronDownIcon className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div role="listbox" className="max-h-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-sm">
          {entries.map((entry, index) => {
            const reason = disabledReason?.(entry.account) ?? null;
            const active = entry.account.zalo_id === value;
            const showMergedHeader = hasMergedSection && index === 0 && entry.inMerged;
            const showOthersHeader = hasMergedSection && !entry.inMerged && (index === 0 || entries[index - 1].inMerged);
            return (
              <React.Fragment key={entry.account.zalo_id}>
                {showMergedHeader && <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-subtle-foreground">Trang gộp</p>}
                {showOthersHeader && <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-subtle-foreground">Tài khoản khác</p>}
                <button type="button" role="option" aria-selected={active} aria-disabled={!!reason}
                  title={reason || undefined}
                  onClick={() => { if (reason) return; onChange(entry.account); setOpen(false); }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                    reason ? 'cursor-not-allowed opacity-50' : 'hover:bg-muted',
                    active && 'bg-selected hover:bg-selected',
                  )}>
                  <QuickAccountAvatar account={entry.account} size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground">{accountLabel(entry.account)}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {reason || (CHANNEL_SHORT_LABEL[accountChannel(entry.account)] || accountChannel(entry.account))}
                      {!reason && entry.isActive && ' · đang mở'}
                    </span>
                  </span>
                  {active && <CheckIcon className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
