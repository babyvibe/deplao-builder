import { useEmployeeStore } from '@/store/employeeStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import {
  erpCanWithOverrides,
  parseErpPermissionOverridesFromExtraJson,
  type ErpPermissionOverrides,
  type ErpRole,
} from '../../../models/erp/Permission';

/**
 * Resolve the current ERP actor from the UI side.
 *
 * Boss / standalone → `{ employeeId: 'boss', role: 'owner' }`
 * Employee mode     → `{ employeeId: currentEmployee.employee_id, role: 'member' }`
 *                     (role will be upgraded from backend Phase 2 profile).
 *
 * IMPORTANT: The main process ALSO re-derives the employeeId server-side
 * (see `ErpAuthContext`). Never trust this value for authorisation alone —
 * it is used only for convenience in UI calls and optimistic rendering.
 */
export function useErpContext(): { employeeId: string; role: ErpRole; permissionOverrides: ErpPermissionOverrides } {
  const mode = useEmployeeStore(s => s.mode);
  const currentEmployee = useEmployeeStore(s => s.currentEmployee);
  const previewEmployeeId = useEmployeeStore(s => s.previewEmployeeId);
  const employees = useEmployeeStore(s => s.employees);
  const profiles = useErpEmployeeStore(s => s.profiles);
  const activeWorkspace = useWorkspaceStore(s => s.workspaces.find(w => w.id === s.activeWorkspaceId));

  const previewEmployee = previewEmployeeId
    ? employees.find((employee: any) => employee.employee_id === previewEmployeeId) ?? null
    : null;
  const activeEmployeeId = previewEmployeeId || currentEmployee?.employee_id || 'unknown_employee';
  const workspaceProfile = activeWorkspace?.type === 'remote' && activeWorkspace.employeeId === activeEmployeeId
    ? {
        employee_id: activeEmployeeId,
        erp_role: activeWorkspace.cachedErpRole,
        extra_json: activeWorkspace.cachedErpExtraJson,
      }
    : null;
  const syncedProfile = profiles.find(profile => profile.employee_id === activeEmployeeId);
  const activeProfile = (workspaceProfile?.erp_role || workspaceProfile?.extra_json)
    ? { ...syncedProfile, ...workspaceProfile }
    : (syncedProfile || workspaceProfile);

  const fallbackRole: ErpRole =
    previewEmployee?.role === 'boss' || currentEmployee?.role === 'boss'
      ? 'owner'
      : 'member';

  if (previewEmployeeId) {
    return {
      employeeId: previewEmployeeId,
      role: (activeProfile?.erp_role as ErpRole | undefined) ?? fallbackRole,
      permissionOverrides: parseErpPermissionOverridesFromExtraJson(activeProfile?.extra_json),
    };
  }

  if (mode === 'employee') {
    return {
      employeeId: activeEmployeeId,
      role: (activeProfile?.erp_role as ErpRole | undefined) ?? fallbackRole,
      permissionOverrides: parseErpPermissionOverridesFromExtraJson(activeProfile?.extra_json),
    };
  }
  return { employeeId: 'boss', role: 'owner', permissionOverrides: {} };
}

/** Short-hand to read the current employeeId only. */
export function useCurrentEmployeeId(): string {
  return useErpContext().employeeId;
}

/** UI-side permission check. `can('task.delete')`, etc. */
export function useErpPermissions() {
  const { role, permissionOverrides } = useErpContext();
  return {
    role,
    can: (action: string) => erpCanWithOverrides(role, action, permissionOverrides),
  };
}

