/**
 * ScopePicker — chọn phạm vi dữ liệu cho Đồng bộ dữ liệu (dữ liệu + ảnh/file; CloudScope, src/shared/cloud/cloudContracts.ts):
 *  - Tài khoản: Tất cả (kể cả tài khoản thêm sau) / Chọn tài khoản → danh sách tài khoản của workspace đang mở
 *    (useAccountStore, có huy hiệu kênh như các màn khác).
 *  - Thời gian: Toàn bộ / Từ ngày → ô ngày (00:00 giờ máy của ngày chọn).
 * Component điều khiển (value/onChange). Nút lưu nằm ở phần dùng (Đồng bộ dữ liệu: "Lưu thiết lập") để không lưu theo
 * từng cú bấm. AccountChecklist và DateField dùng lại ở hộp Dọn file trên R2; ScopeRow dùng lại cho các hàng khác của form.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { useAccountStore } from '@/store/accounts/accountStore';
import { Button, Checkbox, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import { QuickAccountAvatar } from '@/components/chat/quick/QuickAccountPicker';
import { getChannelLabel, normalizeChannel } from '../../../../../configs/channels/channelConfig';
import type { CloudScope } from '../../../../../shared/cloud/cloudContracts';
import {
  defaultScopeFromTs,
  fmtNum,
  fromDateInput,
  RadioList,
  scopeAccountName,
  startOfLocalDay,
  toDateInput,
  type ScopeAccount,
} from '../cloudUi';

export interface ScopePickerProps {
  value: CloudScope;
  onChange: (next: CloudScope) => void;
  disabled?: boolean;
  /** Tài khoản để chọn; mặc định là tài khoản của workspace đang mở (useAccountStore). */
  accounts?: ReadonlyArray<ScopeAccount>;
  /** Tên vùng cho trình đọc màn hình, vd "Phạm vi lưu media". */
  label?: string;
  className?: string;
}

const NO_IDS: string[] = [];
const NO_ACCOUNTS: ReadonlyArray<ScopeAccount> = [];

/** Tài khoản của workspace đang mở (selector, không đọc cả store); `override` dùng cho test / màn khác. */
export function useScopeAccounts(override?: ReadonlyArray<ScopeAccount>): ReadonlyArray<ScopeAccount> {
  const storeAccounts = useAccountStore(s => s.accounts);
  return override ?? storeAccounts ?? NO_ACCOUNTS;
}

/** Một hàng của khối phạm vi: nhãn cột trái (Tài khoản, Thời gian…), điều khiển bên phải. Dùng lại ở Đồng bộ dữ liệu. */
export function ScopeRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
      <p className="text-sm text-muted-foreground sm:w-24 sm:flex-shrink-0 sm:leading-8">{label}</p>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

