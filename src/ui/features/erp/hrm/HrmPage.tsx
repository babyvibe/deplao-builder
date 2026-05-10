import React, { useEffect, useMemo, useState } from 'react';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useErpPermissions, useCurrentEmployeeId } from '@/hooks/erp/useErpContext';
import { useEmployeeStore } from '@/store/employeeStore';
import { useAppStore } from '@/store/appStore';
import ipc from '@/lib/ipc';
import { ConfirmDialog, ErpModalCard, ErpOverlay } from '../shared/ErpDialogs';
import {
  ERP_DATE_FILTER_OPTIONS,
  getDefaultCustomRange,
  resolveErpDateRange,
  toDateInputValue,
  type ErpDateFilterPreset,
} from '../shared/erpDateFilters';
import {
  ERP_PERMISSION_GROUPS,
  ERP_PERMISSION_META,
  ERP_PERMISSIONS,
  parseErpPermissionOverridesFromExtraJson,
  stringifyErpPermissionOverridesToExtraJson,
  type ErpPermissionAction,
  type ErpPermissionOverrideMode,
  type ErpPermissionOverrides,
} from '../../../../models/erp/Permission';

const EMPLOYEE_MODULES = [
  { key: 'chat', label: 'Chat', icon: '💬', desc: 'Gửi / nhận tin nhắn' },
  { key: 'crm', label: 'CRM', icon: '📊', desc: 'Quản lý khách hàng' },
  { key: 'workflow', label: 'Workflow', icon: '⚡', desc: 'Tự động hoá' },
  { key: 'integration', label: 'Tích hợp', icon: '🔗', desc: 'POS / Shipping / dịch vụ ngoài' },
  { key: 'analytics', label: 'Thống kê', icon: '📈', desc: 'Báo cáo phân tích' },
  { key: 'ai_assistant', label: 'AI', icon: '🤖', desc: 'Trợ lý AI' },
  { key: 'settings_accounts', label: 'QL tài khoản Zalo', icon: '👤', desc: 'Phần cài đặt tài khoản' },
  { key: 'settings_employees', label: 'QL nhân viên', icon: '🧑‍💼', desc: 'Phần cài đặt nhân viên' },
] as const;

const EMPLOYEE_MODULE_KEYS = new Set<string>(EMPLOYEE_MODULES.map(module => module.key));

const ERP_ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'owner', label: 'Owner' },
  { value: 'guest', label: 'Guest' },
] as const;

const ROLE_TREE_ORDER = ['owner', 'admin', 'manager', 'member', 'guest', 'unassigned'] as const;

function getRoleBadgeClass(role?: string | null) {
  return role === 'owner' ? 'bg-red-600/20 text-red-400'
    : role === 'manager' ? 'bg-orange-600/20 text-orange-400'
    : role === 'admin' ? 'bg-violet-600/20 text-violet-300'
    : role === 'member' ? 'bg-blue-600/20 text-blue-300'
    : role === 'guest' ? 'bg-gray-600/30 text-gray-300'
    : 'bg-gray-600/20 text-gray-400';
}

function getRoleLabel(role?: string | null) {
  return role === 'owner' ? 'Owner'
    : role === 'admin' ? 'Admin'
    : role === 'manager' ? 'Manager'
    : role === 'member' ? 'Member'
    : role === 'guest' ? 'Guest'
    : 'Chưa gán role';
}

function buildEmployeeModulePermissionMap(employee: any | null | undefined) {
  const result: Record<string, boolean> = {};
  EMPLOYEE_MODULES.forEach(module => { result[module.key] = false; });
  for (const permission of employee?.permissions || []) result[permission.module] = !!permission.can_access;
  return result;
}

function countEnabledVisibleModules(employee: any | null | undefined) {
  return (employee?.permissions || []).filter((permission: any) => permission.can_access && EMPLOYEE_MODULE_KEYS.has(permission.module)).length;
}

function buildEmployeeMetaMap(employees: any[], profiles: any[], departments: any[], positions: any[]) {
  const ids = new Set<string>();
  employees.forEach(employee => ids.add(employee.employee_id));
  profiles.forEach(profile => ids.add(profile.employee_id));

  const next = new Map<string, {
    employeeId: string;
    name: string;
    username: string;
    departmentId: number | null;
    departmentName: string;
    positionId: number | null;
    positionName: string;
    role: string;
  }>();

  for (const employeeId of ids) {
    const employee = employees.find(item => item.employee_id === employeeId) ?? null;
    const profile = profiles.find(item => item.employee_id === employeeId) ?? null;
    const departmentId = profile?.department_id ?? null;
    const positionId = profile?.position_id ?? null;
    next.set(employeeId, {
      employeeId,
      name: employee?.display_name || (employeeId === 'boss' ? 'Boss' : employeeId),
      username: employee?.username || '',
      departmentId,
      departmentName: departmentId ? (departments.find((item: any) => item.id === departmentId)?.name || '—') : 'Chưa gán phòng ban',
      positionId,
      positionName: positionId ? (positions.find((item: any) => item.id === positionId)?.name || '—') : 'Chưa gán chức vụ',
      role: getResolvedProfileRole(employee, profile),
    });
  }

  return next;
}

function matchEmployeeMeta(
  meta: {
    departmentId: number | null;
    positionId: number | null;
    role: string;
  } | undefined,
  filters: {
    departmentId: string;
    positionId: string;
    role: string;
  },
) {
  if (filters.departmentId && String(meta?.departmentId ?? '') !== filters.departmentId) return false;
  if (filters.positionId && String(meta?.positionId ?? '') !== filters.positionId) return false;
  return !filters.role || (meta?.role ?? 'unassigned') === filters.role;
}

function formatDateCell(ts?: number | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('vi-VN');
}

function buildActionPermissionState(profile: any | null | undefined): Record<ErpPermissionAction, 'inherit' | ErpPermissionOverrideMode> {
  const overrides = parseErpPermissionOverridesFromExtraJson(profile?.extra_json);
  const next = {} as Record<ErpPermissionAction, 'inherit' | ErpPermissionOverrideMode>;
  for (const action of Object.keys(ERP_PERMISSIONS) as ErpPermissionAction[]) {
    next[action] = overrides[action] ?? 'inherit';
  }
  return next;
}

function getResolvedProfileRole(employee: any, profile: any) {
  if (profile?.erp_role) return profile.erp_role;
  if (employee?.role === 'boss') return 'owner';
  if (profile) return 'member';
  return 'unassigned';
}

/**
 * HRM page — tabs: Departments · Employees · Attendance · Leave
 */
