/**
 * The "Thêm nhân viên" (Add employee) box: display name → login name suggested automatically, password pre-generated, group (pick or quick-create), chat accounts
 * + usage permissions. After creating, the message to send to the employee (server address, login name, password) is shown ready to copy.
 */
import React, { useId, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import type { AccountInfo } from '@/store/accounts/accountStore';
import {
  Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input,
} from '@/components/ui';
import { CheckCircleIcon } from '@/components/common/icons';
import {
  DEFAULT_NEW_EMPLOYEE_MODULES, EMPLOYEE_MODULES, employeeLoginText, generatePassword, passwordError, permissionRows,
  suggestUsername, usernameError, type EmployeeGroupRecord,
} from '@/lib/employee/employeeSettingsView';
import { Notice } from '../settingsUi';
import { AccountChecklist, PermissionChecklist } from './EmployeePickers';
import EmployeeGroupPicker from './EmployeeGroupPicker';
import { copyWithToast } from './RelayAddressNotice';
import type { EmployeeLoginTarget } from './EmployeeCard';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

interface CreateProps {
  accounts: readonly AccountInfo[];
  groups: readonly EmployeeGroupRecord[];
  /** Login name already taken (case-insensitive). */
  takenUsernames: ReadonlySet<string>;
  loginTarget: EmployeeLoginTarget;
  /** Employee connection is on; if off, prompt to turn it on right in the last step. */
  connectionOn: boolean;
  onStartConnection: () => Promise<boolean>;
  onCreated: () => void;
  /** Just created a new group in the box: reload the group list */
  onGroupsChanged: () => void;
  onClose: () => void;
}

function defaultModules(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const module of EMPLOYEE_MODULES) map[module.key] = DEFAULT_NEW_EMPLOYEE_MODULES.includes(module.key);
  return map;
}

