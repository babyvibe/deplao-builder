import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import DatabaseService from './DatabaseService';
import Logger from '../utils/Logger';

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRES_IN = '7d';
const ALL_MODULES = ['chat', 'friends', 'crm', 'workflow', 'integration', 'analytics', 'ai_assistant', 'settings'] as const;
export type EmployeeModule = typeof ALL_MODULES[number];

export interface Employee {
    id?: number;
    employee_id: string;
    username: string;
    password_hash: string;
    display_name: string;
    avatar_url: string;
    role: 'boss' | 'employee';
    is_active: number;
    group_id: string | null;
    created_at: number;
    updated_at: number;
    last_login: number | null;
}

export interface EmployeePermission {
    module: EmployeeModule;
    can_access: boolean;
}

export interface EmployeeWithDetails extends Employee {
    permissions: EmployeePermission[];
    assigned_accounts: string[];
}

class EmployeeService {
    private static instance: EmployeeService;
    private jwtSecret: string = '';
    private pinnedDbPath: string | null = null;

    public static getInstance(): EmployeeService {
        if (!EmployeeService.instance) {
            EmployeeService.instance = new EmployeeService();
        }
        return EmployeeService.instance;
    }

    private constructor() {
        this.initJwtSecret();
    }

    private initJwtSecret(): void {
        this.runOnDb((db) => {
            const existing = db.getSetting?.('employee_jwt_secret');
            if (existing) {
                this.jwtSecret = existing;
            } else {
                this.jwtSecret = uuidv4() + '-' + uuidv4();
                db.setSetting?.('employee_jwt_secret', this.jwtSecret);
            }
        });
    }

    /**
     * Pin employee operations to the current workspace DB.
     * Called by HttpRelayService.start().
     */
    public pinToCurrentDb(): void {
        this.pinnedDbPath = DatabaseService.getInstance().getDbPath();
        Logger.log(`[EmployeeService] Pinned to DB: ${this.pinnedDbPath}`);
        this.initJwtSecret();
    }

    /** Unpin when relay stops */
    public unpinDb(): void {
        this.pinnedDbPath = null;
        Logger.log(`[EmployeeService] Unpinned DB`);
    }

    /**
     * Run a function against the correct DB (pinned or current).
     * Uses DatabaseService.withDbPath to temporarily switch if needed.
     */
    private runOnDb<T>(fn: (db: DatabaseService) => T): T {
        const db = DatabaseService.getInstance();
        if (this.pinnedDbPath && db.getDbPath() !== this.pinnedDbPath) {
            return db.withDbPath(this.pinnedDbPath, () => fn(db));
        }
        return fn(db);
    }

    // ─── CRUD ──────────────────────────────────────────────────────────

