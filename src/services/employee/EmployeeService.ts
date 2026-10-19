import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';
import type { Employee, EmployeePermission, EmployeeWithDetails, EmployeeModule } from '../../models';
import { LOGIN_WRONG_PASSWORD_CODE } from '../../shared/employeeConnection';
import {
    JWT_SECRET_SETTING_KEY,
    JWT_SECRET_VERSION,
    JWT_SECRET_VERSION_SETTING_KEY,
    evaluateEmployeeToken,
    generateJwtSecret,
    nextRevocationMark,
    parseValidAfter,
    planJwtSecretInit,
    signEmployeeToken,
    tokenIssueTimestamp,
    tokenLastIssuedKey,
    tokenValidAfterKey,
    verifyEmployeeJwt,
    type EmployeeTokenState,
    type EmployeeTokenValidation,
} from './employeeTokenPolicy';

const BCRYPT_ROUNDS = 12;
const ALL_MODULES = ['chat', 'friends', 'crm', 'workflow', 'integration', 'analytics', 'ai_assistant', 'settings'] as const;
/** Trạng thái xét token (tồn tại / bật / mốc thu hồi) cache ngần này — validateToken chạy cho MỌI request của nhân viên. */
const TOKEN_STATE_TTL_MS = 5_000;

class EmployeeService {
    private static instance: EmployeeService;
    private jwtSecret: string = '';
    private pinnedDbPath: string | null = null;
    /** employeeId → trạng thái xét token + lúc đọc. Mọi thao tác ghi (thu hồi / khoá / xoá / đổi khoá) xoá ngay. */
    private tokenStateCache = new Map<string, { state: EmployeeTokenState; at: number }>();

    public static getInstance(): EmployeeService {
        if (!EmployeeService.instance) {
            EmployeeService.instance = new EmployeeService();
        }
        return EmployeeService.instance;
    }

    private constructor() {
        this.initJwtSecret();
    }

    /**
     * Nạp khoá ký token nhân viên của DB đang dùng (pinned / hiện tại). Khoá chưa có phiên bản từng đọc được qua API cài
     * đặt của nhân viên → đổi MỘT lần cho mỗi DB (dấu employee_jwt_secret_version ghi cùng DB, cùng transaction):
     * mọi nhân viên đăng nhập lại một lần. Gọi ở constructor và mỗi lần pinToCurrentDb() — lần sau thấy dấu thì giữ khoá.
     */
    private initJwtSecret(): void {
        try {
            this.runOnDb((db) => {
                const existing = db.getSetting?.(JWT_SECRET_SETTING_KEY) || '';
                const plan = planJwtSecretInit(existing, db.getSetting?.(JWT_SECRET_VERSION_SETTING_KEY));
                if (plan === 'keep') {
                    this.jwtSecret = existing;
                    return;
                }
                const secret = generateJwtSecret();
                try {
                    db.transaction(() => {
                        db.setSetting(JWT_SECRET_SETTING_KEY, secret);
                        db.setSetting(JWT_SECRET_VERSION_SETTING_KEY, String(JWT_SECRET_VERSION));
                    });
                } catch (err: any) {
                    // Không ghi được (DB chưa sẵn sàng / lỗi): giữ khoá đang có — lần pin / khởi động sau thử lại
                    Logger.error(`[EmployeeService] Không lưu được khoá ký token mới (${plan}): ${err.message}`);
                    this.jwtSecret = existing;
                    return;
                }
                this.jwtSecret = secret;
                if (plan === 'rotate') {
                    Logger.warn(`[EmployeeService] 🔐 Đã đổi khoá ký token nhân viên (khoá cũ có thể đã lộ) — mọi nhân viên phải đăng nhập lại một lần. DB: ${db.getDbPath()}`);
                } else {
                    Logger.log(`[EmployeeService] Đã tạo khoá ký token nhân viên. DB: ${db.getDbPath()}`);
                }
            });
        } catch (err: any) {
            Logger.error(`[EmployeeService] initJwtSecret error: ${err.message}`);
        }
        this.tokenStateCache.clear();
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
        this.tokenStateCache.clear();
        Logger.log(`[EmployeeService] Unpinned DB`);
    }

