/**
 * Pick a group for an employee: the "Nhóm" (Group) row under the employee card and in the "Thêm nhân viên" (Add employee) box (replaces the separate "Nhóm" section at the bottom of the
 * Employees page before). One row of buttons: "Không có nhóm" (No group), each group, "+ Nhóm mới" (New group) (type a name then Enter: creates and selects it).
 * `manage`: the selected group can be renamed / deleted right below.
 */
import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/app/appStore';
import { Button, Input } from '@/components/ui';
import { PlusIcon } from '@/components/common/icons';
import { groupNameTaken, type EmployeeGroupRecord } from '@/lib/employee/employeeSettingsView';
import { showConfirm } from '../../common/ConfirmDialog';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export default function EmployeeGroupPicker({
  groups, value, onChange, onGroupsChanged, manage = false, memberCount, disabled = false,
}: {
  groups: readonly EmployeeGroupRecord[];
  /** Selected group_id, '' = no group */
  value: string;
  onChange: (groupId: string) => void;
  /** Just created / renamed / deleted a group: reload the list */
  onGroupsChanged: () => void;
  manage?: boolean;
  /** Number of employees in the group (asks before deleting) */
  memberCount?: (groupId: string) => number;
  disabled?: boolean;
}) {
  const showNotification = useAppStore((s) => s.showNotification);
  /** New group just created: show it right away, do not wait for the list to reload */
  const [created, setCreated] = useState<EmployeeGroupRecord[]>([]);
  const [mode, setMode] = useState<'idle' | 'create' | 'rename'>('idle');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const list = [...groups, ...created.filter((item) => !groups.some((group) => group.group_id === item.group_id))];
  const selected = value ? list.find((group) => group.group_id === value) : undefined;
  const locked = disabled || busy;

  const cancel = () => { setMode('idle'); setDraft(''); };

  const create = async () => {
    const name = draft.trim();
    if (!name) return;
    if (groupNameTaken(list, name)) { showNotification(tr('Đã có nhóm tên này'), 'warning'); return; }
    setBusy(true);
    try {
      const res = await ipc.employee?.createGroup(name);
      if (res?.success && res.group?.group_id) {
        const group: EmployeeGroupRecord = { group_id: String(res.group.group_id), name: String(res.group.name || name) };
        setCreated((prev) => [...prev, group]);
        cancel();
        onChange(group.group_id);
        onGroupsChanged();
      } else {
        showNotification(res?.error || tr('Không tạo được nhóm'), 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || tr('Không tạo được nhóm'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!selected) return;
    const name = draft.trim();
    if (!name || name === selected.name) { cancel(); return; }
    if (groupNameTaken(list, name, selected.group_id)) { showNotification(tr('Đã có nhóm tên này'), 'warning'); return; }
    setBusy(true);
    try {
      const res = await ipc.employee?.updateGroup(selected.group_id, { name });
      if (res?.success) {
        setCreated((prev) => prev.map((group) => (group.group_id === selected.group_id ? { ...group, name } : group)));
        cancel();
        onGroupsChanged();
      } else {
        showNotification(res?.error || tr('Không đổi được tên nhóm'), 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || tr('Không đổi được tên nhóm'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    const count = memberCount?.(selected.group_id) ?? 0;
    const ok = await showConfirm({
      title: tr('Xoá nhóm "{{name}}"?', { name: selected.name }),
      message: count ? tr('{{count}} nhân viên trong nhóm vẫn giữ nguyên, chỉ không còn nhóm.', { count }) : tr('Nhóm chưa có ai.'),
      confirmText: tr('Xoá nhóm'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await ipc.employee?.deleteGroup(selected.group_id);
      if (res?.success) {
        setCreated((prev) => prev.filter((group) => group.group_id !== selected.group_id));
        onGroupsChanged();
      } else {
        showNotification(res?.error || tr('Không xoá được nhóm'), 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || tr('Không xoá được nhóm'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const chip = (groupId: string, label: string) => {
    const active = value === groupId;
    return (
      <button key={groupId || '_none'} type="button" role="radio" aria-checked={active} disabled={locked}
        onClick={() => { if (!active) onChange(groupId); }}
        className={cn(
          'max-w-[12rem] truncate rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-60',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        {label}
      </button>
    );
  };

  const nameInput = (onSubmit: () => void, placeholder: string, aria: string) => (
    <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} aria-label={aria}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onSubmit(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      disabled={busy} className="h-7 w-40 text-xs" />
  );

  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label={tr('Nhóm')} className="flex flex-wrap items-center gap-1.5">
        {chip('', tr('Không có nhóm'))}
        {list.map((group) => chip(group.group_id, group.name))}
        {mode === 'create' ? (
          <span className="flex items-center gap-1.5">
            {nameInput(() => { void create(); }, tr('Tên nhóm, vd CSKH'), tr('Tên nhóm mới'))}
            <Button size="sm" className="h-7" onClick={() => { void create(); }} disabled={!draft.trim()} loading={busy}>{tr('Tạo')}</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={cancel} disabled={busy}>{tr('Huỷ')}</Button>
          </span>
        ) : (
          <button type="button" onClick={() => { setMode('create'); setDraft(''); }} disabled={locked}
            className="flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-60">
            {trx('<0/> Nhóm mới', { 0: <PlusIcon className="h-3 w-3" /> })}
          </button>
        )}
      </div>

      {manage && selected && mode !== 'create' && (
        mode === 'rename' ? (
          <div className="flex items-center gap-1.5">
            {nameInput(() => { void rename(); }, tr('Tên nhóm'), tr('Tên mới của nhóm'))}
            <Button size="sm" className="h-7" onClick={() => { void rename(); }} disabled={!draft.trim()} loading={busy}>{tr('Lưu')}</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={cancel} disabled={busy}>{tr('Huỷ')}</Button>
          </div>
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            <span className="max-w-[14rem] truncate">{trx('Nhóm {{name}}:', { name: selected.name })}</span>
            <button type="button" disabled={locked} onClick={() => { setMode('rename'); setDraft(selected.name); }}
              className="font-medium text-primary hover:underline disabled:opacity-60">{tr('Đổi tên')}</button>
            <span aria-hidden="true">·</span>
            <button type="button" disabled={locked} onClick={() => { void remove(); }}
              className="font-medium text-destructive hover:underline disabled:opacity-60">{tr('Xoá nhóm')}</button>
          </p>
        )
      )}
    </div>
  );
}
