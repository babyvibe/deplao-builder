/**
 * ErpAuthContext — Main-process helper that resolves the "current" ERP
 * actor for IPC handlers & services. Renderer MUST NOT be trusted to
 * pass `employeeId` directly; it is derived here from AppModeManager.
 *
 * Default policy:
 *  - Employee mode → use `AppModeManager.getEmployeeId()`, role = 'member'
 *    (role can later be upgraded from `erp_employee_profiles.erp_role`).
 *  - Boss / standalone mode → actor = 'boss', role = 'owner'.
 */

import AppModeManager from '../../utils/AppModeManager';
import WorkspaceManager from '../../utils/WorkspaceManager';
import DatabaseService from '../DatabaseService';
import {
  ErpRole,
  erpCanWithOverrides,
  parseErpPermissionOverridesFromExtraJson,
  type ErpPermissionOverrides,
} from './permissions';

export interface ErpAuthCtx {
  employeeId: string;
  role: ErpRole;
  permissionOverrides: ErpPermissionOverrides;
  mode: 'standalone' | 'boss' | 'employee';
}

export class ErpPermissionError extends Error {
  public readonly action: string;
  constructor(action: string, employeeId: string, role: ErpRole) {
    super(`[ERP] Permission denied: action="${action}" actor="${employeeId}" role="${role}"`);
    this.name = 'ErpPermissionError';
    this.action = action;
  }
}

export default class ErpAuthContext {
  /** Resolve current ERP actor from AppMode + (optional) DB profile. */
  public static resolve(): ErpAuthCtx {
    const mode = AppModeManager.getInstance().getMode();
    if (mode === 'employee') {
      const empId = this._resolveEmployeeId() || 'unknown_employee';
      const access = this._lookupAccess(empId);
      return {
        employeeId: empId,
        role: access.role ?? 'member',
        permissionOverrides: access.permissionOverrides,
        mode,
      };
    }
    // boss / standalone: single-user owner
    return { employeeId: 'boss', role: 'owner', permissionOverrides: {}, mode };
  }

  private static _resolveEmployeeId(): string | null {
    const explicit = AppModeManager.getInstance().getEmployeeId();
    if (explicit) return explicit;
    try {
      const activeWorkspace = WorkspaceManager.getInstance().getActiveWorkspace();
      if (activeWorkspace?.type === 'remote' && activeWorkspace.employeeId) {
        return activeWorkspace.employeeId;
      }
    } catch {
      // Ignore workspace lookup failures and fall back below.
    }
    return null;
  }

  /** Throw `ErpPermissionError` if actor cannot perform `action`. */
  public static requirePermission(action: string, ctx?: ErpAuthCtx): ErpAuthCtx {
    const actor = ctx ?? this.resolve();
    if (!erpCanWithOverrides(actor.role, action, actor.permissionOverrides)) {
      throw new ErpPermissionError(action, actor.employeeId, actor.role);
    }
    return actor;
  }

  /** Best-effort access lookup from `erp_employee_profiles` (Phase 2 — may not exist). */
  private static _lookupAccess(employeeId: string): { role: ErpRole | null; permissionOverrides: ErpPermissionOverrides } {
    try {
      const activeWorkspace = WorkspaceManager.getInstance().getActiveWorkspace();
      if (activeWorkspace?.type === 'remote' && activeWorkspace.employeeId === employeeId) {
        const role = activeWorkspace.cachedErpRole;
        const extraJson = activeWorkspace.cachedErpExtraJson;
        if (role && ['owner', 'admin', 'manager', 'member', 'guest'].includes(role)) {
          return {
            role: role as ErpRole,
            permissionOverrides: parseErpPermissionOverridesFromExtraJson(extraJson),
          };
        }
      }
    } catch {
      // Ignore workspace cache lookup failures.
    }

    try {
      const row = DatabaseService.getInstance().queryOne<{ erp_role: string; extra_json?: string | null }>(
        `SELECT erp_role, extra_json FROM erp_employee_profiles WHERE employee_id = ?`,
        [employeeId],
      );
      const val = row?.erp_role;
      if (val && ['owner', 'admin', 'manager', 'member', 'guest'].includes(val)) {
        return {
          role: val as ErpRole,
          permissionOverrides: parseErpPermissionOverridesFromExtraJson(row?.extra_json),
        };
      }
    } catch {
      // Table not yet created (Phase 1) — silently fall back.
    }


    return { role: null, permissionOverrides: {} };
  }
}

