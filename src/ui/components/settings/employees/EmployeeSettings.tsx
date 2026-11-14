/**
 * Settings → Employees: a page that reads from top to bottom. Connection (open the door for employees + the address to send them) → employee list
 * (one card per person, edit chat accounts / permissions / group / profile right below the name) → Security. Groups no longer have their own
 * section: pick / quick-create them when adding an employee and in the "Nhóm" (Group) row of each person (rename / delete groups is also there).
 * An employee machine (with the Manage employees permission) only sees the list: connection and sign-out of all belong to the server.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { Button, EmptyState, Input } from '@/components/ui';
import { PlusIcon, SearchIcon, UsersIcon } from '@/components/common/icons';
import {
  employeePresence, groupEmployees, matchEmployee, permissionMap, summarizeModules, type EmployeeGroupRecord,
  type EmployeeRecord,
} from '@/lib/employee/employeeSettingsView';
import { showConfirm } from '../../common/ConfirmDialog';
import { Notice, SettingsPage, SettingsRow, SettingsSection } from '../settingsUi';
import EmployeeCard, { type EmployeeLoginTarget } from './EmployeeCard';
import EmployeeConnectionSection, { useInternetAddress } from './EmployeeConnectionSection';
import EmployeeCreateDialog from './EmployeeCreateDialog';
import { useRelayConnection } from './useRelayConnection';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** From how many employees on the search box is shown. */
const SEARCH_FROM = 6;

