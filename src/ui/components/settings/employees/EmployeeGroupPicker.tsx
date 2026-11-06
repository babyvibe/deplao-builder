/**
 * Chọn nhóm cho nhân viên: dòng "Nhóm" dưới thẻ nhân viên và hộp "Thêm nhân viên" (thay mục "Nhóm" riêng ở cuối trang
 * Nhân viên trước đây). Một hàng nút: "Không có nhóm", từng nhóm, "+ Nhóm mới" (gõ tên rồi Enter: tạo và chọn luôn).
 * `manage`: nhóm đang chọn đổi tên / xoá được ngay bên dưới.
 */
import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/app/appStore';
import { Button, Input } from '@/components/ui';
import { PlusIcon } from '@/components/common/icons';
import { groupNameTaken, type EmployeeGroupRecord } from '@/lib/employee/employeeSettingsView';
import { showConfirm } from '../../common/ConfirmDialog';

export default function EmployeeGroupPicker({
  groups, value, onChange, onGroupsChanged, manage = false, memberCount, disabled = false,
}: {
  groups: readonly EmployeeGroupRecord[];
  /** group_id đang chọn, '' = không có nhóm */
  value: string;
  onChange: (groupId: string) => void;
  /** Vừa tạo / đổi tên / xoá nhóm: nạp lại danh sách */
  onGroupsChanged: () => void;
  manage?: boolean;
  /** Số nhân viên trong nhóm (hỏi trước khi xoá) */
  memberCount?: (groupId: string) => number;
  disabled?: boolean;
}) {
  const showNotification = useAppStore((s) => s.showNotification);
  /** Nhóm vừa tạo: hiện ngay, không chờ danh sách nạp lại */
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
    if (groupNameTaken(list, name)) { showNotification('Đã có nhóm tên này', 'warning'); return; }
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
        showNotification(res?.error || 'Không tạo được nhóm', 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Không tạo được nhóm', 'error');
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!selected) return;
    const name = draft.trim();
    if (!name || name === selected.name) { cancel(); return; }
    if (groupNameTaken(list, name, selected.group_id)) { showNotification('Đã có nhóm tên này', 'warning'); return; }
    setBusy(true);
    try {
      const res = await ipc.employee?.updateGroup(selected.group_id, { name });
      if (res?.success) {
        setCreated((prev) => prev.map((group) => (group.group_id === selected.group_id ? { ...group, name } : group)));
        cancel();
        onGroupsChanged();
      } else {
        showNotification(res?.error || 'Không đổi được tên nhóm', 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Không đổi được tên nhóm', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    const count = memberCount?.(selected.group_id) ?? 0;
    const ok = await showConfirm({
      title: `Xoá nhóm "${selected.name}"?`,
      message: count ? `${count} nhân viên trong nhóm vẫn giữ nguyên, chỉ không còn nhóm.` : 'Nhóm chưa có ai.',
      confirmText: 'Xoá nhóm',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await ipc.employee?.deleteGroup(selected.group_id);
      if (res?.success) {
        setCreated((prev) => prev.filter((group) => group.group_id !== selected.group_id));
        onGroupsChanged();
      } else {
        showNotification(res?.error || 'Không xoá được nhóm', 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Không xoá được nhóm', 'error');
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
      <div role="radiogroup" aria-label="Nhóm" className="flex flex-wrap items-center gap-1.5">
        {chip('', 'Không có nhóm')}
        {list.map((group) => chip(group.group_id, group.name))}
        {mode === 'create' ? (
          <span className="flex items-center gap-1.5">
            {nameInput(() => { void create(); }, 'Tên nhóm, vd CSKH', 'Tên nhóm mới')}
            <Button size="sm" className="h-7" onClick={() => { void create(); }} disabled={!draft.trim()} loading={busy}>Tạo</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={cancel} disabled={busy}>Huỷ</Button>
          </span>
        ) : (
          <button type="button" onClick={() => { setMode('create'); setDraft(''); }} disabled={locked}
            className="flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-60">
            <PlusIcon className="h-3 w-3" /> Nhóm mới
          </button>
        )}
      </div>

      {manage && selected && mode !== 'create' && (
        mode === 'rename' ? (
          <div className="flex items-center gap-1.5">
            {nameInput(() => { void rename(); }, 'Tên nhóm', 'Tên mới của nhóm')}
            <Button size="sm" className="h-7" onClick={() => { void rename(); }} disabled={!draft.trim()} loading={busy}>Lưu</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={cancel} disabled={busy}>Huỷ</Button>
          </div>
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            <span className="max-w-[14rem] truncate">Nhóm {selected.name}:</span>
            <button type="button" disabled={locked} onClick={() => { setMode('rename'); setDraft(selected.name); }}
              className="font-medium text-primary hover:underline disabled:opacity-60">Đổi tên</button>
            <span aria-hidden="true">·</span>
            <button type="button" disabled={locked} onClick={() => { void remove(); }}
              className="font-medium text-destructive hover:underline disabled:opacity-60">Xoá nhóm</button>
          </p>
        )
      )}
    </div>
  );
}