    public async createEmployee(params: {
        username: string;
        password: string;
        display_name: string;
        avatar_url?: string;
        role?: 'boss' | 'employee';
    }): Promise<{ success: boolean; employee?: EmployeeWithDetails; error?: string }> {
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
            const employee_id = uuidv4();

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
                const permissions = db.getEmployeePermissions(employee_id).map(p => ({ module: p.module as EmployeeModule, can_access: !!p.can_access }));
                const assigned_accounts = db.getEmployeeAccountAccess(employee_id);

                return { success: true, employee: { ...employee, permissions, assigned_accounts } };
            });
        } catch (err: any) {
            Logger.error(`[EmployeeService] createEmployee error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    public updateEmployee(employeeId: string, updates: {
        display_name?: string;
        avatar_url?: string;
        password?: string;
        is_active?: number;
        role?: string;
        group_id?: string | null;
    }): { success: boolean; error?: string } {
        try {
            return this.runOnDb((db) => {
                const emp = db.getEmployeeById(employeeId);
                if (!emp) return { success: false, error: 'Nhân viên không tồn tại' };

                const dbUpdates: any = {};
                if (updates.display_name !== undefined) dbUpdates.display_name = updates.display_name.trim();
                if (updates.avatar_url !== undefined) dbUpdates.avatar_url = updates.avatar_url;
                if (updates.is_active !== undefined) dbUpdates.is_active = updates.is_active;
                if (updates.role !== undefined) dbUpdates.role = updates.role;
                if (updates.group_id !== undefined) dbUpdates.group_id = updates.group_id;
                if (updates.password) {
                    dbUpdates.password_hash = bcrypt.hashSync(updates.password, BCRYPT_ROUNDS);
                }

                db.updateEmployee(employeeId, dbUpdates);
                return { success: true };
            });
        } catch (err: any) {
            Logger.error(`[EmployeeService] updateEmployee error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    public deleteEmployee(employeeId: string): { success: boolean; error?: string } {
        try {
            return this.runOnDb((db) => {
                db.deleteEmployee(employeeId);
                return { success: true };
            });
        } catch (err: any) {
            Logger.error(`[EmployeeService] deleteEmployee error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    public getEmployees(): EmployeeWithDetails[] {
        try {
            return this.runOnDb((db) => {
                const employees = db.getEmployees();
                return employees.map((emp: any) => {
                    const permissions = db.getEmployeePermissions(emp.employee_id).map(p => ({ module: p.module as EmployeeModule, can_access: !!p.can_access }));
                    const assigned_accounts = db.getEmployeeAccountAccess(emp.employee_id);
                    return { ...emp, permissions, assigned_accounts };
                });
            });
        } catch (err: any) {
            Logger.error(`[EmployeeService] getEmployees error: ${err.message}`);
            return [];
        }
    }

    public getEmployeeById(employeeId: string): EmployeeWithDetails | null {
        try {
            return this.runOnDb((db) => {
                const emp = db.getEmployeeById(employeeId);
                if (!emp) return null;
                const permissions = db.getEmployeePermissions(emp.employee_id).map(p => ({ module: p.module as EmployeeModule, can_access: !!p.can_access }));
                const assigned_accounts = db.getEmployeeAccountAccess(emp.employee_id);
                return { ...emp, permissions, assigned_accounts };
            });
        } catch (err: any) {
            Logger.error(`[EmployeeService] getEmployeeById error: ${err.message}`);
            return null;
        }
    }

    // ─── Permissions ──────────────────────────────────────────────────

    public setPermissions(employeeId: string, permissions: Array<{ module: string; can_access: boolean }>): { success: boolean; error?: string } {
        try {
            return this.runOnDb((db) => {
                db.setEmployeePermissions(employeeId, permissions.map(p => ({ module: p.module, can_access: p.can_access ? 1 : 0 })));
                return { success: true };
            });
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    public getPermissions(employeeId: string): Record<string, boolean> {
        try {
            return this.runOnDb((db) => {
                const perms = db.getEmployeePermissions(employeeId);
                const result: Record<string, boolean> = {};
                for (const m of ALL_MODULES) result[m] = false;
                for (const p of perms) result[p.module] = !!p.can_access;
                return result;
            });
        } catch {
            return {};
        }
    }

    public hasPermission(employeeId: string, module: string): boolean {
        const perms = this.getPermissions(employeeId);
        return !!perms[module];
    }

    // ─── Account Access ──────────────────────────────────────────────

    public assignAccounts(employeeId: string, zaloIds: string[]): { success: boolean; error?: string } {
        try {
            return this.runOnDb((db) => {
                db.setEmployeeAccountAccess(employeeId, zaloIds);
                return { success: true };
            });
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    public getAssignedAccounts(employeeId: string): string[] {
        return this.runOnDb((db) => db.getEmployeeAccountAccess(employeeId));
    }

    // ─── Auth ──────────────────────────────────────────────────────────

    public async authenticate(username: string, password: string): Promise<{ success: boolean; token?: string; employee?: EmployeeWithDetails; error?: string }> {
        try {
            const empData = this.runOnDb((db) => {
                const emp = db.getEmployeeByUsername(username.toLowerCase().trim());
                if (!emp) return { found: false as const };
                return { found: true as const, emp };
            });

            if (!empData.found) return { success: false, error: 'Tên đăng nhập không tồn tại' };
            const emp = empData.emp;
            if (!emp.is_active) return { success: false, error: 'Tài khoản đã bị vô hiệu hóa' };

            const valid = await bcrypt.compare(password, emp.password_hash);
            if (!valid) return { success: false, error: 'Mật khẩu không đúng' };

            return this.runOnDb((db) => {
                db.updateEmployeeLastLogin(emp.employee_id);

                const token = jwt.sign(
                    { employee_id: emp.employee_id, username: emp.username, role: emp.role },
                    this.jwtSecret,
                    { expiresIn: JWT_EXPIRES_IN }
                );

                const permissions = db.getEmployeePermissions(emp.employee_id).map(p => ({ module: p.module as EmployeeModule, can_access: !!p.can_access }));
                const assigned_accounts = db.getEmployeeAccountAccess(emp.employee_id);

                return { success: true, token, employee: { ...emp, permissions, assigned_accounts } };
            });
        } catch (err: any) {
            Logger.error(`[EmployeeService] authenticate error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    public validateToken(token: string): { valid: boolean; employee_id?: string; username?: string; role?: string } {
        try {
            const decoded = jwt.verify(token, this.jwtSecret) as any;
            return { valid: true, employee_id: decoded.employee_id, username: decoded.username, role: decoded.role };
        } catch {
            return { valid: false };
        }
    }

    // ─── Stats ─────────────────────────────────────────────────────────

    public getEmployeeStats(employeeId: string, sinceTs?: number, untilTs?: number): any {
        return this.runOnDb((db) => db.getEmployeeStats(employeeId, sinceTs, untilTs));
    }

    public getEmployeeSessions(employeeId: string, limit?: number): any[] {
        return this.runOnDb((db) => db.getEmployeeSessions(employeeId, limit));
    }

    // ─── Static helpers ────────────────────────────────────────────────

    public static get ALL_MODULES() { return ALL_MODULES; }

    // ─── Employee Groups ─────────────────────────────────────────────

    public getGroups(): any[] {
        return this.runOnDb((db) => db.getEmployeeGroups());
    }

    public createGroup(params: { name: string; color?: string }): { success: boolean; group?: any; error?: string } {
        try {
            if (!params.name?.trim()) return { success: false, error: 'Tên nhóm không được để trống' };
            const group_id = uuidv4();
            return this.runOnDb((db) => {
                db.createEmployeeGroup({ group_id, name: params.name.trim(), color: params.color });
                return { success: true, group: { group_id, name: params.name.trim(), color: params.color || '' } };
            });
        } catch (err: any) {
            Logger.error(`[EmployeeService] createGroup error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    public updateGroup(groupId: string, updates: { name?: string; color?: string; sort_order?: number }): { success: boolean; error?: string } {
        try {
            return this.runOnDb((db) => {
                db.updateEmployeeGroup(groupId, updates);
                return { success: true };
            });
        } catch (err: any) {
            Logger.error(`[EmployeeService] updateGroup error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    public deleteGroup(groupId: string): { success: boolean; error?: string } {
        try {
            return this.runOnDb((db) => {
                db.deleteEmployeeGroup(groupId);
                return { success: true };
            });
        } catch (err: any) {
            Logger.error(`[EmployeeService] deleteGroup error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
}

export default EmployeeService;

