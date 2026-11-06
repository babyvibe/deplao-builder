/**
 * Một nhân viên trên Cài đặt → Nhân viên: tên, trạng thái online, rồi bốn dòng chỉnh ngay tại chỗ (tài khoản chat kèm ảnh
 * tài khoản, quyền dùng, nhóm, hồ sơ & mật khẩu). Việc ít dùng (giả lập, đăng xuất, khoá, xoá) nằm trong menu ⋯.
 */
import React, { useEffect, useId, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { useAppStore } from '@/store/app/appStore';
import type { AccountInfo } from '@/store/accounts/accountStore';
import { showConfirm } from '../../common/ConfirmDialog';
import {
  Badge, Button, DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, FormField, Input, Select,
} from '@/components/ui';
import {
  EyeIcon, FolderIcon, ImageIcon, KeyIcon, LockIcon, MoreHorizontalIcon, RefreshIcon, SmartphoneIcon, TrashIcon, UserIcon,
} from '@/components/common/icons';
import {
  EMPLOYEE_MODULES, employeeLoginText, generatePassword, permissionMap, permissionRows, summarizeAccounts,
  summarizeGroup, summarizeModules, type EmployeeGroupRecord, type EmployeeRecord,
} from '@/lib/employee/employeeSettingsView';
import { MiniAccountAvatar } from '../notifications/InAppNotifySettings';
import { SettingLine } from '../settingsUi';
import EmployeeGroupPicker from './EmployeeGroupPicker';
import { AccountChecklist, PermissionChecklist } from './EmployeePickers';
import { copyWithToast } from './RelayAddressNotice';

/** Địa chỉ máy chủ ghi trong tin gửi nhân viên (đăng nhập / đổi mật khẩu). */
export interface EmployeeLoginTarget {
  lanHost: string | null;
  port: number;
  internetUrl: string | null;
}

type LineId = 'accounts' | 'modules' | 'group' | 'profile';

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function EmployeeAvatar({ name, url, size = 40, className }: { name: string; url?: string | null; size?: 40 | 48; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = size === 48 ? 'h-12 w-12 text-base' : 'h-10 w-10 text-sm';
  return url && !failed ? (
    <img src={toLocalMediaUrl(url)} alt="" onError={() => setFailed(true)}
      className={cn(box, 'flex-shrink-0 rounded-full object-cover', className)} />
  ) : (
    <span className={cn(box, 'flex flex-shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-foreground', className)}>
      {(name.trim()[0] || '?').toUpperCase()}
    </span>
  );
}

function EditorActions({ dirty, saving, onCancel, onSave, saveLabel = 'Lưu' }: {
  dirty: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  saveLabel?: string;
}) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Huỷ</Button>
      <Button size="sm" onClick={onSave} disabled={!dirty} loading={saving}>{saveLabel}</Button>
    </div>
  );
}

interface EditorProps {
  employee: EmployeeRecord;
  onSaved: () => void;
  onClose: () => void;
}

