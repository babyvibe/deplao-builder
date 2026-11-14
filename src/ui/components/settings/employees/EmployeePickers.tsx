/**
 * Shared picker on the Employees page (the row under the employee card + the "Thêm nhân viên" (Add employee) box): assigned chat accounts (with
 * account images) and the permitted sections.
 */
import React from 'react';
import { Button, Checkbox } from '@/components/ui';
import type { AccountInfo } from '@/store/accounts/accountStore';
import { getChannelLabel, resolveAccountChannel } from '../../../../configs/channels/channelConfig';
import { EMPLOYEE_MODULES } from '@/lib/employee/employeeSettingsView';
import { MiniAccountAvatar } from '../notifications/InAppNotifySettings';
import { tr } from '../../../../shared/i18n';

function accountDetail(account: AccountInfo): string {
  const channel = getChannelLabel(resolveAccountChannel(account));
  return account.phone ? `${channel} · ${account.phone}` : channel;
}

/** List of chat accounts with checkboxes + "Chọn hết" (Select all). */
export function AccountChecklist({ accounts, value, onChange, disabled }: {
  accounts: readonly AccountInfo[];
  value: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  if (accounts.length === 0) {
    return <p className="text-xs text-muted-foreground">{tr('Chưa có tài khoản chat nào. Thêm ở Cài đặt → Tài khoản.')}</p>;
  }
  const all = accounts.every((account) => value.has(account.zalo_id));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(id); else next.delete(id);
    onChange(next);
  };
  return (
    <div className="space-y-1">
      {accounts.length > 1 && (
        <div className="flex justify-end">
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" disabled={disabled}
            onClick={() => onChange(all ? new Set() : new Set(accounts.map((account) => account.zalo_id)))}>
            {all ? tr('Bỏ chọn hết') : tr('Chọn hết')}
          </Button>
        </div>
      )}
      <div className="max-h-60 space-y-2.5 overflow-y-auto pr-1">
        {accounts.map((account) => (
          <Checkbox
            key={account.zalo_id}
            checked={value.has(account.zalo_id)}
            onCheckedChange={(on) => toggle(account.zalo_id, on)}
            label={(
              <span className="flex min-w-0 items-center gap-2.5">
                <MiniAccountAvatar account={account} />
                <span className="min-w-0">
                  <span className="block truncate">{account.full_name || account.zalo_id}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">{accountDetail(account)}</span>
                </span>
              </span>
            )}
            disabled={disabled}
            className="flex w-full items-center"
          />
        ))}
      </div>
    </div>
  );
}

const WORK_MODULES = EMPLOYEE_MODULES.filter((module) => module.group === 'work');
const SETTINGS_MODULES = EMPLOYEE_MODULES.filter((module) => module.group === 'settings');

/** Sections an employee may use: the work area (with "Chọn hết" (Select all)) and the Settings section, given only to trusted people. */
export function PermissionChecklist({ value, onChange, disabled }: {
  value: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
  disabled?: boolean;
}) {
  const allWork = WORK_MODULES.every((module) => value[module.key]);
  const set = (key: string, on: boolean) => onChange({ ...value, [key]: on });
  const setAllWork = (on: boolean) => {
    const next = { ...value };
    for (const module of WORK_MODULES) next[module.key] = on;
    onChange(next);
  };
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">{tr('Trang làm việc')}</p>
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" disabled={disabled} onClick={() => setAllWork(!allWork)}>
            {allWork ? tr('Bỏ chọn hết') : tr('Chọn hết')}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
          {WORK_MODULES.map((module) => (
            <Checkbox key={module.key} checked={!!value[module.key]} onCheckedChange={(on) => set(module.key, on)}
              label={module.label} description={module.desc} disabled={disabled} />
          ))}
        </div>
      </div>
      <div className="border-t border-border/60 pt-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{tr('Trong Cài đặt · chỉ giao cho người tin cậy')}</p>
        <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
          {SETTINGS_MODULES.map((module) => (
            <Checkbox key={module.key} checked={!!value[module.key]} onCheckedChange={(on) => set(module.key, on)}
              label={module.label} description={module.desc} disabled={disabled} />
          ))}
        </div>
      </div>
    </div>
  );
}
