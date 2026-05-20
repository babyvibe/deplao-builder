"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErpPermissionError = void 0;
const AppModeManager_1 = __importDefault(require("../../utils/AppModeManager"));
const WorkspaceManager_1 = __importDefault(require("../../utils/WorkspaceManager"));
const DatabaseService_1 = __importDefault(require("../DatabaseService"));
const permissions_1 = require("./permissions");
class ErpPermissionError extends Error {
    constructor(action, employeeId, role) {
        super(`[ERP] Permission denied: action="${action}" actor="${employeeId}" role="${role}"`);
        this.name = 'ErpPermissionError';
        this.action = action;
    }
}
exports.ErpPermissionError = ErpPermissionError;
class ErpAuthContext {
    /** Resolve current ERP actor from AppMode + (optional) DB profile. */
    static resolve() {
        const mode = AppModeManager_1.default.getInstance().getMode();
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
    static _resolveEmployeeId() {
        const explicit = AppModeManager_1.default.getInstance().getEmployeeId();
        if (explicit)
            return explicit;
        try {
            const activeWorkspace = WorkspaceManager_1.default.getInstance().getActiveWorkspace();
            if (activeWorkspace?.type === 'remote' && activeWorkspace.employeeId) {
                return activeWorkspace.employeeId;
            }
        }
        catch {
            // Ignore workspace lookup failures and fall back below.
        }
        return null;
    }
    /** Throw `ErpPermissionError` if actor cannot perform `action`. */
    static requirePermission(action, ctx) {
        const actor = ctx ?? this.resolve();
        if (!(0, permissions_1.erpCanWithOverrides)(actor.role, action, actor.permissionOverrides)) {
            throw new ErpPermissionError(action, actor.employeeId, actor.role);
        }
        return actor;
    }
    /** Best-effort access lookup from `erp_employee_profiles` (Phase 2 — may not exist). */
    static _lookupAccess(employeeId) {
        try {
            const activeWorkspace = WorkspaceManager_1.default.getInstance().getActiveWorkspace();
            if (activeWorkspace?.type === 'remote' && activeWorkspace.employeeId === employeeId) {
                const role = activeWorkspace.cachedErpRole;
                const extraJson = activeWorkspace.cachedErpExtraJson;
                if (role && ['owner', 'admin', 'manager', 'member', 'guest'].includes(role)) {
                    return {
                        role: role,
                        permissionOverrides: (0, permissions_1.parseErpPermissionOverridesFromExtraJson)(extraJson),
                    };
                }
            }
        }
        catch {
            // Ignore workspace cache lookup failures.
        }
        try {
            const row = DatabaseService_1.default.getInstance().queryOne(`SELECT erp_role, extra_json FROM erp_employee_profiles WHERE employee_id = ?`, [employeeId]);
            const val = row?.erp_role;
            if (val && ['owner', 'admin', 'manager', 'member', 'guest'].includes(val)) {
                return {
                    role: val,
                    permissionOverrides: (0, permissions_1.parseErpPermissionOverridesFromExtraJson)(row?.extra_json),
                };
            }
        }
        catch {
            // Table not yet created (Phase 1) — silently fall back.
        }
        return { role: null, permissionOverrides: {} };
    }
}
exports.default = ErpAuthContext;
//# sourceMappingURL=ErpAuthContext.js.map