function AccountsEditor({ employee, accounts, onSaved, onClose }: EditorProps & { accounts: readonly AccountInfo[] }) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(employee.assigned_accounts || []));
  const [saving, setSaving] = useState(false);
  const dirty = !sameSet(draft, new Set(employee.assigned_accounts || []));

  const save = async () => {
    setSaving(true);
    try {
      const res = await ipc.employee?.assignAccounts(employee.employee_id, Array.from(draft));
      if (res?.success) {
        showNotification('Đã lưu tài khoản được giao', 'success');
        onSaved();
        onClose();
      } else {
        showNotification(res?.error || 'Không lưu được tài khoản được giao', 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Không lưu được tài khoản được giao', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Nhân viên chỉ thấy tin nhắn, khách hàng của các tài khoản được chọn.</p>
      <AccountChecklist accounts={accounts} value={draft} onChange={setDraft} disabled={saving} />
      <EditorActions dirty={dirty} saving={saving} onCancel={onClose} onSave={save} />
    </div>
  );
}

function ModulesEditor({ employee, onSaved, onClose }: EditorProps) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [initial] = useState(() => permissionMap(employee.permissions));
  const [draft, setDraft] = useState<Record<string, boolean>>(initial);
  const [saving, setSaving] = useState(false);
  const dirty = EMPLOYEE_MODULES.some((module) => !!draft[module.key] !== !!initial[module.key]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await ipc.employee?.setPermissions(employee.employee_id, permissionRows(draft, employee.permissions));
      if (res?.success) {
        showNotification('Đã lưu quyền dùng', 'success');
        onSaved();
        onClose();
      } else {
        showNotification(res?.error || 'Không lưu được quyền dùng', 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Không lưu được quyền dùng', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <PermissionChecklist value={draft} onChange={setDraft} disabled={saving} />
      <EditorActions dirty={dirty} saving={saving} onCancel={onClose} onSave={save} />
    </div>
  );
}

/** Dòng "Nhóm": bấm nhóm là chuyển ngay, "Không có nhóm" để gỡ, tạo nhóm mới / đổi tên / xoá nhóm ngay tại đây. */
function GroupEditor({ employee, groups, memberCount, onSaved }: {
  employee: EmployeeRecord;
  groups: readonly EmployeeGroupRecord[];
  memberCount: (groupId: string) => number;
  onSaved: () => void;
}) {
  const showNotification = useAppStore((s) => s.showNotification);
  const saved = employee.group_id || '';
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(saved); }, [saved]);

  const change = async (groupId: string) => {
    if (groupId === saved) { setValue(groupId); return; }
    setValue(groupId);
    setSaving(true);
    try {
      const res = await ipc.employee?.update(employee.employee_id, { group_id: groupId || null });
      if (res?.success) {
        showNotification(groupId ? 'Đã đổi nhóm' : 'Đã bỏ khỏi nhóm', 'success');
        onSaved();
      } else {
        setValue(saved);
        showNotification(res?.error || 'Không đổi được nhóm', 'error');
      }
    } catch (err: any) {
      setValue(saved);
      showNotification(err?.message || 'Không đổi được nhóm', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <EmployeeGroupPicker groups={groups} value={value} onChange={(groupId) => { void change(groupId); }}
        onGroupsChanged={onSaved} manage memberCount={memberCount} disabled={saving} />
      <p className="text-[11px] text-muted-foreground">Nhóm chỉ để chia danh sách (vd CSKH, Kho), không đổi quyền.</p>
    </div>
  );
}

function ProfileEditor({ employee, loginTarget, onSaved, onClose }: EditorProps & {
  loginTarget: EmployeeLoginTarget;
}) {
  const showNotification = useAppStore((s) => s.showNotification);
  const id = useId();
  const [displayName, setDisplayName] = useState(employee.display_name || '');
  const [avatarUrl, setAvatarUrl] = useState(employee.avatar_url || '');
  const [role, setRole] = useState(employee.role === 'boss' ? 'boss' : 'employee');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  /** Vừa đổi mật khẩu: nội dung gửi lại cho nhân viên. */
  const [sentText, setSentText] = useState<string | null>(null);

  const name = displayName.trim();
  const nameError = name ? '' : 'Nhập tên hiển thị';
  const pwError = password && password.length < 4 ? 'Ít nhất 4 ký tự' : '';
  const dirty = name !== (employee.display_name || '')
    || avatarUrl !== (employee.avatar_url || '')
    || role !== (employee.role === 'boss' ? 'boss' : 'employee')
    || !!password;

  const pickAvatar = async () => {
    try {
      const result = await ipc.file?.openDialog({
        title: 'Chọn ảnh đại diện',
        filters: [{ name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
        properties: ['openFile'],
      });
      if (!result || result.canceled || !result.filePaths?.length) return;
      setAvatarUrl(toLocalMediaUrl(result.filePaths[0]));
    } catch (err: any) {
      showNotification(`Không chọn được ảnh: ${err?.message || ''}`, 'error');
    }
  };

  const save = async () => {
    if (nameError || pwError) return;
    setSaving(true);
    try {
      const updates: Record<string, unknown> = { display_name: name, avatar_url: avatarUrl, role };
      if (password) updates.password = password;
      const res = await ipc.employee?.update(employee.employee_id, updates);
      if (!res?.success) {
        showNotification(res?.error || 'Không lưu được hồ sơ', 'error');
        return;
      }
      onSaved();
      if (password) {
        showNotification('Đã đổi mật khẩu, nhân viên cần đăng nhập lại', 'success');
        setSentText(employeeLoginText({ displayName: name, username: employee.username, password, ...loginTarget }));
        setPassword('');
      } else {
        showNotification('Đã lưu hồ sơ', 'success');
        onClose();
      }
    } catch (err: any) {
      showNotification(err?.message || 'Không lưu được hồ sơ', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (sentText) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Gửi cho nhân viên thông tin đăng nhập mới:</p>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 font-sans text-xs leading-relaxed text-foreground">{sentText}</pre>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => copyWithToast(sentText, 'Đã sao chép thông tin đăng nhập')}>Sao chép</Button>
          <Button size="sm" onClick={onClose}>Xong</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <EmployeeAvatar name={name || employee.username} url={avatarUrl} size={48} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" leftIcon={<ImageIcon className="h-4 w-4" />} onClick={pickAvatar} disabled={saving}>Chọn ảnh</Button>
          {avatarUrl && <Button variant="ghost" size="sm" onClick={() => setAvatarUrl('')} disabled={saving}>Bỏ ảnh</Button>}
        </div>
      </div>
      <FormField label="Tên hiển thị" htmlFor={`${id}-name`} error={nameError || undefined}>
        <Input id={`${id}-name`} value={displayName} onChange={(e) => setDisplayName(e.target.value)} invalid={!!nameError} disabled={saving} />
      </FormField>
      <FormField label="Vai trò" htmlFor={`${id}-role`} hint={role === 'boss' ? 'Toàn quyền ở mục Công việc.' : undefined}>
        <Select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value === 'boss' ? 'boss' : 'employee')} disabled={saving}
          wrapperClassName="sm:max-w-[50%]">
          <option value="employee">Nhân viên</option>
          <option value="boss">Boss</option>
        </Select>
      </FormField>
      <FormField
        label="Mật khẩu mới"
        htmlFor={`${id}-pw`}
        error={pwError || undefined}
        hint={`Bỏ trống nếu không đổi. Tên đăng nhập: ${employee.username}`}
      >
        <div className="flex gap-2">
          <Input id={`${id}-pw`} value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!pwError}
            autoComplete="new-password" spellCheck={false} disabled={saving} className="font-mono" />
          <Button variant="outline" size="sm" className="h-9 flex-shrink-0" onClick={() => setPassword(generatePassword(8))} disabled={saving}>
            Tạo ngẫu nhiên
          </Button>
        </div>
      </FormField>
      <EditorActions dirty={dirty && !nameError && !pwError} saving={saving} onCancel={onClose} onSave={save} />
    </div>
  );
}

export interface EmployeeCardProps {
  employee: EmployeeRecord;
  accounts: readonly AccountInfo[];
  groups: readonly EmployeeGroupRecord[];
  presence: { online: boolean; text: string };
  previewing: boolean;
  loginTarget: EmployeeLoginTarget;
  /** Số nhân viên trong một nhóm (hỏi trước khi xoá nhóm). */
  memberCount: (groupId: string) => number;
  /** Đọc lại danh sách nhân viên sau khi sửa. */
  onChanged: () => void;
  /** Bật / tắt giả lập nhân viên này. */
  onTogglePreview: () => void;
}

export default function EmployeeCard({
  employee, accounts, groups, presence, previewing, loginTarget, memberCount, onChanged, onTogglePreview,
}: EmployeeCardProps) {
  const showNotification = useAppStore((s) => s.showNotification);
  const baseId = useId();
  const [open, setOpen] = useState<ReadonlySet<LineId>>(() => new Set());
  const name = employee.display_name || employee.username;
  const active = !!employee.is_active;

  const toggle = (line: LineId) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(line)) next.delete(line); else next.add(line);
    return next;
  });
  const close = (line: LineId) => setOpen((prev) => {
    const next = new Set(prev);
    next.delete(line);
    return next;
  });

  const accountSummary = summarizeAccounts(employee.assigned_accounts, accounts);
  const moduleSummary = summarizeModules(permissionMap(employee.permissions));
  const groupSummary = summarizeGroup(employee, groups);
  // Ảnh các tài khoản được giao (tối đa 3) trước tên trong dòng "Tài khoản chat"
  const assignedAccounts = useMemo(() => {
    const byId = new Map(accounts.map((account) => [account.zalo_id, account]));
    return (employee.assigned_accounts || []).map((accountId) => byId.get(accountId)).filter((account): account is AccountInfo => !!account);
  }, [accounts, employee.assigned_accounts]);
  const accountSummaryView = assignedAccounts.length > 0 ? (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <span className="flex flex-shrink-0 -space-x-1.5">
        {assignedAccounts.slice(0, 3).map((account) => (
          <MiniAccountAvatar key={account.zalo_id} account={account} size={20} className="ring-2 ring-card" />
        ))}
      </span>
      <span className="truncate">{accountSummary.text}</span>
    </span>
  ) : accountSummary.text;

  const logout = async () => {
    const ok = await showConfirm({
      title: `Đăng xuất ${name}?`,
      message: 'Máy nhân viên bị ngắt ngay, phải đăng nhập lại bằng mật khẩu.',
      confirmText: 'Đăng xuất',
      variant: 'warning',
    });
    if (!ok) return;
    try {
      const res = await ipc.relay?.kickEmployee(employee.employee_id);
      if (res?.success) showNotification(`Đã đăng xuất ${name}`, 'success');
      else showNotification(res?.error || 'Không đăng xuất được', 'error');
    } catch (err: any) {
      showNotification(err?.message || 'Không đăng xuất được', 'error');
    }
  };

  const toggleActive = async () => {
    if (active) {
      const ok = await showConfirm({
        title: `Khoá ${name}?`,
        message: 'Nhân viên bị đăng xuất và không vào được cho tới khi mở khoá. Dữ liệu vẫn giữ.',
        confirmText: 'Khoá',
        variant: 'danger',
      });
      if (!ok) return;
    }
    try {
      const res = await ipc.employee?.update(employee.employee_id, { is_active: active ? 0 : 1 });
      if (res?.success) {
        showNotification(active ? `Đã khoá ${name}` : `Đã mở khoá ${name}`, 'success');
        onChanged();
      } else {
        showNotification(res?.error || 'Không đổi được trạng thái', 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Không đổi được trạng thái', 'error');
    }
  };

  const remove = async () => {
    const ok = await showConfirm({
      title: `Xoá ${name}?`,
      message: 'Xoá tài khoản, quyền và nhật ký của nhân viên này. Không hoàn tác được.',
      confirmText: 'Xoá',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      const res = await ipc.employee?.delete(employee.employee_id);
      if (res?.success) {
        showNotification(`Đã xoá ${name}`, 'success');
        onChanged();
      } else {
        showNotification(res?.error || 'Không xoá được nhân viên', 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Không xoá được nhân viên', 'error');
    }
  };

  return (
    <div className={cn('rounded-xl border bg-card', previewing ? 'border-warning/60' : 'border-border/60')}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <EmployeeAvatar name={name} url={employee.avatar_url} className={cn(!active && 'opacity-50')} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className={cn('truncate text-sm font-medium', active ? 'text-foreground' : 'text-muted-foreground')}>{name}</p>
            {employee.role === 'boss' && <Badge size="sm" variant="warning">Boss</Badge>}
            {!active && <Badge size="sm" variant="destructive">Đã khoá</Badge>}
            {previewing && <Badge size="sm" variant="warning">Đang giả lập</Badge>}
          </div>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="flex-shrink-0">@{employee.username}</span>
            <span aria-hidden="true">·</span>
            {presence.online ? (
              <span className="flex min-w-0 items-center gap-1 text-success">
                <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success" aria-hidden="true" />
                <span className="truncate">{presence.text}</span>
              </span>
            ) : (
              <span className="truncate">{presence.text}</span>
            )}
          </p>
        </div>
        <DropdownMenu
          align="end"
          trigger={(
            <Button variant="ghost" size="icon" aria-label={`Thao tác khác với ${name}`} title="Thao tác khác"
              className="h-8 w-8 flex-shrink-0 text-muted-foreground">
              <MoreHorizontalIcon className="h-4 w-4" />
            </Button>
          )}
        >
          <DropdownMenuItem icon={<EyeIcon />} onSelect={onTogglePreview}>
            {previewing ? 'Thoát giả lập' : 'Giả lập nhân viên này'}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<RefreshIcon />} onSelect={() => { void logout(); }}>Đăng xuất khỏi máy nhân viên</DropdownMenuItem>
          <DropdownMenuItem icon={<LockIcon />} onSelect={() => { void toggleActive(); }}>{active ? 'Khoá tài khoản' : 'Mở khoá'}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<TrashIcon />} destructive onSelect={() => { void remove(); }}>Xoá nhân viên</DropdownMenuItem>
        </DropdownMenu>
      </div>

      <div className="border-t border-border/60 px-1.5 py-1">
        <SettingLine panelId={`${baseId}-accounts`} icon={<SmartphoneIcon className="h-4 w-4" />} title="Tài khoản chat"
          summary={accountSummaryView} summaryTone={accountSummary.count === 0 ? 'warning' : undefined}
          open={open.has('accounts')} onToggle={() => toggle('accounts')}>
          <AccountsEditor employee={employee} accounts={accounts} onSaved={onChanged} onClose={() => close('accounts')} />
        </SettingLine>
        <SettingLine panelId={`${baseId}-modules`} icon={<KeyIcon className="h-4 w-4" />} title="Quyền dùng"
          summary={moduleSummary.text} summaryTone={moduleSummary.count === 0 ? 'warning' : undefined}
          open={open.has('modules')} onToggle={() => toggle('modules')}>
          <ModulesEditor employee={employee} onSaved={onChanged} onClose={() => close('modules')} />
        </SettingLine>
        <SettingLine panelId={`${baseId}-group`} icon={<FolderIcon className="h-4 w-4" />} title="Nhóm"
          summary={groupSummary.text} open={open.has('group')} onToggle={() => toggle('group')}>
          <GroupEditor employee={employee} groups={groups} memberCount={memberCount} onSaved={onChanged} />
        </SettingLine>
        <SettingLine panelId={`${baseId}-profile`} icon={<UserIcon className="h-4 w-4" />} title="Hồ sơ & mật khẩu"
          summary="Tên, ảnh, mật khẩu" open={open.has('profile')} onToggle={() => toggle('profile')}>
          <ProfileEditor employee={employee} loginTarget={loginTarget} onSaved={onChanged} onClose={() => close('profile')} />
        </SettingLine>
      </div>
    </div>
  );
}
