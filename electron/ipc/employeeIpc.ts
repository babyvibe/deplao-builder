import { ipcMain } from 'electron';
import EmployeeService from '../../src/services/employee/EmployeeService';
import DatabaseService from '../../src/services/database/DatabaseService';
import AppModeManager from '../../src/utils/AppModeManager';
import HttpClientService from '../../src/services/http/HttpClientService';
import HttpConnectionManager from '../../src/services/http/HttpConnectionManager';
import HttpRelayService from '../../src/services/http/HttpRelayService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';

export function registerEmployeeIpc(): void {
    const svc = () => EmployeeService.getInstance();

    // ─── CRUD ──────────────────────────────────────────────────────────

    ipcMain.handle('employee:list', async () => {
        try {
            const employees = svc().getEmployees();
            // Strip password_hash before sending to renderer
            const safe = employees.map(e => ({ ...e, password_hash: undefined }));
            return { success: true, employees: safe };
        } catch (err: any) {
            Logger.error(`[employeeIpc] list error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:getById', async (_e, { employeeId }: { employeeId: string }) => {
        try {
            const emp = svc().getEmployeeById(employeeId);
            if (!emp) return { success: false, error: 'Không tìm thấy nhân viên' };
            return { success: true, employee: { ...emp, password_hash: undefined } };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:create', async (_e, params: {
        username: string; password: string; display_name: string; avatar_url?: string; role?: 'boss' | 'employee';
    }) => {
        try {
            const result = await svc().createEmployee(params);
            if (result.employee) result.employee.password_hash = '' as any;
            return result;
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:update', async (_e, { employeeId, updates }: {
        employeeId: string; updates: { display_name?: string; avatar_url?: string; password?: string; is_active?: number; role?: string; group_id?: string | null };
    }) => {
        try {
            const result = svc().updateEmployee(employeeId, updates);
            if (result.success) {
                // Khoá / đổi mật khẩu: EmployeeService đã thu hồi token — ngắt luôn phiên đang mở (báo lý do cho nhân viên)
                const disabled = updates?.is_active !== undefined && !Number(updates.is_active);
                if (disabled) {
                    HttpRelayService.getInstance().terminateEmployeeSession(employeeId, 'Tài khoản đã bị vô hiệu hóa');
                } else if (updates?.password) {
                    HttpRelayService.getInstance().terminateEmployeeSession(employeeId, 'Mật khẩu đã được thay đổi — vui lòng đăng nhập lại');
                }
            }
            return result;
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:delete', async (_e, { employeeId }: { employeeId: string }) => {
        try {
            const result = svc().deleteEmployee(employeeId);
            if (result.success) HttpRelayService.getInstance().terminateEmployeeSession(employeeId, 'Tài khoản đã bị xóa');
            return result;
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Đăng xuất tất cả nhân viên (chỉ máy Boss) ──────────────────────
    // Đổi khoá ký token → mọi nhân viên (đang nối hay không) phải đăng nhập lại bằng mật khẩu.
    ipcMain.handle('employee:logoutAll', async (e) => {
        // Chỉ renderer của chính máy này — proxy cũ của nhân viên (/api/proxy/action) gọi handler với event = null
        if (!e?.sender) return { success: false, error: 'Không được phép' };
        try {
            const relay = HttpRelayService.getInstance();
            if (WorkspaceManager.getInstance().isActiveRemote() && !relay.isRunning()) {
                return { success: false, error: 'Chỉ dùng trên máy quản lý (BOSS)' };
            }
            return relay.logoutAllEmployees();
        } catch (err: any) {
            Logger.error(`[employeeIpc] logoutAll error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Permissions ──────────────────────────────────────────────────

    ipcMain.handle('employee:setPermissions', async (_e, { employeeId, permissions }: {
        employeeId: string; permissions: Array<{ module: string; can_access: boolean }>;
    }) => {
        try {
            const result = svc().setPermissions(employeeId, permissions);
            Logger.log(`[employeeIpc] setPermissions → employee=${employeeId} permissions=${permissions.length} success=${result.success}`);
            if (result.success) {
                // Auto-create ERP profile when erp module is enabled
                const erpPerm = permissions.find(p => p.module === 'erp');
                if (erpPerm?.can_access) {
                    try {
                        const db = DatabaseService.getInstance();
                        const existing = db.queryOne(`SELECT 1 FROM erp_employee_profiles WHERE employee_id = ?`, [employeeId]);
                        if (!existing) {
                            db.run(
                                `INSERT OR IGNORE INTO erp_employee_profiles (employee_id, erp_role, extra_json, updated_at)
                                 VALUES (?, 'member', '{}', ?)`,
                                [employeeId, Date.now()]
                            );
                            Logger.log(`[employeeIpc] Auto-created ERP profile for employee ${employeeId} with role 'member'`);
                        }
                    } catch (erpErr: any) {
                        Logger.warn(`[employeeIpc] Failed to auto-create ERP profile: ${erpErr.message}`);
                    }
                }
                HttpRelayService.getInstance().refreshEmployeeState(employeeId, 'permissions-updated');
            }
            return result;
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:getPermissions', async (_e, { employeeId }: { employeeId: string }) => {
        try {
            const perms = svc().getPermissions(employeeId);
            return { success: true, permissions: perms };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Account Access ──────────────────────────────────────────────

    ipcMain.handle('employee:assignAccounts', async (_e, { employeeId, zaloIds }: {
        employeeId: string; zaloIds: string[];
    }) => {
        try {
            const result = svc().assignAccounts(employeeId, zaloIds);
            Logger.log(`[employeeIpc] assignAccounts → employee=${employeeId} assigned=${zaloIds.length} success=${result.success} zaloIds=${JSON.stringify(zaloIds)}`);
            if (result.success) {
                HttpRelayService.getInstance().updateEmployeeRooms(employeeId, zaloIds);
                HttpRelayService.getInstance().refreshEmployeeState(employeeId, 'accounts-assigned');
            }
            return result;
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:getAssignedAccounts', async (_e, { employeeId }: { employeeId: string }) => {
        try {
            const accounts = svc().getAssignedAccounts(employeeId);
            return { success: true, accounts };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Stats ─────────────────────────────────────────────────────────

    ipcMain.handle('employee:getStats', async (_e, { employeeId, sinceTs, untilTs }: {
        employeeId: string; sinceTs?: number; untilTs?: number;
    }) => {
        try {
            const stats = svc().getEmployeeStats(employeeId, sinceTs, untilTs);
            return { success: true, stats };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:getSessions', async (_e, { employeeId, limit }: {
        employeeId: string; limit?: number;
    }) => {
        try {
            const sessions = svc().getEmployeeSessions(employeeId, limit);
            return { success: true, sessions };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Auth (for employee login on employee machines) ──────────────

    ipcMain.handle('employee:login', async (_e, { username, password }: { username: string; password: string }) => {
        try {
            const result = await svc().authenticate(username, password);
            if (result.employee) result.employee.password_hash = '' as any;
            return result;
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:validateToken', async (_e, { token }: { token: string }) => {
        try {
            return svc().validateToken(token);
        } catch (err: any) {
            return { valid: false, error: err.message };
        }
    });

    // ─── Mode Management ──────────────────────────────────────────────

    ipcMain.handle('employee:setMode', async (_e, { mode }: { mode: 'standalone' | 'boss' | 'employee' }) => {
        try {
            AppModeManager.getInstance().setMode(mode);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:getMode', async () => {
        return { mode: AppModeManager.getInstance().getMode() };
    });

    // ─── HTTP Client (Employee side) ────────────────────────────────
    // Kết nối / ngắt Boss đi qua remote workspace (workspace:loginRemote → workspace:connectRemote / disconnectRemote).
    // employee:connectToBoss / disconnectFromBoss (kết nối dưới workspace đang active, không lưu gì) đã bỏ.

    ipcMain.handle('employee:getConnectionStatus', async () => {
        // Return status for the active workspace connection (or legacy singleton)
        const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
        if (activeWs?.type === 'remote') {
            return HttpConnectionManager.getInstance().getStatus(activeWs.id);
        }
        return HttpClientService.getInstance().getStatus();
    });

    ipcMain.handle('employee:proxyAction', async (_e, { channel, params }: { channel: string; params: any }) => {
        try {
            const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
            if (activeWs?.type === 'remote') {
                return await HttpConnectionManager.getInstance().proxyAction(activeWs.id, channel, params);
            }
            return await HttpClientService.getInstance().proxyAction(channel, params);
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Employee Groups ────────────────────────────────────────────────

    ipcMain.handle('employee:listGroups', async () => {
        try {
            const groups = svc().getGroups();
            return { success: true, groups };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:createGroup', async (_e, { name, color }: { name: string; color?: string }) => {
        try {
            return svc().createGroup({ name, color });
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:updateGroup', async (_e, { groupId, updates }: { groupId: string; updates: { name?: string; color?: string; sort_order?: number } }) => {
        try {
            return svc().updateGroup(groupId, updates);
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('employee:deleteGroup', async (_e, { groupId }: { groupId: string }) => {
        try {
            return svc().deleteGroup(groupId);
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Employee Analytics (Advanced) ───────────────────────────────

    // zaloIds (Reports account filter): only activity on these accounts; omitted = every account.
    // Online hours come from login sessions, which are not per account.
    ipcMain.handle('employee:analytics:comparison', async (_e, { sinceTs, untilTs, zaloIds }: { sinceTs: number; untilTs: number; zaloIds?: string[] }) => {
        try {
            const data = DatabaseService.getInstance().getEmployeeComparison(sinceTs, untilTs, Array.isArray(zaloIds) ? zaloIds.map(String) : undefined);
            return { success: true, data };
        } catch (err: any) {
            return { success: false, error: err.message, data: [] };
        }
    });

    ipcMain.handle('employee:analytics:messageTimeline', async (_e, { sinceTs, untilTs, zaloIds }: { sinceTs: number; untilTs: number; zaloIds?: string[] }) => {
        try {
            const data = DatabaseService.getInstance().getEmployeeMessageTimeline(sinceTs, untilTs, Array.isArray(zaloIds) ? zaloIds.map(String) : undefined);
            return { success: true, data };
        } catch (err: any) {
            return { success: false, error: err.message, data: [] };
        }
    });

    ipcMain.handle('employee:analytics:onlineTimeline', async (_e, { sinceTs, untilTs }: { sinceTs: number; untilTs: number }) => {
        try {
            const data = DatabaseService.getInstance().getEmployeeOnlineTimeline(sinceTs, untilTs);
            return { success: true, data };
        } catch (err: any) {
            return { success: false, error: err.message, data: [] };
        }
    });

    ipcMain.handle('employee:analytics:responseDistribution', async (_e, { sinceTs, untilTs, zaloIds }: { sinceTs: number; untilTs: number; zaloIds?: string[] }) => {
        try {
            const data = DatabaseService.getInstance().getEmployeeResponseDistribution(sinceTs, untilTs, Array.isArray(zaloIds) ? zaloIds.map(String) : undefined);
            return { success: true, data };
        } catch (err: any) {
            return { success: false, error: err.message, data: [] };
        }
    });

    ipcMain.handle('employee:analytics:hourlyActivity', async (_e, { sinceTs, untilTs, zaloIds }: { sinceTs: number; untilTs: number; zaloIds?: string[] }) => {
        try {
            const data = DatabaseService.getInstance().getEmployeeHourlyActivity(sinceTs, untilTs, Array.isArray(zaloIds) ? zaloIds.map(String) : undefined);
            return { success: true, data };
        } catch (err: any) {
            return { success: false, error: err.message, data: [] };
        }
    });

    Logger.log('[employeeIpc] Registered 27 employee IPC channels');
}