export default function HrmPage() {
  const [tab, setTab] = useState<'departments' | 'positions' | 'employees' | 'attendance' | 'leave'>('employees');

  const tabs = [
    { id: 'employees',   label: 'Nhân sự' },
    { id: 'departments', label: 'Phòng ban' },
    { id: 'positions',   label: 'Chức vụ' },
    { id: 'attendance',  label: 'Chấm công' },
    { id: 'leave',       label: 'Nghỉ phép' },
  ] as const;

  return (
    <div className="h-full flex flex-col bg-gray-900">
      <div className="flex gap-1 px-4 py-2 border-b border-gray-700/60">
        {tabs.map(t => (
          <button key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              tab === t.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-700/60 hover:text-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'employees'   && <EmployeesTab />}
        {tab === 'departments' && <DepartmentsTab />}
        {tab === 'positions'   && <PositionsTab />}
        {tab === 'attendance'  && <AttendanceTab />}
        {tab === 'leave'       && <LeaveTab />}
      </div>
    </div>
  );
}

// ── Employees tab ────────────────────────────────────────────────────────────
function EmployeesTab() {
  const perms = useErpPermissions();
  const currentEmployeeId = useCurrentEmployeeId();
  const { showNotification } = useAppStore();
  const { profiles, departments, positions, loadProfiles, loadDepartments, loadPositions, upsertProfile } = useErpEmployeeStore();
  const { employees, loadEmployees } = useEmployeeStore();
  const [editorState, setEditorState] = useState<{ employee?: any | null; profile?: any | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [roleTreeOpen, setRoleTreeOpen] = useState(false);

  useEffect(() => { loadProfiles(); loadDepartments(); loadPositions(); loadEmployees(); }, []);

  const canManageEmployees = perms.can('employee.edit_others');
  const canManageDepartments = perms.can('department.manage');

  const getEmpName = (id: string) =>
    id === 'boss'
      ? 'Boss'
      : employees.find((e: any) => e.employee_id === id)?.display_name || id || '—';

  const getDeptName = (id: number | null | undefined) =>
    id ? (departments.find(d => d.id === id)?.name || '—') : '—';

  const rows = useMemo(() => {
    const byId = new Map<string, any>();
    for (const employee of employees) {
      byId.set(employee.employee_id, {
        employee,
        profile: profiles.find(p => p.employee_id === employee.employee_id) ?? null,
      });
    }
    for (const profile of profiles) {
      if (!byId.has(profile.employee_id)) {
        byId.set(profile.employee_id, { employee: null, profile });
      }
    }
    return Array.from(byId.values()).sort((a, b) => {
      const aName = (a.employee?.display_name || a.profile?.employee_id || '').toLowerCase();
      const bName = (b.employee?.display_name || b.profile?.employee_id || '').toLowerCase();
      return aName.localeCompare(bName, 'vi');
    });
  }, [employees, profiles]);

  const roleTree = useMemo(() => {
    return ROLE_TREE_ORDER.map(role => {
      const members = rows
        .map(({ employee, profile }) => {
          const resolvedRole = getResolvedProfileRole(employee, profile);
          if (resolvedRole !== role) return null;
          const actionOverrides = parseErpPermissionOverridesFromExtraJson(profile?.extra_json);
          const deptName = getDeptName(profile?.department_id);
          return {
            id: employee?.employee_id || profile?.employee_id,
            departmentId: profile?.department_id ?? 'unassigned',
            departmentName: deptName === '—' ? 'Chưa gán phòng ban' : deptName,
            name: employee?.display_name || getEmpName(profile?.employee_id),
            username: employee?.username || '',
            positionName: positions.find(x => x.id === profile?.position_id)?.name || 'Chưa gán chức vụ',
            hasAccount: !!employee,
            moduleCount: countEnabledVisibleModules(employee),
            actionOverrideCount: Object.keys(actionOverrides).length,
          };
        })
        .filter(Boolean) as Array<{
          id: string;
          departmentId: number | 'unassigned';
          departmentName: string;
          name: string;
          username: string;
          positionName: string;
          hasAccount: boolean;
          moduleCount: number;
          actionOverrideCount: number;
        }>;

      const departmentMap = new Map<number | 'unassigned', { id: number | 'unassigned'; name: string; members: typeof members }>();
      for (const member of members) {
        const current = departmentMap.get(member.departmentId) || { id: member.departmentId, name: member.departmentName, members: [] as typeof members };
        current.members.push(member);
        departmentMap.set(member.departmentId, current);
      }

      return {
        role,
        label: getRoleLabel(role),
        badgeClass: getRoleBadgeClass(role),
        count: members.length,
        departments: Array.from(departmentMap.values())
          .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
          .map(department => ({
            ...department,
            members: [...department.members].sort((a, b) => a.name.localeCompare(b.name, 'vi')),
          })),
      };
    }).filter(branch => branch.count > 0);
  }, [departments, getDeptName, getEmpName, positions, rows]);

  const handleDeleteEmployee = async (row: any) => {
    const employeeId = row.employee?.employee_id || row.profile?.employee_id;
    if (!employeeId) return;
    try {
      if (row.employee) {
        const res = await ipc.employee?.delete?.(employeeId);
        if (!res?.success) {
          showNotification(res?.error || 'Không thể xóa nhân viên', 'error');
          return;
        }
      }
      if (row.profile) {
        const res = await ipc.erp?.employeeDeleteProfile?.({ employeeId });
        if (res && !res.success) {
          showNotification(res.error || 'Không thể xóa hồ sơ ERP', 'error');
          return;
        }
      }
      await Promise.all([loadEmployees(), loadProfiles()]);
      showNotification('Đã xóa nhân viên khỏi ERP', 'success');
    } catch (error: any) {
      showNotification(error?.message || 'Xóa nhân viên thất bại', 'error');
    }
  };

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Danh sách nhân sự ({rows.length})</h3>
          <p className="text-[11px] text-gray-500 mt-1">Dữ liệu tài khoản đồng bộ trực tiếp với mục <span className="text-gray-300">Cài đặt → Nhân viên</span>; ERP chỉ bổ sung hồ sơ nội bộ.</p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            type="button"
            onClick={() => setRoleTreeOpen(true)}
            title="Biểu đồ cây theo role"
            className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-700 bg-gray-800 text-sm text-gray-200 transition-colors hover:border-blue-500/50 hover:bg-gray-700"
          >
            🌳
            {roleTree.length > 0 && (
              <span className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-blue-600 px-1 py-0.5 text-[9px] font-semibold leading-none text-white">
                {roleTree.length}
              </span>
            )}
          </button>
          {canManageEmployees && (
            <button
              onClick={() => setEditorState({ employee: null, profile: null })}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded"
            >
              + Thêm nhân viên
            </button>
          )}
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-gray-700/50 text-gray-400">
            <tr>
              <th className="px-3 py-2 text-left">Tài khoản</th>
              <th className="px-3 py-2 text-left">Phòng ban</th>
              <th className="px-3 py-2 text-left">Chức vụ</th>
              <th className="px-3 py-2 text-left">SĐT</th>
              <th className="px-3 py-2 text-left">Role</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700/50">
            {rows.map(({ employee, profile }) => (
              <tr key={employee?.employee_id || profile?.employee_id} className="text-gray-200 hover:bg-gray-700/30 align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{employee?.display_name || getEmpName(profile?.employee_id)}</div>
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    {employee?.username ? `@${employee.username}` : 'Chưa có tài khoản đăng nhập'}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {employee?.role === 'boss' && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-600/20 text-amber-300">Boss</span>}
                    {employee && !employee.is_active && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-red-600/20 text-red-300">Vô hiệu</span>}
                    {!profile && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-yellow-600/20 text-yellow-300">Thiếu hồ sơ ERP</span>}
                  </div>
                </td>
                <td className="px-3 py-2">{getDeptName(profile?.department_id)}</td>
                <td className="px-3 py-2">{positions.find(x => x.id === profile?.position_id)?.name || '—'}</td>
                <td className="px-3 py-2">{profile?.phone || '—'}</td>
                <td className="px-3 py-2">
                  {(() => {
                    const resolvedRole = getResolvedProfileRole(employee, profile);
                    const actionOverrideCount = Object.keys(parseErpPermissionOverridesFromExtraJson(profile?.extra_json)).length;
                    const moduleCount = countEnabledVisibleModules(employee);
                    return (
                      <div>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] ${getRoleBadgeClass(resolvedRole)}`}>{getRoleLabel(resolvedRole)}</span>
                        <div className="text-[10px] text-gray-500 mt-1">🔐 {moduleCount} module · ⚙️ {actionOverrideCount} action riêng</div>
                      </div>
                    );
                  })()}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-2 text-[11px]">
                    {(canManageEmployees || profile?.employee_id === currentEmployeeId) && (employee || profile) && (
                      <ActionIconButton onClick={() => setEditorState({ employee, profile })} title="Sửa nhân sự" color="text-blue-400 hover:text-blue-300">
                        ✏️
                      </ActionIconButton>
                    )}
                    {canManageEmployees && (
                      <ActionIconButton onClick={() => setDeleteTarget({ employee, profile })} title="Xóa nhân sự" color="text-red-400 hover:text-red-300">
                        🗑️
                      </ActionIconButton>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">Chưa có nhân sự nào</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Quick "add missing employees" section */}
      {canManageDepartments && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-gray-400 mb-2">Tạo hồ sơ ERP cho nhân viên đã có tài khoản</h4>
          <div className="flex flex-wrap gap-2">
            {employees
              .filter((e: any) => !profiles.find(p => p.employee_id === e.employee_id))
              .slice(0, 20)
              .map((e: any) => (
                <button key={e.employee_id}
                  onClick={() => setEditorState({ employee: e, profile: null })}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-200">
                  + {e.display_name}
                </button>
              ))}
          </div>
        </div>
      )}

      {roleTreeOpen && (
        <ErpOverlay onClose={() => setRoleTreeOpen(false)}>
          <ErpModalCard className="w-full max-w-5xl max-h-[88vh] overflow-auto rounded-xl border-gray-600 p-5">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h3 className="text-white font-semibold">Biểu đồ cây theo role</h3>
                <p className="text-[11px] text-gray-500 mt-1">Hiển thị cấu trúc role ERP → phòng ban → từng nhân sự để rà nhanh phân tầng nhân sự.</p>
              </div>
              <button onClick={() => setRoleTreeOpen(false)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <RoleTreePanel roleTree={roleTree} />
          </ErpModalCard>
        </ErpOverlay>
      )}

      {editorState && (
        <EmployeeEditorModal
          employee={editorState.employee}
          profile={editorState.profile ?? (editorState.employee ? profiles.find(p => p.employee_id === editorState.employee.employee_id) : null)}
          departments={departments}
          positions={positions}
          canManageEmployees={canManageEmployees}
          onClose={() => setEditorState(null)}
          onSave={async ({ employeeId, employeePatch, profilePatch, modulePermissionsPatch, shouldCreateAccount, shouldUpdateAccount }: any) => {
            let resolvedEmployeeId = employeeId;
            if (shouldCreateAccount) {
              const created = await ipc.employee?.create?.(employeePatch);
              if (!created?.success || !created?.employee?.employee_id) {
                showNotification(created?.error || 'Không thể tạo nhân sự', 'error');
                return;
              }
              resolvedEmployeeId = created.employee.employee_id;
            } else if (resolvedEmployeeId && shouldUpdateAccount && employeePatch) {
              const updated = await ipc.employee?.update?.(resolvedEmployeeId, employeePatch);
              if (!updated?.success) {
                showNotification(updated?.error || 'Không thể cập nhật tài khoản', 'error');
                return;
              }
            }
            if (resolvedEmployeeId) {
              if (modulePermissionsPatch && (shouldCreateAccount || shouldUpdateAccount)) {
                const permissionRes = await ipc.employee?.setPermissions?.(resolvedEmployeeId, modulePermissionsPatch);
                if (permissionRes && !permissionRes.success) {
                  showNotification(permissionRes.error || 'Không thể cập nhật quyền module', 'error');
                  return;
                }
              }
              await upsertProfile(resolvedEmployeeId, profilePatch);
              await Promise.all([loadEmployees(), loadProfiles()]);
            }
            setEditorState(null);
          }}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          message={`Xóa nhân viên "${deleteTarget.employee?.display_name || deleteTarget.profile?.employee_id || deleteTarget.employee?.employee_id}" khỏi hệ thống?`}
          onConfirm={async () => {
            await handleDeleteEmployee(deleteTarget);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
function EmployeeEditorModal({ employee, profile, departments, positions, canManageEmployees, onClose, onSave }: any) {
  const hasAccount = !!employee?.employee_id;
  const hasProfile = !!profile?.employee_id;
  const isEdit = hasAccount || hasProfile;
  const [accountForm, setAccountForm] = useState<any>({
    username: employee?.username || '',
    password: '',
    display_name: employee?.display_name || '',
    role: employee?.role || 'employee',
    is_active: employee?.is_active ?? 1,
  });
  const [profileForm, setProfileForm] = useState<any>(profile ?? { erp_role: employee?.role === 'boss' ? 'owner' : 'member' });
  const [modulePermissions, setModulePermissions] = useState<Record<string, boolean>>(() => buildEmployeeModulePermissionMap(employee));
  const [actionPermissions, setActionPermissions] = useState<Record<ErpPermissionAction, 'inherit' | ErpPermissionOverrideMode>>(() => buildActionPermissionState(profile));

  const effectiveRole = profileForm.erp_role ?? (accountForm.role === 'boss' ? 'owner' : 'member');
  const canConfigureModulePermissions = canManageEmployees && (hasAccount || !isEdit);

  const actionOverrides = Object.entries(actionPermissions).reduce((acc, [action, mode]) => {
    if (mode === 'allow' || mode === 'deny') acc[action as ErpPermissionAction] = mode;
    return acc;
  }, {} as ErpPermissionOverrides);

  const updateModulePermission = (moduleKey: string) => {
    setModulePermissions(current => ({ ...current, [moduleKey]: !current[moduleKey] }));
  };

  return (
    <ErpOverlay onClose={onClose}>
      <ErpModalCard className="w-full max-w-5xl max-h-[88vh] overflow-auto rounded-xl border-gray-600 p-4 sm:p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold">{isEdit ? 'Cập nhật nhân sự' : 'Thêm nhân sự mới'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-gray-500">Tài khoản</div>
            <Field label="Tên hiển thị">
              <input value={accountForm.display_name} onChange={e => setAccountForm({ ...accountForm, display_name: e.target.value })} className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white" />
            </Field>
            <Field label="Tên đăng nhập">
              <input disabled={isEdit} value={accountForm.username} onChange={e => setAccountForm({ ...accountForm, username: e.target.value })} className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white disabled:opacity-50" />
            </Field>
            <Field label={isEdit ? 'Mật khẩu mới (bỏ trống để giữ nguyên)' : 'Mật khẩu'}>
              <input type="password" value={accountForm.password} onChange={e => setAccountForm({ ...accountForm, password: e.target.value })} className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white" />
            </Field>
            <Field label="Vai trò tài khoản">
              <select disabled={!canManageEmployees} value={accountForm.role} onChange={e => setAccountForm({ ...accountForm, role: e.target.value })} className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white disabled:opacity-50">
                <option value="employee">Nhân viên</option>
                <option value="boss">Boss</option>
              </select>
            </Field>
            {isEdit && canManageEmployees && (
              <Field label="Trạng thái">
                <select value={String(accountForm.is_active)} onChange={e => setAccountForm({ ...accountForm, is_active: Number(e.target.value) })} className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white">
                  <option value="1">Đang hoạt động</option>
                  <option value="0">Vô hiệu</option>
                </select>
              </Field>
            )}
            {!hasAccount && hasProfile && (
              <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-200">
                Hồ sơ ERP này chưa có tài khoản đăng nhập nên chưa thể gán quyền module Deplao.
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-gray-500">Hồ sơ ERP</div>
            <Field label="Phòng ban">
              <select value={profileForm.department_id ?? ''} onChange={e => setProfileForm({ ...profileForm, department_id: e.target.value ? Number(e.target.value) : null })} className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white">
                <option value="">— không —</option>
                {departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Chức vụ">
              <select value={profileForm.position_id ?? ''} onChange={e => setProfileForm({ ...profileForm, position_id: e.target.value ? Number(e.target.value) : null })} className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white">
                <option value="">— không —</option>
                {positions.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Role ERP">
              <select disabled={!canManageEmployees} value={profileForm.erp_role ?? 'member'} onChange={e => setProfileForm({ ...profileForm, erp_role: e.target.value })} className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white disabled:opacity-50">
                {ERP_ROLE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="SĐT"><input value={profileForm.phone ?? ''} onChange={e => setProfileForm({ ...profileForm, phone: e.target.value })} className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white" /></Field>
            <Field label="Email"><input value={profileForm.email ?? ''} onChange={e => setProfileForm({ ...profileForm, email: e.target.value })} className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white" /></Field>
          </div>
          </div>

          <div className="space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-gray-500">Phân quyền</div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
            <div className="rounded-xl border border-gray-700/60 bg-gray-900/30 p-3">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div>
                  <div className="text-xs font-semibold text-white">Quyền module Deplao</div>
                  <div className="text-[11px] text-gray-500 mt-1">Áp dụng cho các module ngoài ERP khi nhân viên đăng nhập.</div>
                </div>
                {!canConfigureModulePermissions && <span className="text-[10px] text-gray-500">Chỉ quản lý mới được chỉnh</span>}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {EMPLOYEE_MODULES.map(module => (
                  <label key={module.key} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 ${modulePermissions[module.key] ? 'border-blue-500/40 bg-blue-500/10' : 'border-gray-700/70 bg-gray-800/60'} ${canConfigureModulePermissions ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}>
                    <input type="checkbox" disabled={!canConfigureModulePermissions} checked={!!modulePermissions[module.key]} onChange={() => updateModulePermission(module.key)} className="sr-only" />
                    <span className={`w-4 h-4 rounded border flex items-center justify-center ${modulePermissions[module.key] ? 'border-blue-400 bg-blue-500' : 'border-gray-500'}`}>
                      {modulePermissions[module.key] && <span className="text-[10px] text-white">✓</span>}
                    </span>
                    <span className="text-base">{module.icon}</span>
                    <div className="min-w-0">
                      <div className="text-xs text-gray-100 font-medium">{module.label}</div>
                      <div className="text-[10px] text-gray-500 truncate">{module.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-gray-700/60 bg-gray-900/30 p-3">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div>
                  <div className="text-xs font-semibold text-white">Quyền action ERP</div>
                  <div className="text-[11px] text-gray-500 mt-1">Role hiện tại: <span className="text-gray-300">{getRoleLabel(effectiveRole)}</span>. Có thể ghi đè riêng từng action.</div>
                </div>
                {!canManageEmployees && <span className="text-[10px] text-gray-500">Chỉ quản lý mới được chỉnh</span>}
              </div>
              <div className="space-y-3 max-h-[360px] overflow-auto pr-1">
                {ERP_PERMISSION_GROUPS.map(group => (
                  <div key={group.id} className="rounded-lg border border-gray-700/70 bg-gray-800/50 p-3 space-y-2">
                    <div className="text-[11px] uppercase tracking-wider text-gray-500">{group.label}</div>
                    {group.actions.map(action => {
                      const meta = ERP_PERMISSION_META[action];
                      const inheritedAllowed = ERP_PERMISSIONS[action].includes(effectiveRole);
                      return (
                        <div key={action} className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_170px] gap-2 items-start">
                          <div>
                            <div className="text-xs text-gray-100 font-medium">{meta.label}</div>
                            <div className="text-[10px] text-gray-500 mt-0.5">{meta.description}</div>
                            <div className="text-[10px] text-gray-600 mt-1">Mặc định theo role: {inheritedAllowed ? 'Cho phép' : 'Chặn'} · Role được phép: {ERP_PERMISSIONS[action].join(', ')}</div>
                          </div>
                          <select
                            disabled={!canManageEmployees}
                            value={actionPermissions[action]}
                            onChange={e => setActionPermissions(current => ({ ...current, [action]: e.target.value as 'inherit' | ErpPermissionOverrideMode }))}
                            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white disabled:opacity-50"
                          >
                            <option value="inherit">Kế thừa role ({inheritedAllowed ? 'Cho phép' : 'Chặn'})</option>
                            <option value="allow">Cho phép riêng</option>
                            <option value="deny">Chặn riêng</option>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 text-gray-400 hover:text-white text-xs">Hủy</button>
          <button onClick={() => onSave({
            employeeId: employee?.employee_id ?? profile?.employee_id,
            employeePatch: hasAccount
              ? { display_name: accountForm.display_name, password: accountForm.password || undefined, role: accountForm.role, is_active: accountForm.is_active }
              : !isEdit
                ? { username: accountForm.username, password: accountForm.password, display_name: accountForm.display_name, role: accountForm.role }
                : undefined,
            modulePermissionsPatch: canConfigureModulePermissions
              ? EMPLOYEE_MODULES.map(module => ({ module: module.key, can_access: !!modulePermissions[module.key] }))
              : undefined,
            profilePatch: {
              ...profileForm,
              erp_role: effectiveRole,
              extra_json: stringifyErpPermissionOverridesToExtraJson(profileForm.extra_json ?? profile?.extra_json, actionOverrides),
            },
            shouldCreateAccount: !isEdit,
            shouldUpdateAccount: hasAccount,
          })} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded">Lưu</button>
        </div>
        {(employee?.employee_id || profile?.employee_id) && <div className="text-[10px] text-gray-500 mt-2">Employee ID: {employee?.employee_id || profile?.employee_id}</div>}
      </ErpModalCard>
    </ErpOverlay>
  );
}

const Field = ({ label, children }: any) => (
  <div>
    <label className="block text-gray-400 mb-1">{label}</label>
    {children}
  </div>
);

function ActionIconButton({ children, onClick, title, color = 'text-gray-400 hover:text-white' }: { children: React.ReactNode; onClick: () => void; title: string; color?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`w-7 h-7 inline-flex items-center justify-center rounded-lg hover:bg-gray-700/70 transition-colors ${color}`}
    >
      {children}
    </button>
  );
}

function RoleTreePanel({ roleTree }: { roleTree: any[] }) {
  if (roleTree.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-700 bg-gray-900/30 px-4 py-8 text-center text-sm text-gray-500">
        Chưa có dữ liệu role để dựng cây nhân sự
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-end mb-3">
        <div className="text-[11px] text-gray-500">{roleTree.length} nhánh role đang có dữ liệu</div>
      </div>
      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
        {roleTree.map(branch => (
          <div key={branch.role} className="rounded-xl border border-gray-700/60 bg-gray-900/30 p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-gray-500">Role ERP</div>
                <div className="text-sm font-semibold text-white mt-1">{branch.label}</div>
              </div>
              <span className={`px-2 py-1 rounded-full text-[10px] font-medium ${branch.badgeClass}`}>{branch.count} nhân sự</span>
            </div>

            <div className="space-y-3">
              {branch.departments.map((department: any) => (
                <div key={`${branch.role}-${department.id}`} className="relative pl-4 border-l border-gray-700/70">
                  <span className="absolute left-[-4px] top-2.5 w-2 h-2 rounded-full bg-blue-400/70" />
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-gray-200">{department.name}</div>
                    <span className="text-[10px] text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded-full">{department.members.length}</span>
                  </div>
                  <div className="mt-2 ml-1 space-y-2">
                    {department.members.map((member: any) => (
                      <div key={member.id} className="rounded-lg border border-gray-700/60 bg-gray-800/60 px-3 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm text-white font-medium truncate">{member.name}</div>
                            <div className="text-[11px] text-gray-500 mt-0.5 truncate">
                              {member.username ? `@${member.username}` : 'Chưa có tài khoản'} · {member.positionName}
                            </div>
                          </div>
                          {!member.hasAccount && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-600/20 text-yellow-300">Thiếu tài khoản</span>}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-gray-500">
                          <span>🔐 {member.moduleCount} module</span>
                          <span>⚙️ {member.actionOverrideCount} action riêng</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Departments tab ──────────────────────────────────────────────────────────
function DepartmentsTab() {
  const perms = useErpPermissions();
  const { departments, loadDepartments, createDepartment, updateDepartment, deleteDepartment } = useErpEmployeeStore();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => { loadDepartments(); }, []);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Phòng ban ({departments.length})</h3>
        {perms.can('department.manage') && (
          <button onClick={() => setCreating(true)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded">
            + Thêm phòng ban
          </button>
        )}
      </div>
      <div className="grid gap-2">
        {departments.map(d => (
          <div key={d.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex items-center justify-between">
            <div>
              <div className="text-sm text-white font-medium">{d.name}</div>
              {d.description && <div className="text-xs text-gray-400 mt-0.5">{d.description}</div>}
              <div className="text-[10px] text-gray-500 mt-0.5">{(d as any).employeeCount ?? 0} nhân sự</div>
            </div>
            {perms.can('department.manage') && (
              <div className="flex gap-1">
                <button onClick={async () => {
                  const name = prompt('Tên phòng ban mới', d.name);
                  if (name && name !== d.name) await updateDepartment(d.id, { name });
                }} className="text-blue-400 hover:text-blue-300 text-xs" title="Sửa phòng ban">✏️</button>
                <button onClick={async () => {
                  if (confirm(`Xóa phòng ban "${d.name}"?`)) await deleteDepartment(d.id);
                }} className="text-red-400 hover:text-red-300 text-xs" title="Xóa phòng ban">🗑️</button>
              </div>
            )}
          </div>
        ))}
        {departments.length === 0 && <div className="text-center text-gray-500 text-xs py-6">Chưa có phòng ban</div>}
      </div>

      {creating && (
        <ErpOverlay onClose={() => { setCreating(false); setNewName(''); }}>
          <ErpModalCard className="w-full max-w-sm rounded-xl border-gray-600 p-5">
            <h3 className="text-white font-semibold mb-3">Tạo phòng ban</h3>
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="Tên phòng ban" className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm mb-4" />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setCreating(false); setNewName(''); }} className="px-3 py-1.5 text-gray-400 text-xs">Hủy</button>
              <button disabled={!newName.trim()} onClick={async () => {
                await createDepartment({ name: newName.trim() });
                setCreating(false); setNewName('');
              }} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded disabled:opacity-50">Tạo</button>
            </div>
          </ErpModalCard>
        </ErpOverlay>
      )}
    </div>
  );
}

function PositionsTab() {
  const perms = useErpPermissions();
  const { positions, departments, loadPositions, loadDepartments, createPosition, updatePosition, deletePosition } = useErpEmployeeStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [departmentId, setDepartmentId] = useState('');

  useEffect(() => { loadPositions(); loadDepartments(); }, []);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Chức vụ ({positions.length})</h3>
          <p className="text-[11px] text-gray-500 mt-1">Quản lý danh mục chức vụ để gán nhanh cho hồ sơ nhân sự ERP.</p>
        </div>
        {perms.can('position.manage') && (
          <button onClick={() => setCreating(true)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded">
            + Thêm chức vụ
          </button>
        )}
      </div>

      <div className="grid gap-2">
        {positions.map(position => (
          <div key={position.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm text-white font-medium">{position.name}</div>
              <div className="text-[11px] text-gray-500 mt-0.5">
                {departments.find(d => d.id === position.department_id)?.name || 'Toàn công ty'} · Cấp {position.level ?? 0}
              </div>
            </div>
            {perms.can('position.manage') && (
              <div className="flex gap-2 text-xs">
                <button onClick={async () => {
                  const nextName = prompt('Tên chức vụ', position.name);
                  if (!nextName?.trim()) return;
                  const nextLevel = prompt('Cấp bậc', String(position.level ?? 0));
                  await updatePosition(position.id, { name: nextName.trim(), level: Number(nextLevel || 0) });
                }} className="text-blue-400 hover:text-blue-300" title="Sửa chức vụ">✏️</button>
                <button onClick={async () => {
                  if (!confirm(`Xóa chức vụ "${position.name}"?`)) return;
                  await deletePosition(position.id);
                }} className="text-red-400 hover:text-red-300" title="Xóa chức vụ">🗑️</button>
              </div>
            )}
          </div>
        ))}
        {positions.length === 0 && <div className="text-center text-gray-500 text-xs py-6">Chưa có chức vụ nào</div>}
      </div>

      {creating && (
        <ErpOverlay onClose={() => { setCreating(false); setName(''); setDepartmentId(''); }}>
          <ErpModalCard className="w-full max-w-sm rounded-xl border-gray-600 p-5">
            <h3 className="text-white font-semibold mb-3">Tạo chức vụ</h3>
            <div className="space-y-3 text-xs">
              <Field label="Tên chức vụ">
                <input autoFocus value={name} onChange={e => setName(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white" />
              </Field>
              <Field label="Phòng ban">
                <select value={departmentId} onChange={e => setDepartmentId(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white">
                  <option value="">Toàn công ty</option>
                  {departments.map((department: any) => <option key={department.id} value={department.id}>{department.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => { setCreating(false); setName(''); setDepartmentId(''); }} className="px-3 py-1.5 text-gray-400 text-xs">Hủy</button>
              <button disabled={!name.trim()} onClick={async () => {
                await createPosition({ name: name.trim(), department_id: departmentId ? Number(departmentId) : null });
                setCreating(false); setName(''); setDepartmentId('');
              }} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded disabled:opacity-50">Tạo</button>
            </div>
          </ErpModalCard>
        </ErpOverlay>
      )}
    </div>
  );
}

// ── Attendance tab ───────────────────────────────────────────────────────────
function AttendanceTab() {
  const perms = useErpPermissions();
  const eid = useCurrentEmployeeId();
  const canViewOthers = perms.can('attendance.view_others');
  const { profiles, departments, positions, loadProfiles, loadDepartments, loadPositions, todayAttendance, loadTodayAttendance, checkIn, checkOut, attendanceList, loadAttendance } = useErpEmployeeStore();
  const { employees, loadEmployees } = useEmployeeStore();
  const [scope, setScope] = useState<'mine' | 'all'>(canViewOthers ? 'all' : 'mine');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [dateFilter, setDateFilter] = useState<ErpDateFilterPreset>('last30');
  const [customDateRange, setCustomDateRange] = useState(() => getDefaultCustomRange());

  const activeDateRange = useMemo(() => resolveErpDateRange(dateFilter, customDateRange), [customDateRange, dateFilter]);
  const dateRangeParams = useMemo(() => {
    if (!activeDateRange) return null;
    return {
      from: toDateInputValue(activeDateRange.from),
      to: toDateInputValue(activeDateRange.to),
    };
  }, [activeDateRange]);

  const employeeMeta = useMemo(
    () => buildEmployeeMetaMap(employees, profiles, departments, positions),
    [departments, employees, positions, profiles],
  );
  const employeeOptions = useMemo(
    () => Array.from(employeeMeta.values()).sort((a, b) => a.name.localeCompare(b.name, 'vi')),
    [employeeMeta],
  );

  const getEmpName = (id: string) => id === 'boss'
    ? 'Boss'
    : employees.find((e: any) => e.employee_id === id)?.display_name || id;

  useEffect(() => {
    loadTodayAttendance();
    loadProfiles();
    loadDepartments();
    loadPositions();
    loadEmployees();
  }, []);

  useEffect(() => {
    if (!canViewOthers && scope !== 'mine') setScope('mine');
  }, [canViewOthers, scope]);

  useEffect(() => {
    if (!dateRangeParams) return;
    const filter = canViewOthers && scope === 'all'
      ? (employeeFilter ? { employeeId: employeeFilter, from: dateRangeParams.from, to: dateRangeParams.to } : { all: true, from: dateRangeParams.from, to: dateRangeParams.to })
      : { employeeId: employeeFilter || eid, from: dateRangeParams.from, to: dateRangeParams.to };
    loadAttendance(filter as any);
  }, [eid, canViewOthers, scope, employeeFilter, dateRangeParams?.from, dateRangeParams?.to]);

  const filteredAttendanceList = useMemo(() => {
    return attendanceList.filter(entry => {
      const meta = employeeMeta.get(entry.employee_id);
      return matchEmployeeMeta(meta, {
        departmentId: departmentFilter,
        positionId: positionFilter,
        role: roleFilter,
      });
    });
  }, [attendanceList, departmentFilter, employeeMeta, positionFilter, roleFilter]);

  return (
    <div className="p-4">
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-4">
        <div className="text-xs text-gray-400 mb-2">Hôm nay</div>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <div className="text-sm text-white">
              {todayAttendance?.check_in_at
                ? <>Check-in: <span className="text-green-400">{new Date(todayAttendance.check_in_at).toLocaleTimeString()}</span></>
                : <span className="text-gray-500">Chưa check-in</span>}
            </div>
            <div className="text-sm text-white mt-1">
              {todayAttendance?.check_out_at
                ? <>Check-out: <span className="text-blue-400">{new Date(todayAttendance.check_out_at).toLocaleTimeString()}</span></>
                : <span className="text-gray-500">Chưa check-out</span>}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              disabled={!!todayAttendance?.check_in_at}
              onClick={() => checkIn()}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white text-xs rounded"
            >Check-in</button>
            <button
              disabled={!todayAttendance?.check_in_at || !!todayAttendance?.check_out_at}
              onClick={() => checkOut()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs rounded"
            >Check-out</button>
          </div>
        </div>
      </div>

      <div className="mb-3 rounded-xl border border-gray-700/60 bg-gray-800/50 p-3 text-xs">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <div className="text-sm font-semibold text-white">Bộ lọc chấm công</div>
            <div className="text-[11px] text-gray-500 mt-1">Lọc theo nhân sự, phòng ban, chức vụ, quyền ERP và ngày ghi nhận công.</div>
          </div>
          <div className="text-[11px] text-gray-500">{filteredAttendanceList.length} bản ghi phù hợp</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        {canViewOthers && (
          <>
            <button onClick={() => { setScope('all'); setEmployeeFilter(''); }} className={`px-2.5 py-1 rounded ${scope === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>Tất cả</button>
            <button onClick={() => { setScope('mine'); setEmployeeFilter(''); }} className={`px-2.5 py-1 rounded ${scope === 'mine' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>Của tôi</button>
            <select value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white">
              <option value="">{scope === 'all' ? 'Tất cả nhân sự' : 'Nhân sự hiện tại'}</option>
              <option value="boss">Boss</option>
              {employeeOptions.map(option => <option key={option.employeeId} value={option.employeeId}>{option.name}</option>)}
            </select>
          </>
        )}
          <select value={departmentFilter} onChange={e => setDepartmentFilter(e.target.value)} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white">
            <option value="">Tất cả phòng ban</option>
            {departments.map((department: any) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select>
          <select value={positionFilter} onChange={e => setPositionFilter(e.target.value)} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white">
            <option value="">Tất cả chức vụ</option>
            {positions.map((position: any) => <option key={position.id} value={position.id}>{position.name}</option>)}
          </select>
          <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white">
            <option value="">Tất cả role ERP</option>
            {ERP_ROLE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            <option value="unassigned">Chưa gán role</option>
          </select>
          <select value={dateFilter} onChange={e => setDateFilter(e.target.value as ErpDateFilterPreset)} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white">
            {ERP_DATE_FILTER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          {dateFilter === 'custom' && (
            <>
              <label className="text-gray-400">Từ</label>
              <input type="date" value={customDateRange.from} onChange={e => setCustomDateRange(range => ({ ...range, from: e.target.value }))}
                className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white" />
              <label className="text-gray-400">Đến</label>
              <input type="date" value={customDateRange.to} onChange={e => setCustomDateRange(range => ({ ...range, to: e.target.value }))}
                className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white" />
            </>
          )}
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-gray-700/50 text-gray-400">
            <tr>
              {(canViewOthers || scope === 'all' || !!employeeFilter) && <th className="px-3 py-2 text-left">Nhân viên</th>}
              <th className="px-3 py-2 text-left">Ngày</th>
              <th className="px-3 py-2 text-left">Vào</th>
              <th className="px-3 py-2 text-left">Ra</th>
              <th className="px-3 py-2 text-left">Số giờ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700/50">
            {filteredAttendanceList.map(a => {
              const hrs = a.check_in_at && a.check_out_at ? ((a.check_out_at - a.check_in_at) / 3600000).toFixed(1) : '—';
              const meta = employeeMeta.get(a.employee_id);
              return (
                <tr key={a.id} className="text-gray-200">
                  {(canViewOthers || scope === 'all' || !!employeeFilter) && (
                    <td className="px-3 py-2">
                      <div className="font-medium">{getEmpName(a.employee_id)}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">{meta?.departmentName || 'Chưa gán phòng ban'} · {meta?.positionName || 'Chưa gán chức vụ'} · {getRoleLabel(meta?.role)}</div>
                    </td>
                  )}
                  <td className="px-3 py-2">{a.date}</td>
                  <td className="px-3 py-2">{a.check_in_at ? new Date(a.check_in_at).toLocaleTimeString() : '—'}</td>
                  <td className="px-3 py-2">{a.check_out_at ? new Date(a.check_out_at).toLocaleTimeString() : '—'}</td>
                  <td className="px-3 py-2">{hrs}</td>
                </tr>
              );
            })}
            {filteredAttendanceList.length === 0 && (
              <tr><td colSpan={(canViewOthers || scope === 'all' || !!employeeFilter) ? 5 : 4} className="px-3 py-6 text-center text-gray-500">Chưa có dữ liệu</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Leave tab ────────────────────────────────────────────────────────────────
function LeaveTab() {
  const perms = useErpPermissions();
  const { myLeaves, pendingLeaves, profiles, departments, positions, loadMyLeaves, loadPendingLeaves, loadProfiles, loadDepartments, loadPositions, createLeave, decideLeave, cancelLeave } = useErpEmployeeStore();
  const { employees, loadEmployees } = useEmployeeStore();
  const [creating, setCreating] = useState(false);
  const canApprove = perms.can('leave.approve');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [createdDateFilter, setCreatedDateFilter] = useState<ErpDateFilterPreset>('last30');
  const [customCreatedRange, setCustomCreatedRange] = useState(() => getDefaultCustomRange());

  const employeeMeta = useMemo(
    () => buildEmployeeMetaMap(employees, profiles, departments, positions),
    [departments, employees, positions, profiles],
  );
  const createdRange = useMemo(() => resolveErpDateRange(createdDateFilter, customCreatedRange), [createdDateFilter, customCreatedRange]);

  useEffect(() => {
    loadProfiles();
    loadDepartments();
    loadPositions();
    loadEmployees();
    loadMyLeaves();
    if (canApprove) loadPendingLeaves();
  }, [canApprove]);

  const filterLeaves = (rows: any[]) => rows.filter(leave => {
    const meta = employeeMeta.get(leave.requester_id);
    if (!matchEmployeeMeta(meta, {
      departmentId: departmentFilter,
      positionId: positionFilter,
      role: roleFilter,
    })) return false;
    return !createdRange || (leave.created_at >= createdRange.from && leave.created_at <= createdRange.to);
  });

  const filteredMyLeaves = useMemo(() => filterLeaves(myLeaves), [createdRange, departmentFilter, employeeMeta, myLeaves, positionFilter, roleFilter]);
  const filteredPendingLeaves = useMemo(() => filterLeaves(pendingLeaves), [createdRange, departmentFilter, employeeMeta, pendingLeaves, positionFilter, roleFilter]);

  return (
    <div className="p-4 space-y-6">
      <div className="rounded-xl border border-gray-700/60 bg-gray-800/50 p-3 text-xs">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <div className="text-sm font-semibold text-white">Bộ lọc nghỉ phép</div>
            <div className="text-[11px] text-gray-500 mt-1">Lọc đơn theo phòng ban, chức vụ, quyền ERP và ngày tạo đơn.</div>
          </div>
          <div className="text-[11px] text-gray-500">{filteredMyLeaves.length}{canApprove ? ` / ${filteredPendingLeaves.length}` : ''} bản ghi hiển thị</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={departmentFilter} onChange={e => setDepartmentFilter(e.target.value)} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white">
            <option value="">Tất cả phòng ban</option>
            {departments.map((department: any) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select>
          <select value={positionFilter} onChange={e => setPositionFilter(e.target.value)} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white">
            <option value="">Tất cả chức vụ</option>
            {positions.map((position: any) => <option key={position.id} value={position.id}>{position.name}</option>)}
          </select>
          <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white">
            <option value="">Tất cả role ERP</option>
            {ERP_ROLE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            <option value="unassigned">Chưa gán role</option>
          </select>
          <select value={createdDateFilter} onChange={e => setCreatedDateFilter(e.target.value as ErpDateFilterPreset)} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white">
            {ERP_DATE_FILTER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          {createdDateFilter === 'custom' && (
            <>
              <label className="text-gray-400">Từ</label>
              <input type="date" value={customCreatedRange.from} onChange={e => setCustomCreatedRange(range => ({ ...range, from: e.target.value }))}
                className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white" />
              <label className="text-gray-400">Đến</label>
              <input type="date" value={customCreatedRange.to} onChange={e => setCustomCreatedRange(range => ({ ...range, to: e.target.value }))}
                className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white" />
            </>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-white">Đơn nghỉ phép của tôi</h3>
          <button onClick={() => setCreating(true)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded">
            + Tạo đơn
          </button>
        </div>
        <LeaveTable rows={filteredMyLeaves} onCancel={cancelLeave} getEmployeeMeta={employeeMeta} />
      </div>

      {canApprove && (
        <div>
          <h3 className="text-sm font-semibold text-white mb-2">Đơn chờ duyệt ({filteredPendingLeaves.length})</h3>
          <LeaveTable rows={filteredPendingLeaves} showActor approvable onDecide={decideLeave} getEmployeeMeta={employeeMeta} />
        </div>
      )}

      {creating && <LeaveCreateModal onClose={() => setCreating(false)} onSubmit={async (input) => { await createLeave(input); setCreating(false); }} />}
    </div>
  );
}

function LeaveTable({ rows, showActor, approvable, onDecide, onCancel, getEmployeeMeta }: any) {
  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-gray-700/50 text-gray-400">
          <tr>
            {showActor && <th className="px-3 py-2 text-left">Người gửi</th>}
            <th className="px-3 py-2 text-left">Loại</th>
            <th className="px-3 py-2 text-left">Ngày tạo</th>
            <th className="px-3 py-2 text-left">Từ</th>
            <th className="px-3 py-2 text-left">Đến</th>
            <th className="px-3 py-2 text-left">Lý do</th>
            <th className="px-3 py-2 text-left">Trạng thái</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-700/50">
          {(rows || []).map((l: any) => {
            const meta = getEmployeeMeta?.get?.(l.requester_id);
            return (
            <tr key={l.id} className="text-gray-200">
              {showActor && (
                <td className="px-3 py-2">
                  <div className="font-medium text-gray-100">{meta?.name || l.requester_id}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5">{meta?.departmentName || 'Chưa gán phòng ban'} · {meta?.positionName || 'Chưa gán chức vụ'} · {getRoleLabel(meta?.role)}</div>
                </td>
              )}
              <td className="px-3 py-2">{l.leave_type}</td>
              <td className="px-3 py-2">{formatDateCell(l.created_at)}</td>
              <td className="px-3 py-2">{l.start_date}</td>
              <td className="px-3 py-2">{l.end_date}</td>
              <td className="px-3 py-2 max-w-[200px] truncate" title={l.reason}>{l.reason}</td>
              <td className="px-3 py-2">
                <span className={`px-2 py-0.5 rounded-full text-[10px] ${
                  l.status === 'approved' ? 'bg-green-600/20 text-green-400' :
                  l.status === 'rejected' ? 'bg-red-600/20 text-red-400' :
                  l.status === 'cancelled' ? 'bg-gray-600/20 text-gray-400' :
                  'bg-yellow-600/20 text-yellow-400'
                }`}>{l.status}</span>
              </td>
              <td className="px-3 py-2 text-right space-x-1">
                {approvable && l.status === 'pending' && (
                  <>
                    <button onClick={() => onDecide(l.id, 'approved')} className="text-green-400 hover:text-green-300 text-[11px]">Duyệt</button>
                    <button onClick={() => { const note = prompt('Lý do từ chối?') || ''; onDecide(l.id, 'rejected', note); }} className="text-red-400 hover:text-red-300 text-[11px]">Từ chối</button>
                  </>
                )}
                {!approvable && l.status === 'pending' && (
                  <button onClick={() => onCancel(l.id)} className="text-gray-400 hover:text-white text-[11px]">Hủy</button>
                )}
              </td>
            </tr>
          );})}
          {(!rows || rows.length === 0) && (
            <tr><td colSpan={showActor ? 8 : 7} className="px-3 py-6 text-center text-gray-500">Không có đơn nào</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function LeaveCreateModal({ onClose, onSubmit }: any) {
  const [form, setForm] = useState({
    leave_type: 'annual',
    start_date: new Date().toISOString().slice(0, 10),
    end_date: new Date().toISOString().slice(0, 10),
    reason: ''
  });

  return (
    <ErpOverlay onClose={onClose}>
      <ErpModalCard className="w-full max-w-md rounded-xl border-gray-600 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold">Tạo đơn nghỉ phép</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="space-y-3 text-xs">
          <Field label="Loại">
            <select value={form.leave_type} onChange={e => setForm({ ...form, leave_type: e.target.value })}
              className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white">
              <option value="annual">Nghỉ phép năm</option>
              <option value="sick">Nghỉ ốm</option>
              <option value="unpaid">Nghỉ không lương</option>
              <option value="other">Khác</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Từ ngày">
              <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white" />
            </Field>
            <Field label="Đến ngày">
              <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white" />
            </Field>
          </div>
          <Field label="Lý do">
            <textarea value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} rows={3}
              className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white" />
          </Field>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 text-gray-400 hover:text-white text-xs">Hủy</button>
          <button disabled={!form.reason.trim()} onClick={() => onSubmit(form)}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded disabled:opacity-50">Gửi đơn</button>
        </div>
      </ErpModalCard>
    </ErpOverlay>
  );
}