export default function EmployeeSettings() {
  const showNotification = useAppStore((s) => s.showNotification);
  const accounts = useAccountStore((s) => s.accounts);
  const { mode, employees, setEmployees, previewEmployeeId, setPreviewEmployeeId, connectedEmployees } = useEmployeeStore(useShallow((s) => ({
    mode: s.mode,
    employees: s.employees as EmployeeRecord[],
    setEmployees: s.setEmployees,
    previewEmployeeId: s.previewEmployeeId,
    setPreviewEmployeeId: s.setPreviewEmployeeId,
    connectedEmployees: s.connectedEmployees,
  })));
  const onEmployeeMachine = mode === 'employee';
  const connection = useRelayConnection(!onEmployeeMachine);
  const internet = useInternetAddress(connection);

  const [groups, setGroups] = useState<EmployeeGroupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const [empRes, grpRes] = await Promise.all([ipc.employee?.list(), ipc.employee?.listGroups()]);
      if (empRes?.success) {
        setEmployees(empRes.employees || []);
        setLoadError('');
      } else {
        setLoadError(empRes?.error || tr('Không đọc được danh sách nhân viên'));
      }
      if (grpRes?.success) setGroups(grpRes.groups || []);
    } catch (err: any) {
      setLoadError(err?.message || tr('Không đọc được danh sách nhân viên'));
    } finally {
      setLoading(false);
    }
  }, [setEmployees]);

  useEffect(() => { void load(); }, [load]);

  // The employee being impersonated was just deleted → exit impersonation
  useEffect(() => {
    if (loading || loadError || !previewEmployeeId) return;
    if (!employees.some((employee) => employee.employee_id === previewEmployeeId)) setPreviewEmployeeId(null);
  }, [employees, loadError, loading, previewEmployeeId, setPreviewEmployeeId]);

  const filtered = useMemo(() => employees.filter((employee) => matchEmployee(employee, query)), [employees, query]);
  const sections = useMemo(() => groupEmployees(filtered, groups), [filtered, groups]);
  const takenUsernames = useMemo(() => new Set(employees.map((employee) => (employee.username || '').toLowerCase())), [employees]);
  const memberCount = useCallback((groupId: string) => employees.filter((employee) => employee.group_id === groupId).length, [employees]);
  const loginTarget: EmployeeLoginTarget = { lanHost: connection.localIPs[0] || null, port: connection.port, internetUrl: internet.url };
  const simEmployee = previewEmployeeId ? employees.find((employee) => employee.employee_id === previewEmployeeId) ?? null : null;
  const now = Date.now();

  const togglePreview = (employee: EmployeeRecord) => {
    if (previewEmployeeId === employee.employee_id) {
      setPreviewEmployeeId(null);
      return;
    }
    setPreviewEmployeeId(employee.employee_id);
    useAppStore.getState().setView('dashboard');
  };

  // Sign out all employees: change the token signing key → everyone has to log in again with their password
  const logoutAll = async () => {
    const ok = await showConfirm({
      title: tr('Đăng xuất tất cả nhân viên?'),
      message: tr('Nhân viên đang online bị ngắt ngay. Mọi máy nhân viên, kể cả đang tắt, phải đăng nhập lại bằng mật khẩu.'),
      confirmText: tr('Đăng xuất tất cả'),
    });
    if (!ok) return;
    setLoggingOutAll(true);
    try {
      const res = await ipc.employee?.logoutAll();
      if (res?.success) {
        showNotification(res.notified
          ? tr('Đã đăng xuất tất cả nhân viên ({{notified}} người đang online bị ngắt)', { notified: res.notified })
          : tr('Đã đăng xuất tất cả nhân viên'), 'success');
        void connection.refresh();
      } else {
        showNotification(res?.error || tr('Không đăng xuất được nhân viên'), 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || tr('Không đăng xuất được nhân viên'), 'error');
    } finally {
      setLoggingOutAll(false);
    }
  };

  const simModules = simEmployee ? summarizeModules(permissionMap(simEmployee.permissions)).count : 0;

  return (
    <SettingsPage
      title={tr('Nhân viên')}
      description={tr('Nhân viên dùng Deplao trên máy riêng, chỉ thấy tài khoản và mục được giao.')}
      actions={(
        <Button size="sm" onClick={() => setCreating(true)} leftIcon={<PlusIcon className="h-4 w-4" />}>
          {tr('Thêm nhân viên')}
        </Button>
      )}
    >
      {simEmployee && (
        <Notice
          tone="warning"
          title={tr('Đang giả lập {{v1}}', { v1: simEmployee.display_name || simEmployee.username })}
          action={<Button size="sm" variant="outline" onClick={() => setPreviewEmployeeId(null)}>{tr('Thoát giả lập')}</Button>}
        >
          {trx('Cả app chỉ hiện {{v1}} tài khoản và {{simModules}} mục người này được dùng.', { v1: simEmployee.assigned_accounts?.length || 0, simModules })}
        </Notice>
      )}

      {!onEmployeeMachine && (
        <EmployeeConnectionSection connection={connection} internet={internet} onlineCount={connectedEmployees.length} />
      )}

      <SettingsSection
        plain
        title={employees.length ? tr('Danh sách nhân viên ({{count}})', { count: employees.length }) : tr('Danh sách nhân viên')}
        description={employees.length ? tr('Bấm một dòng dưới tên để chỉnh ngay tại chỗ.') : undefined}
        action={employees.length >= SEARCH_FROM ? (
          <div className="relative w-56">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('Tìm tên, tên đăng nhập')} aria-label={tr('Tìm nhân viên')}
              className="h-8 pl-8" />
          </div>
        ) : undefined}
      >
        {loading && employees.length === 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-card py-8 text-sm text-muted-foreground">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-border-strong border-t-transparent" aria-hidden="true" />
            {tr('Đang tải…')}
          </div>
        ) : loadError && employees.length === 0 ? (
          <Notice tone="destructive" action={<Button size="sm" variant="outline" onClick={() => { void load(); }}>{tr('Thử lại')}</Button>}>
            {loadError}
          </Notice>
        ) : employees.length === 0 ? (
          <div className="rounded-xl border border-border/60 bg-card">
            <EmptyState
              compact
              icon={<UsersIcon className="h-6 w-6" />}
              title={tr('Chưa có nhân viên')}
              description={tr('Tạo tài khoản cho nhân viên, chọn tài khoản chat và mục họ được dùng.')}
              action={<Button size="sm" onClick={() => setCreating(true)} leftIcon={<PlusIcon className="h-4 w-4" />}>{tr('Thêm nhân viên')}</Button>}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-border/60 bg-card">
            <EmptyState compact icon={<SearchIcon className="h-6 w-6" />} title={tr('Không thấy "{{v1}}"', { v1: query.trim() })}
              action={<Button size="sm" variant="outline" onClick={() => setQuery('')}>{tr('Xoá tìm kiếm')}</Button>} />
          </div>
        ) : (
          sections.map(({ group, employees: members }) => (
            <div key={group?.group_id ?? '_none'} className="space-y-2">
              {groups.length > 0 && (
                <p className="px-1 pt-1 text-xs font-medium text-muted-foreground">
                  {group ? group.name : tr('Chưa có nhóm')} · {members.length}
                </p>
              )}
              {members.map((employee) => (
                <EmployeeCard
                  key={employee.employee_id}
                  employee={employee}
                  accounts={accounts}
                  groups={groups}
                  presence={employeePresence(employee, connectedEmployees, now)}
                  previewing={previewEmployeeId === employee.employee_id}
                  loginTarget={loginTarget}
                  memberCount={memberCount}
                  onChanged={() => { void load(); }}
                  onTogglePreview={() => togglePreview(employee)}
                />
              ))}
            </div>
          ))
        )}
      </SettingsSection>

      {!onEmployeeMachine && employees.length > 0 && (
        <SettingsSection title={tr('Bảo mật')}>
          <SettingsRow
            title={tr('Đăng xuất tất cả nhân viên')}
            description={tr('Khi nghi lộ mật khẩu. Mọi máy nhân viên phải đăng nhập lại.')}
            control={(
              <Button variant="outline" size="sm" loading={loggingOutAll} onClick={logoutAll}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive">
                {tr('Đăng xuất tất cả')}
              </Button>
            )}
          />
        </SettingsSection>
      )}

      {creating && (
        <EmployeeCreateDialog
          open
          onOpenChange={setCreating}
          accounts={accounts}
          groups={groups}
          takenUsernames={takenUsernames}
          loginTarget={loginTarget}
          connectionOn={onEmployeeMachine || connection.running}
          onStartConnection={() => connection.start(connection.port)}
          onCreated={() => { void load(); }}
          onGroupsChanged={() => { void load(); }}
        />
      )}
    </SettingsPage>
  );
}