function CreateEmployeeContent({
  accounts, groups, takenUsernames, loginTarget, connectionOn, onStartConnection, onCreated, onGroupsChanged, onClose,
}: CreateProps) {
  const showNotification = useAppStore((s) => s.showNotification);
  const id = useId();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [password, setPassword] = useState(() => generatePassword(8));
  const [groupId, setGroupId] = useState('');
  const [assigned, setAssigned] = useState<Set<string>>(() => new Set(accounts.length === 1 ? [accounts[0].zalo_id] : []));
  const [modules, setModules] = useState<Record<string, boolean>>(defaultModules);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const [created, setCreated] = useState<{ name: string; text: string } | null>(null);
  const [starting, setStarting] = useState(false);

  const name = displayName.trim();
  const user = username.trim();
  const nameError = name ? '' : tr('Nhập tên hiển thị');
  const userError = usernameError(user) || (takenUsernames.has(user) ? tr('Tên này đã có người dùng') : '');
  const pwError = passwordError(password);
  const showUserError = submitted || (usernameEdited && !!user);

  const changeName = (value: string) => {
    setDisplayName(value);
    if (!usernameEdited) setUsername(suggestUsername(value));
  };

  const create = async () => {
    setSubmitted(true);
    setServerError('');
    if (nameError || userError || pwError) return;
    setSaving(true);
    try {
      const res = await ipc.employee?.create({ username: user, password, display_name: name, role: 'employee' });
      const employeeId: string | undefined = res?.employee?.employee_id;
      if (!res?.success || !employeeId) {
        setServerError(res?.error || tr('Không tạo được nhân viên'));
        return;
      }
      const followUps = await Promise.allSettled([
        ipc.employee?.setPermissions(employeeId, permissionRows(modules)),
        ipc.employee?.assignAccounts(employeeId, Array.from(assigned)),
        groupId ? ipc.employee?.update(employeeId, { group_id: groupId }) : Promise.resolve({ success: true }),
      ]);
      const failed = followUps.some((item) => item.status === 'rejected' || !(item.value as { success?: boolean } | undefined)?.success);
      if (failed) showNotification(tr('Đã tạo nhân viên nhưng chưa lưu đủ quyền / tài khoản, hãy kiểm tra lại ở thẻ nhân viên'), 'warning');
      onCreated();
      setCreated({ name, text: employeeLoginText({ displayName: name, username: user, password, ...loginTarget }) });
    } catch (err: any) {
      setServerError(err?.message || tr('Không tạo được nhân viên'));
    } finally {
      setSaving(false);
    }
  };

  const startConnection = async () => {
    setStarting(true);
    try { await onStartConnection(); } finally { setStarting(false); }
  };

  if (created) {
    return (
      <>
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-2">
            <CheckCircleIcon className="h-5 w-5 flex-shrink-0 text-success" />
            <DialogTitle>{trx('Đã tạo tài khoản cho {{name}}', { name: created.name })}</DialogTitle>
          </div>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground">{tr('Gửi tin này cho nhân viên (Zalo, tin nhắn…):')}</p>
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2.5 font-sans text-sm leading-relaxed text-foreground">{created.text}</pre>
          {!connectionOn && (
            <Notice tone="warning" action={<Button size="sm" variant="outline" loading={starting} onClick={startConnection}>{tr('Bật kết nối')}</Button>}>
              {tr('Kết nối cho nhân viên đang tắt, nhân viên chưa vào được.')}
            </Notice>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => copyWithToast(created.text, tr('Đã sao chép thông tin đăng nhập'))}>{tr('Sao chép')}</Button>
          <Button onClick={onClose}>{tr('Xong')}</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{tr('Thêm nhân viên')}</DialogTitle>
          <DialogDescription>{tr('Nhân viên đăng nhập Deplao trên máy riêng bằng tài khoản này.')}</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label={tr('Tên hiển thị')} htmlFor={`${id}-name`} required error={submitted && nameError ? nameError : undefined}>
          <Input id={`${id}-name`} value={displayName} onChange={(e) => changeName(e.target.value)} placeholder={tr('Nguyễn Văn An')}
            invalid={submitted && !!nameError} disabled={saving} autoFocus />
        </FormField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label={tr('Tên đăng nhập')} htmlFor={`${id}-user`} required error={showUserError && userError ? userError : undefined}>
            <Input id={`${id}-user`} value={username} placeholder={tr('nguyenvanan')} spellCheck={false} autoComplete="off"
              onChange={(e) => { setUsername(e.target.value.toLowerCase().replace(/\s+/g, '')); setUsernameEdited(true); }}
              invalid={showUserError && !!userError} disabled={saving} className="font-mono" />
          </FormField>
          <FormField label={tr('Mật khẩu')} htmlFor={`${id}-pw`} required error={submitted && pwError ? pwError : undefined}>
            <div className="flex gap-2">
              <Input id={`${id}-pw`} value={password} onChange={(e) => setPassword(e.target.value)} spellCheck={false}
                autoComplete="new-password" invalid={submitted && !!pwError} disabled={saving} className="font-mono" />
              <Button variant="outline" size="sm" className="h-9 flex-shrink-0" onClick={() => setPassword(generatePassword(8))} disabled={saving}>
                {tr('Tạo mới')}
              </Button>
            </div>
          </FormField>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{trx('Nhóm <0>(không bắt buộc)</0>', { 0: <span className="font-normal text-muted-foreground" /> })}</p>
          <EmployeeGroupPicker groups={groups} value={groupId} onChange={setGroupId} onGroupsChanged={onGroupsChanged} disabled={saving} />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{tr('Tài khoản chat')}</p>
          <p className="text-xs text-muted-foreground">{tr('Nhân viên chỉ thấy tin nhắn, khách hàng của các tài khoản được chọn.')}</p>
          <div className="rounded-lg border border-border/60 p-3">
            <AccountChecklist accounts={accounts} value={assigned} onChange={setAssigned} disabled={saving} />
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{tr('Quyền dùng')}</p>
          <div className="rounded-lg border border-border/60 p-3">
            <PermissionChecklist value={modules} onChange={setModules} disabled={saving} />
          </div>
        </div>
        {serverError && <p className="text-sm text-destructive" role="alert">{serverError}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={saving}>{tr('Huỷ')}</Button>
        <Button onClick={create} loading={saving}>{tr('Tạo nhân viên')}</Button>
      </DialogFooter>
    </>
  );
}

export default function EmployeeCreateDialog({ open, ...props }: Omit<CreateProps, 'onClose'> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { onOpenChange, ...rest } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" closeOnOverlay={false}>
      <CreateEmployeeContent {...rest} onClose={() => onOpenChange(false)} />
    </Dialog>
  );
}
