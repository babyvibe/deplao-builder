"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcrypt = __importStar(require("bcryptjs"));
const jwt = __importStar(require("jsonwebtoken"));
const uuid_1 = require("uuid");
const DatabaseService_1 = __importDefault(require("./DatabaseService"));
const Logger_1 = __importDefault(require("../utils/Logger"));
const BCRYPT_ROUNDS = 12;
const JWT_EXPIRES_IN = '7d';
const ALL_MODULES = ['chat', 'friends', 'crm', 'workflow', 'integration', 'analytics', 'ai_assistant', 'settings'];
class EmployeeService {
    static getInstance() {
        if (!EmployeeService.instance) {
            EmployeeService.instance = new EmployeeService();
        }
        return EmployeeService.instance;
    }
    constructor() {
        this.jwtSecret = '';
        this.pinnedDbPath = null;
        this.initJwtSecret();
    }
    initJwtSecret() {
        this.runOnDb((db) => {
            const existing = db.getSetting?.('employee_jwt_secret');
            if (existing) {
                this.jwtSecret = existing;
            }
            else {
                this.jwtSecret = (0, uuid_1.v4)() + '-' + (0, uuid_1.v4)();
                db.setSetting?.('employee_jwt_secret', this.jwtSecret);
            }
        });
    }
    /**
     * Pin employee operations to the current workspace DB.
     * Called by HttpRelayService.start().
     */
    pinToCurrentDb() {
        this.pinnedDbPath = DatabaseService_1.default.getInstance().getDbPath();
        Logger_1.default.log(`[EmployeeService] Pinned to DB: ${this.pinnedDbPath}`);
        this.initJwtSecret();
    }
    /** Unpin when relay stops */
    unpinDb() {
        this.pinnedDbPath = null;
        Logger_1.default.log(`[EmployeeService] Unpinned DB`);
    }
    /**
     * Run a function against the correct DB (pinned or current).
     * Uses DatabaseService.withDbPath to temporarily switch if needed.
     */
    runOnDb(fn) {
        const db = DatabaseService_1.default.getInstance();
        if (this.pinnedDbPath && db.getDbPath() !== this.pinnedDbPath) {
            return db.withDbPath(this.pinnedDbPath, () => fn(db));
        }
        return fn(db);
    }
    // ─── CRUD ──────────────────────────────────────────────────────────
    async createEmployee(params) {
        try {
            const username = params.username.toLowerCase().trim();
            // Validate
            if (!username || username.length < 3) {
                return { success: false, error: 'Tên đăng nhập phải có ít nhất 3 ký tự' };
            }
            if (!/^[a-z0-9_]+$/.test(username)) {
                return { success: false, error: 'Tên đăng nhập chỉ chứa chữ cái thường, số và dấu gạch dưới' };
            }
            if (!params.password || params.password.length < 4) {
                return { success: false, error: 'Mật khẩu phải có ít nhất 4 ký tự' };
            }
            if (!params.display_name?.trim()) {
                return { success: false, error: 'Tên hiển thị không được để trống' };
            }
            const password_hash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);
            const employee_id = (0, uuid_1.v4)();
            return this.runOnDb((db) => {
                // Check duplicate
                const existing = db.getEmployeeByUsername(username);
                if (existing) {
                    return { success: false, error: 'Tên đăng nhập đã tồn tại' };
                }
                db.createEmployee({
                    employee_id,
                    username,
                    password_hash,
                    display_name: params.display_name.trim(),
                    avatar_url: params.avatar_url || '',
                    role: params.role || 'employee',
                });
                // Set default permissions (all denied)
                const defaultPerms = ALL_MODULES.map(m => ({ module: m, can_access: 0 }));
                db.setEmployeePermissions(employee_id, defaultPerms);
                const employee = db.getEmployeeById(employee_id);
                const permissions = db.getEmployeePermissions(employee_id).map(p => ({ module: p.module, can_access: !!p.can_access }));
                const assigned_accounts = db.getEmployeeAccountAccess(employee_id);
                return { success: true, employee: { ...employee, permissions, assigned_accounts } };
            });
        }
        catch (err) {
            Logger_1.default.error(`[EmployeeService] createEmployee error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
    updateEmployee(employeeId, updates) {
        try {
            return this.runOnDb((db) => {
                const emp = db.getEmployeeById(employeeId);
                if (!emp)
                    return { success: false, error: 'Nhân viên không tồn tại' };
                const dbUpdates = {};
                if (updates.display_name !== undefined)
                    dbUpdates.display_name = updates.display_name.trim();
                if (updates.avatar_url !== undefined)
                    dbUpdates.avatar_url = updates.avatar_url;
                if (updates.is_active !== undefined)
                    dbUpdates.is_active = updates.is_active;
                if (updates.role !== undefined)
                    dbUpdates.role = updates.role;
                if (updates.group_id !== undefined)
                    dbUpdates.group_id = updates.group_id;
                if (updates.password) {
                    dbUpdates.password_hash = bcrypt.hashSync(updates.password, BCRYPT_ROUNDS);
                }
                db.updateEmployee(employeeId, dbUpdates);
                return { success: true };
            });
        }
        catch (err) {
            Logger_1.default.error(`[EmployeeService] updateEmployee error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
    deleteEmployee(employeeId) {
        try {
            return this.runOnDb((db) => {
                db.deleteEmployee(employeeId);
                return { success: true };
            });
        }
        catch (err) {
            Logger_1.default.error(`[EmployeeService] deleteEmployee error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
    getEmployees() {
        try {
            return this.runOnDb((db) => {
                const employees = db.getEmployees();
                return employees.map((emp) => {
                    const permissions = db.getEmployeePermissions(emp.employee_id).map(p => ({ module: p.module, can_access: !!p.can_access }));
                    const assigned_accounts = db.getEmployeeAccountAccess(emp.employee_id);
                    return { ...emp, permissions, assigned_accounts };
                });
            });
        }
        catch (err) {
            Logger_1.default.error(`[EmployeeService] getEmployees error: ${err.message}`);
            return [];
        }
    }
    getEmployeeById(employeeId) {
        try {
            return this.runOnDb((db) => {
                const emp = db.getEmployeeById(employeeId);
                if (!emp)
                    return null;
                const permissions = db.getEmployeePermissions(emp.employee_id).map(p => ({ module: p.module, can_access: !!p.can_access }));
                const assigned_accounts = db.getEmployeeAccountAccess(emp.employee_id);
                return { ...emp, permissions, assigned_accounts };
            });
        }
        catch (err) {
            Logger_1.default.error(`[EmployeeService] getEmployeeById error: ${err.message}`);
            return null;
        }
    }
    // ─── Permissions ──────────────────────────────────────────────────
    setPermissions(employeeId, permissions) {
        try {
            return this.runOnDb((db) => {
                db.setEmployeePermissions(employeeId, permissions.map(p => ({ module: p.module, can_access: p.can_access ? 1 : 0 })));
                return { success: true };
            });
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
    getPermissions(employeeId) {
        try {
            return this.runOnDb((db) => {
                const perms = db.getEmployeePermissions(employeeId);
                const result = {};
                for (const m of ALL_MODULES)
                    result[m] = false;
                for (const p of perms)
                    result[p.module] = !!p.can_access;
                return result;
            });
        }
        catch {
            return {};
        }
    }
    hasPermission(employeeId, module) {
        const perms = this.getPermissions(employeeId);
        return !!perms[module];
    }
    // ─── Account Access ──────────────────────────────────────────────
    assignAccounts(employeeId, zaloIds) {
        try {
            return this.runOnDb((db) => {
                db.setEmployeeAccountAccess(employeeId, zaloIds);
                return { success: true };
            });
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
    getAssignedAccounts(employeeId) {
        return this.runOnDb((db) => db.getEmployeeAccountAccess(employeeId));
    }
    // ─── Auth ──────────────────────────────────────────────────────────
    async authenticate(username, password) {
        try {
            const empData = this.runOnDb((db) => {
                const emp = db.getEmployeeByUsername(username.toLowerCase().trim());
                if (!emp)
                    return { found: false };
                return { found: true, emp };
            });
            if (!empData.found)
                return { success: false, error: 'Tên đăng nhập không tồn tại' };
            const emp = empData.emp;
            if (!emp.is_active)
                return { success: false, error: 'Tài khoản đã bị vô hiệu hóa' };
            const valid = await bcrypt.compare(password, emp.password_hash);
            if (!valid)
                return { success: false, error: 'Mật khẩu không đúng' };
            return this.runOnDb((db) => {
                db.updateEmployeeLastLogin(emp.employee_id);
                const token = jwt.sign({ employee_id: emp.employee_id, username: emp.username, role: emp.role }, this.jwtSecret, { expiresIn: JWT_EXPIRES_IN });
                const permissions = db.getEmployeePermissions(emp.employee_id).map(p => ({ module: p.module, can_access: !!p.can_access }));
                const assigned_accounts = db.getEmployeeAccountAccess(emp.employee_id);
                return { success: true, token, employee: { ...emp, permissions, assigned_accounts } };
            });
        }
        catch (err) {
            Logger_1.default.error(`[EmployeeService] authenticate error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
    validateToken(token) {
        try {
            const decoded = jwt.verify(token, this.jwtSecret);
            return { valid: true, employee_id: decoded.employee_id, username: decoded.username, role: decoded.role };
        }
        catch {
            return { valid: false };
        }
    }
    // ─── Stats ─────────────────────────────────────────────────────────
    getEmployeeStats(employeeId, sinceTs, untilTs) {
        return this.runOnDb((db) => db.getEmployeeStats(employeeId, sinceTs, untilTs));
    }
    getEmployeeSessions(employeeId, limit) {
        return this.runOnDb((db) => db.getEmployeeSessions(employeeId, limit));
    }
    // ─── Static helpers ────────────────────────────────────────────────
    static get ALL_MODULES() { return ALL_MODULES; }
    // ─── Employee Groups ─────────────────────────────────────────────
    getGroups() {
        return this.runOnDb((db) => db.getEmployeeGroups());
    }
    createGroup(params) {
        try {
            if (!params.name?.trim())
                return { success: false, error: 'Tên nhóm không được để trống' };
            const group_id = (0, uuid_1.v4)();
            return this.runOnDb((db) => {
                db.createEmployeeGroup({ group_id, name: params.name.trim(), color: params.color });
                return { success: true, group: { group_id, name: params.name.trim(), color: params.color || '' } };
            });
        }
        catch (err) {
            Logger_1.default.error(`[EmployeeService] createGroup error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
    updateGroup(groupId, updates) {
        try {
            return this.runOnDb((db) => {
                db.updateEmployeeGroup(groupId, updates);
                return { success: true };
            });
        }
        catch (err) {
            Logger_1.default.error(`[EmployeeService] updateGroup error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
    deleteGroup(groupId) {
        try {
            return this.runOnDb((db) => {
                db.deleteEmployeeGroup(groupId);
                return { success: true };
            });
        }
        catch (err) {
            Logger_1.default.error(`[EmployeeService] deleteGroup error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
}
exports.default = EmployeeService;
//# sourceMappingURL=EmployeeService.js.map