function AccountRow({ account, missingId, checked, disabled, onToggle }: {
  account?: ScopeAccount;
  /** Tài khoản đã chọn nhưng không còn trong workspace (vẫn bỏ chọn được). */
  missingId?: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  const id = useId();
  const name = account ? scopeAccountName(account) : 'Tài khoản không còn trong workspace';
  const meta = account ? getChannelLabel(normalizeChannel(account.channel || undefined)) : missingId;
  return (
    <li className={cn('flex items-center gap-3 px-3 py-2 transition-colors', !disabled && 'hover:bg-muted')}>
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onToggle} aria-label={name} className="[&>button]:mt-0" />
      <label
        htmlFor={id}
        className={cn('flex min-w-0 flex-1 items-center gap-2.5', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}
      >
        {account
          ? <QuickAccountAvatar account={account} size={24} />
          : <span className="h-6 w-6 flex-shrink-0 rounded-full bg-muted" aria-hidden="true" />}
        <span className={cn('min-w-0 flex-1 truncate text-sm', account ? 'text-foreground' : 'text-muted-foreground')}>{name}</span>
        {meta && <span className="max-w-[40%] flex-shrink-0 truncate text-xs text-subtle-foreground">{meta}</span>}
      </label>
    </li>
  );
}

/**
 * Danh sách tài khoản có ô chọn (avatar + huy hiệu kênh), "Chọn hết" / "Bỏ chọn hết". Id đã chọn mà không còn trong
 * danh sách vẫn hiện để bỏ chọn được.
 */
export function AccountChecklist({ accounts, selected, onChange, disabled = false, className }: {
  accounts: ReadonlyArray<ScopeAccount>;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const selectedSet = new Set(selected);
  const knownIds = new Set(accounts.map(a => a.zalo_id));
  const missing = selected.filter(id => !knownIds.has(id));
  const total = accounts.length + missing.length;

  const toggle = (id: string, on: boolean) => {
    if (on) { if (!selectedSet.has(id)) onChange([...selected, id]); }
    else onChange(selected.filter(x => x !== id));
  };

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border', className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-3 py-1.5">
        <span className="text-xs text-muted-foreground">Đã chọn {fmtNum(selected.length)}/{fmtNum(total)} tài khoản</span>
        <span className="flex items-center gap-3">
          <Button
            variant="link"
            size="sm"
            className="text-xs"
            disabled={disabled || total === 0 || selected.length === total}
            onClick={() => onChange([...accounts.map(a => a.zalo_id), ...missing])}
          >
            Chọn hết
          </Button>
          <Button variant="link" size="sm" className="text-xs" disabled={disabled || selected.length === 0} onClick={() => onChange([])}>
            Bỏ chọn hết
          </Button>
        </span>
      </div>
      {total === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">Workspace này chưa có tài khoản nào.</p>
      ) : (
        <ul className="max-h-64 divide-y divide-border overflow-y-auto">
          {accounts.map(account => (
            <AccountRow
              key={account.zalo_id}
              account={account}
              checked={selectedSet.has(account.zalo_id)}
              disabled={disabled}
              onToggle={on => toggle(account.zalo_id, on)}
            />
          ))}
          {missing.map(id => (
            <AccountRow key={`missing:${id}`} missingId={id} checked disabled={disabled} onToggle={on => toggle(id, on)} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Ô ngày (giá trị = 00:00 giờ máy, ms). Nháp khi gõ (ô date báo '' khi chưa gõ đủ ngày), chỉ báo lên khi là ngày hợp lệ
 * và không quá hôm nay; rời ô thì trả lại ngày đang chọn.
 */
export function DateField({ value, onChange, label, disabled = false, id, className }: {
  value: number | null;
  onChange: (ts: number) => void;
  /** Nhãn cho trình đọc màn hình. */
  label: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = startOfLocalDay(Date.now());

  const type = (text: string) => {
    const ts = fromDateInput(text);
    if (ts == null || ts > today) {
      setDraft(text);
      setError(ts != null ? 'Chọn ngày không quá hôm nay.' : text ? 'Ngày không hợp lệ.' : null);
      return;
    }
    setDraft(null);
    setError(null);
    if (ts !== value) onChange(ts);
  };

  return (
    <span className={cn('inline-flex flex-col gap-1', className)}>
      <Input
        id={id}
        type="date"
        aria-label={label}
        className="h-8 w-44"
        value={draft ?? toDateInput(value)}
        max={toDateInput(today)}
        invalid={!!error}
        disabled={disabled}
        onChange={e => type(e.target.value)}
        onBlur={() => { setDraft(null); setError(null); }}
      />
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </span>
  );
}

export function ScopePicker({ value, onChange, disabled = false, accounts: accountsProp, label = 'Phạm vi', className }: ScopePickerProps) {
  const accounts = useScopeAccounts(accountsProp);
  const picking = Array.isArray(value.accounts);
  const selected: string[] = picking ? (value.accounts as string[]) : NO_IDS;
  const fromMode = !!value.fromTs;

  // Đổi qua lại Tất cả ↔ Chọn tài khoản, Toàn bộ ↔ Từ ngày: giữ lựa chọn trước đó.
  const lastPicked = useRef<string[]>(selected);
  const lastFromTs = useRef<number | null>(value.fromTs || null);
  useEffect(() => { if (Array.isArray(value.accounts)) lastPicked.current = value.accounts; }, [value.accounts]);
  useEffect(() => { if (value.fromTs) lastFromTs.current = value.fromTs; }, [value.fromTs]);

  const chooseAccounts = (mode: 'all' | 'pick') => {
    onChange({ ...value, accounts: mode === 'all' ? 'all' : [...lastPicked.current] });
  };

  const chooseTime = (mode: 'all' | 'from') => {
    onChange({ ...value, fromTs: mode === 'all' ? null : (lastFromTs.current ?? defaultScopeFromTs()) });
  };

  return (
    <div role="group" aria-label={label} className={cn('space-y-4', className)}>
      <ScopeRow label="Tài khoản">
        <RadioList
          inline
          label="Tài khoản"
          className="min-h-8"
          value={picking ? 'pick' : 'all'}
          disabled={disabled}
          onChange={chooseAccounts}
          options={[
            { value: 'all', label: <>Tất cả <span className="text-muted-foreground">(kể cả tài khoản thêm sau)</span></> },
            { value: 'pick', label: 'Chọn tài khoản' },
          ]}
        />
        {picking && (
          <AccountChecklist
            accounts={accounts}
            selected={selected}
            disabled={disabled}
            onChange={ids => onChange({ ...value, accounts: ids })}
          />
        )}
      </ScopeRow>

      <ScopeRow label="Thời gian">
        <div className="flex min-h-8 flex-wrap items-center gap-x-5 gap-y-2">
          <RadioList
            inline
            label="Thời gian"
            value={fromMode ? 'from' : 'all'}
            disabled={disabled}
            onChange={chooseTime}
            options={[
              { value: 'all', label: 'Toàn bộ' },
              { value: 'from', label: 'Từ ngày' },
            ]}
          />
          {fromMode && (
            <DateField
              label="Từ ngày"
              value={value.fromTs}
              disabled={disabled}
              onChange={ts => onChange({ ...value, fromTs: ts })}
            />
          )}
        </div>
      </ScopeRow>
    </div>
  );
}

export default ScopePicker;