    /**
     * Run a function against the correct DB (pinned or current).
     * Uses DatabaseService.withDbPath to temporarily switch if needed.
     */
    private runOnDb<T>(fn: (db: DatabaseService) => T): T {
        const db = DatabaseService.getInstance();
        if (this.pinnedDbPath && db.getDbPath() !== this.pinnedDbPath) {
            // Safety: if pinned directory was deleted, unpin and fall back to current DB
            try {
                const dir = require('path').dirname(this.pinnedDbPath);
                if (!require('fs').existsSync(dir)) {
                    Logger.warn(`[EmployeeService] Pinned DB directory missing (${dir}), unpinning`);
                    this.pinnedDbPath = null;
                    return fn(db);
                }
            } catch {}
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
            const result = this.runOnDb((db) => {
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
            if (result.success) {
                this.tokenStateCache.delete(employeeId);
                // Khoá tài khoản / đổi mật khẩu → token đang có hết hiệu lực ngay (kể cả khi mở khoá lại sau này).
                // Phiên đang mở (Socket.IO, đăng ký relay) do HttpRelayService.terminateEmployeeSession ngắt.
                const disabled = updates.is_active !== undefined && !Number(updates.is_active);
                if (disabled || updates.password) this.revokeEmployeeTokens(employeeId);
            }
            return result;
        } catch (err: any) {
            Logger.error(`[EmployeeService] updateEmployee error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    public deleteEmployee(employeeId: string): { success: boolean; error?: string } {
        try {
            const result = this.runOnDb((db) => {
                db.deleteEmployee(employeeId);
                return { success: true };
            });
            // Nhân viên không còn thì validateToken đã từ chối — vẫn dời mốc thu hồi cho chắc (cũng xoá cache trạng thái)
            this.revokeEmployeeTokens(employeeId);
            return result;
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

    public async authenticate(username: string, password: string): Promise<{ success: boolean; token?: string; employee?: EmployeeWithDetails; error?: string; code?: string }> {
        try {
            if (!this.jwtSecret) this.initJwtSecret();
            const empData = this.runOnDb((db) => {
                const emp = db.getEmployeeByUsername(username.toLowerCase().trim());
                if (!emp) return { found: false as const };
                return { found: true as const, emp };
            });

            if (!empData.found) return { success: false, error: 'Tên đăng nhập không tồn tại', code: 'USER_NOT_FOUND' };
            const emp = empData.emp;
            if (!emp.is_active) return { success: false, error: 'Tài khoản đã bị vô hiệu hóa', code: 'EMPLOYEE_INACTIVE' };

            const valid = await bcrypt.compare(password, emp.password_hash);
            if (!valid) return { success: false, error: 'Mật khẩu không đúng', code: LOGIN_WRONG_PASSWORD_CODE };

            return this.runOnDb((db) => {
                // Trong lúc bcrypt chạy (~0,3 s) quản lý có thể vừa khoá / xoá / đổi mật khẩu → đọc lại trước khi ký
                const current = db.getEmployeeById(emp.employee_id);
                if (!current) return { success: false, error: 'Tên đăng nhập không tồn tại', code: 'USER_NOT_FOUND' };
                if (!current.is_active) return { success: false, error: 'Tài khoản đã bị vô hiệu hóa', code: 'EMPLOYEE_INACTIVE' };
                if (current.password_hash !== emp.password_hash) {
                    return { success: false, error: 'Mật khẩu không đúng', code: LOGIN_WRONG_PASSWORD_CODE };
                }

                db.updateEmployeeLastLogin(emp.employee_id);

                // ts luôn sau mốc thu hồi (đăng nhập lại ngay sau khi bị kick vẫn hợp lệ); nhớ ts lớn nhất đã cấp để
                // lần thu hồi sau phủ được token này kể cả khi đồng hồ Boss bị chỉnh lùi.
                const issuedAt = tokenIssueTimestamp(parseValidAfter(db.getSetting(tokenValidAfterKey(emp.employee_id))), Date.now());
                const lastIssuedKey = tokenLastIssuedKey(emp.employee_id);
                if (issuedAt > parseValidAfter(db.getSetting(lastIssuedKey))) db.setSetting(lastIssuedKey, String(issuedAt));
                this.tokenStateCache.delete(emp.employee_id);

                const token = signEmployeeToken(
                    this.jwtSecret,
                    { employee_id: emp.employee_id, username: emp.username, role: emp.role },
                    issuedAt,
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

    /**
     * Xác thực token nhân viên (REST, heartbeat, bắt tay Socket.IO, API v1): chữ ký HS256 + hạn, nhân viên còn tồn tại
     * và đang bật, phát hành sau mốc thu hồi (quy tắc: employeeTokenPolicy.ts). Trạng thái DB cache TOKEN_STATE_TTL_MS;
     * thu hồi / khoá / xoá / đổi khoá xoá cache ngay. Không hợp lệ → `reason` (expired | revoked | inactive | invalid |
     * unavailable).
     */
    public validateToken(token: string): EmployeeTokenValidation {
        if (!this.jwtSecret) this.initJwtSecret();
        const verified = verifyEmployeeJwt(token, this.jwtSecret);
        if (verified.ok === false) return { valid: false, reason: verified.reason };
        const claims = verified.claims;
        const employeeId = typeof claims.employee_id === 'string' ? claims.employee_id : '';
        const decision = evaluateEmployeeToken(claims, employeeId ? this.getTokenState(employeeId) : null);
        if (decision.valid === false) return { valid: false, reason: decision.reason };
        return {
            valid: true,
            employee_id: decision.employeeId,
            username: typeof claims.username === 'string' ? claims.username : undefined,
            role: typeof claims.role === 'string' ? claims.role : undefined,
        };
    }

    /** Trạng thái xét token của một nhân viên (cache vài giây). null = không đọc được DB và chưa từng biết. */
    private getTokenState(employeeId: string): EmployeeTokenState | null {
        const now = Date.now();
        const cached = this.tokenStateCache.get(employeeId);
        if (cached && now - cached.at < TOKEN_STATE_TTL_MS) return cached.state;
        try {
            const state = this.runOnDb((db): EmployeeTokenState => {
                const emp = db.getEmployeeById(employeeId);
                return {
                    exists: !!emp,
                    active: !!emp?.is_active,
                    validAfterMs: parseValidAfter(db.getSetting(tokenValidAfterKey(employeeId))),
                };
            });
            if (this.tokenStateCache.size >= 500) this.tokenStateCache.clear();
            this.tokenStateCache.set(employeeId, { state, at: now });
            return state;
        } catch (err: any) {
            Logger.warn(`[EmployeeService] Không đọc được trạng thái token của nhân viên ${employeeId}: ${err.message}`);
            // Lỗi DB thoáng qua: dùng trạng thái vừa biết thay vì đá mọi nhân viên đang làm việc
            return cached?.state ?? null;
        }
    }

    /**
     * Thu hồi mọi token đang có của nhân viên (kick / khoá / xoá / đổi mật khẩu): dời mốc "hợp lệ từ" lên bây giờ.
     * Đăng nhập lại bằng mật khẩu được token mới (phát hành sau mốc) — trừ khi tài khoản đã bị khoá / xoá.
     */
    public revokeEmployeeTokens(employeeId: string): { success: boolean; validAfter?: number; error?: string } {
        if (!employeeId) return { success: false, error: 'Thiếu employeeId' };
        try {
            const validAfter = this.runOnDb((db) => {
                const key = tokenValidAfterKey(employeeId);
                const mark = nextRevocationMark(
                    parseValidAfter(db.getSetting(key)),
                    Date.now(),
                    parseValidAfter(db.getSetting(tokenLastIssuedKey(employeeId))),
                );
                db.setSetting(key, String(mark));
                return mark;
            });
            Logger.log(`[EmployeeService] 🔒 Thu hồi token của nhân viên ${employeeId} (token phát hành tới ${new Date(validAfter).toISOString()} hết hiệu lực)`);
            return { success: true, validAfter };
        } catch (err: any) {
            Logger.error(`[EmployeeService] revokeEmployeeTokens error: ${err.message}`);
            return { success: false, error: err.message };
        } finally {
            this.tokenStateCache.delete(employeeId);
        }
    }

    /**
     * Đổi khoá ký → MỌI token nhân viên đang có sai chữ ký, ai cũng phải đăng nhập lại bằng mật khẩu.
     * Dùng cho "Đăng xuất tất cả nhân viên" (HttpRelayService.logoutAllEmployees ngắt các phiên đang mở).
     */
    public rotateJwtSecret(): { success: boolean; error?: string } {
        try {
            const secret = generateJwtSecret();
            const saved = this.runOnDb((db) => {
                db.transaction(() => {
                    db.setSetting(JWT_SECRET_SETTING_KEY, secret);
                    db.setSetting(JWT_SECRET_VERSION_SETTING_KEY, String(JWT_SECRET_VERSION));
                });
                return db.getSetting(JWT_SECRET_SETTING_KEY) === secret;
            });
            if (!saved) return { success: false, error: 'Không lưu được khoá ký mới (cơ sở dữ liệu chưa sẵn sàng)' };
            this.jwtSecret = secret;
            this.tokenStateCache.clear();
            Logger.warn('[EmployeeService] 🔐 Đã đổi khoá ký token nhân viên — mọi phiên đăng nhập cũ hết hiệu lực');
            return { success: true };
        } catch (err: any) {
            Logger.error(`[EmployeeService] rotateJwtSecret error: ${err.message}`);
            return { success: false, error: err.message };
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

