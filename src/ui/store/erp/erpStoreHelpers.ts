import { isErpPermissionDeniedResponse, reportErpPermissionDenied } from '@/lib/ipc';
import { useEmployeeStore } from '@/store/employee/employeeStore';

/**
 * An ERP write command through DataAccessor denied for lack of permission (`code: 'permission_denied'`: the IPC handler, or the owner's machine when an employee
 * goes through REST) → shows the same "không có quyền ERP" (no ERP permission) dialog as the ipc.erp wrapper. Employee mode did not go through that wrapper, so before
 * this, a denial was silent. The original result is returned so the caller can read `success` / `error`.
 */
export function withErpDeniedNotice<T>(res: T): T {
  if (isErpPermissionDeniedResponse(res)) reportErpPermissionDenied(res);
  return res;
}

/**
 * Employees who are certainly not allowed the ERP module: do not call the owner's machine (it returns 403 MODULE_FORBIDDEN for every /erp/*). Used for
 * background loading outside the ERP page (notification bell, today's timesheet on the top bar). Module permissions not loaded yet
 * (app just opened) → still calls: the owner's machine refuses by itself if there is no permission, and the caller keeps the value currently shown.
 */
export function isErpModuleOff(): boolean {
  try {
    const state = useEmployeeStore.getState();
    if (state.mode !== 'employee') return false;
    const loaded = state.permissions && Object.keys(state.permissions).length > 0;
    return !!loaded && !state.hasPermission('erp');
  } catch {
    return false;
  }
}
