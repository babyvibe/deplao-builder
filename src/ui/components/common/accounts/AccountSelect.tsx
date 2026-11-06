/**
 * Ô chọn MỘT tài khoản chuẩn của app (thay <select> trần và AccountSelectorDropdown cũ): nút giống ô Select của bộ giao
 * diện, hiện ảnh tài khoản + tên; danh sách chia theo kênh (Zalo, Facebook, Telegram), mỗi dòng ảnh kèm huy hiệu kênh +
 * tên + "Kênh · SĐT / @username", dấu ✓ ở dòng đang chọn. Dòng "tất cả" ở đầu tuỳ chọn (`allLabel`, chọn → null);
 * `note` ghi chú ngắn từng dòng (vd "riêng"). Dựa trên DropdownMenu (portal, tự lật lên khi thiếu chỗ, phím ↑ ↓ Enter Esc).
 */
import React from 'react';
import { cn } from '@/lib/cn';
import type { AccountInfo } from '@/store/accounts/accountStore';
import { isFacebook, isTelegram, isZalo } from '@/lib/channels/channelHelper';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui';
import { CheckIcon, ChevronDownIcon, UsersIcon } from '@/components/common/icons';
import { getChannelLabel, resolveAccountChannel } from '../../../../configs/channels/channelConfig';
import { AccountAvatar } from './AccountAvatar';

export type SelectableAccount = Pick<AccountInfo, 'zalo_id' | 'full_name' | 'avatar_url' | 'channel' | 'phone' | 'username'>;

/** Dòng phụ dưới tên: kênh · SĐT (hoặc @username). */
export function accountSelectDetail(account: SelectableAccount): string {
  const channel = getChannelLabel(resolveAccountChannel(account));
  if (account.phone) return `${channel} · ${account.phone}`;
  if (account.username) return `${channel} · @${account.username}`;
  return channel;
}

/** Nhóm theo kênh, thứ tự Zalo → Facebook → Telegram (cá nhân + bot) → kênh khác; giữ thứ tự tài khoản trong nhóm. */
export function groupAccountsByChannel<T extends SelectableAccount>(accounts: readonly T[]): Array<{ label: string; accounts: T[] }> {
  const groups: Array<{ label: string; test: (channel?: string) => boolean; accounts: T[] }> = [
    { label: 'Zalo', test: (channel) => isZalo(channel as any), accounts: [] },
    { label: 'Facebook', test: (channel) => isFacebook(channel as any), accounts: [] },
    { label: 'Telegram', test: (channel) => isTelegram(channel as any), accounts: [] },
  ];
  const other: T[] = [];
  for (const account of accounts) {
    const channel = resolveAccountChannel(account);
    const group = groups.find((item) => item.test(channel));
    if (group) group.accounts.push(account); else other.push(account);
  }
  const result = groups.filter((group) => group.accounts.length > 0).map(({ label, accounts: list }) => ({ label, accounts: list }));
  if (other.length) result.push({ label: 'Khác', accounts: other });
  return result;
}

export interface AccountSelectProps<T extends SelectableAccount = SelectableAccount> {
  accounts: readonly T[];
  /** zalo_id đang chọn; null = dòng "tất cả" (khi có `allLabel`) hoặc chưa chọn */
  value: string | null;
  onChange: (accountId: string | null) => void;
  /** Dòng đầu "tất cả", vd "Tất cả tài khoản (mặc định)"; chọn → onChange(null) */
  allLabel?: string;
  /** Dòng phụ của dòng "tất cả" */
  allDetail?: string;
  placeholder?: string;
  /** Chữ ghi chú nhỏ sau tên (vd "riêng") */
  note?: (account: T) => string | null | undefined;
  /** sm: cao 32px chữ nhỏ (thanh công cụ, góc mục); md: như ô nhập */
  size?: 'sm' | 'md';
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  disabled?: boolean;
  /** Lớp cho phần bao nút (độ rộng, vd w-64 / w-full) */
  triggerClassName?: string;
  'aria-label'?: string;
}

export default function AccountSelect<T extends SelectableAccount>({
  accounts, value, onChange, allLabel, allDetail, placeholder = 'Chọn tài khoản', note, size = 'md', align = 'start',
  side = 'bottom', disabled = false, triggerClassName, 'aria-label': ariaLabel,
}: AccountSelectProps<T>) {
  const selected = value ? accounts.find((account) => account.zalo_id === value) : undefined;
  const groups = groupAccountsByChannel(accounts);
  const showGroupLabels = groups.length > 1;
  const selectedNote = selected ? note?.(selected) : null;

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-muted text-left text-foreground transition-colors',
        'hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-transparent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2 text-xs' : 'h-9 px-2.5 text-sm',
      )}
    >
      {selected ? (
        <AccountAvatar account={selected} size={20} />
      ) : allLabel ? (
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UsersIcon className="h-3 w-3" />
        </span>
      ) : null}
      <span className={cn('min-w-0 flex-1 truncate', !selected && !allLabel && 'text-subtle-foreground')}>
        {selected ? selected.full_name || selected.zalo_id : allLabel || placeholder}
      </span>
      {selectedNote && <span className="flex-shrink-0 text-[11px] text-muted-foreground">{selectedNote}</span>}
      <ChevronDownIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    </button>
  );

  const item = (account: T) => {
    const active = account.zalo_id === value;
    const accountNote = note?.(account);
    return (
      <DropdownMenuItem
        key={account.zalo_id}
        onSelect={() => { if (!active) onChange(account.zalo_id); }}
        aria-current={active ? 'true' : undefined}
        className={cn('py-1.5', active && 'bg-selected')}
        shortcut={active ? <CheckIcon className="h-4 w-4 text-primary" /> : undefined}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <AccountAvatar account={account} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">
              {account.full_name || account.zalo_id}
              {accountNote && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{accountNote}</span>}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{accountSelectDetail(account)}</span>
          </span>
        </span>
      </DropdownMenuItem>
    );
  };

  return (
    <DropdownMenu
      trigger={trigger}
      align={align}
      side={side}
      triggerClassName={cn('min-w-0', triggerClassName)}
      className="w-72 max-w-[calc(100vw-1rem)] max-h-[min(24rem,calc(100vh-1rem))]"
    >
      {allLabel && (
        <>
          <DropdownMenuItem
            onSelect={() => { if (value) onChange(null); }}
            aria-current={!value ? 'true' : undefined}
            className={cn('py-1.5', !value && 'bg-selected')}
            shortcut={!value ? <CheckIcon className="h-4 w-4 text-primary" /> : undefined}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <UsersIcon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">{allLabel}</span>
                {allDetail && <span className="block truncate text-xs text-muted-foreground">{allDetail}</span>}
              </span>
            </span>
          </DropdownMenuItem>
          {accounts.length > 0 && <DropdownMenuSeparator />}
        </>
      )}
      {groups.map((group) => (
        <div key={group.label} role="group" aria-label={group.label}>
          {showGroupLabels && <DropdownMenuLabel>{group.label}</DropdownMenuLabel>}
          {group.accounts.map(item)}
        </div>
      ))}
      {accounts.length === 0 && !allLabel && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Chưa có tài khoản nào</p>
      )}
    </DropdownMenu>
  );
}
