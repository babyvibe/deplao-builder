"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerEmployeeIpc = registerEmployeeIpc;
const electron_1 = require("electron");
const EmployeeService_1 = __importDefault(require("../../src/services/EmployeeService"));
const DatabaseService_1 = __importDefault(require("../../src/services/DatabaseService"));
const AppModeManager_1 = __importDefault(require("../../src/utils/AppModeManager"));
const HttpClientService_1 = __importDefault(require("../../src/services/HttpClientService"));
const HttpConnectionManager_1 = __importDefault(require("../../src/services/HttpConnectionManager"));
const HttpRelayService_1 = __importDefault(require("../../src/services/HttpRelayService"));
const WorkspaceManager_1 = __importDefault(require("../../src/utils/WorkspaceManager"));
const Logger_1 = __importDefault(require("../../src/utils/Logger"));
function registerEmployeeIpc() {
    const svc = () => EmployeeService_1.default.getInstance();
    // ─── CRUD ──────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('employee:list', async () => {
        try {
            const employees = svc().getEmployees();
            // Strip password_hash before sending to renderer
            const safe = employees.map(e => ({ ...e, password_hash: undefined }));
            return { success: true, employees: safe };
        }
        catch (err) {
            Logger_1.default.error(`[employeeIpc] list error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:getById', async (_e, { employeeId }) => {
        try {
            const emp = svc().getEmployeeById(employeeId);
            if (!emp)
                return { success: false, error: 'Không tìm thấy nhân viên' };
            return { success: true, employee: { ...emp, password_hash: undefined } };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:create', async (_e, params) => {
        try {
            const result = await svc().createEmployee(params);
            if (result.employee)
                result.employee.password_hash = '';
            return result;
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:update', async (_e, { employeeId, updates }) => {
        try {
            return svc().updateEmployee(employeeId, updates);
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:delete', async (_e, { employeeId }) => {
        try {
            return svc().deleteEmployee(employeeId);
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ─── Permissions ──────────────────────────────────────────────────
    electron_1.ipcMain.handle('employee:setPermissions', async (_e, { employeeId, permissions }) => {
        try {
            const result = svc().setPermissions(employeeId, permissions);
            Logger_1.default.log(`[employeeIpc] setPermissions → employee=${employeeId} permissions=${permissions.length} success=${result.success}`);
            if (result.success) {
                HttpRelayService_1.default.getInstance().refreshEmployeeState(employeeId, 'permissions-updated');
            }
            return result;
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:getPermissions', async (_e, { employeeId }) => {
        try {
            const perms = svc().getPermissions(employeeId);
            return { success: true, permissions: perms };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ─── Account Access ──────────────────────────────────────────────
    electron_1.ipcMain.handle('employee:assignAccounts', async (_e, { employeeId, zaloIds }) => {
        try {
            const result = svc().assignAccounts(employeeId, zaloIds);
            Logger_1.default.log(`[employeeIpc] assignAccounts → employee=${employeeId} assigned=${zaloIds.length} success=${result.success} zaloIds=${JSON.stringify(zaloIds)}`);
            if (result.success) {
                HttpRelayService_1.default.getInstance().updateEmployeeRooms(employeeId, zaloIds);
                HttpRelayService_1.default.getInstance().refreshEmployeeState(employeeId, 'accounts-assigned');
            }
            return result;
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:getAssignedAccounts', async (_e, { employeeId }) => {
        try {
            const accounts = svc().getAssignedAccounts(employeeId);
            return { success: true, accounts };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ─── Stats ─────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('employee:getStats', async (_e, { employeeId, sinceTs, untilTs }) => {
        try {
            const stats = svc().getEmployeeStats(employeeId, sinceTs, untilTs);
            return { success: true, stats };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:getSessions', async (_e, { employeeId, limit }) => {
        try {
            const sessions = svc().getEmployeeSessions(employeeId, limit);
            return { success: true, sessions };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ─── Auth (for employee login on employee machines) ──────────────
    electron_1.ipcMain.handle('employee:login', async (_e, { username, password }) => {
        try {
            const result = await svc().authenticate(username, password);
            if (result.employee)
                result.employee.password_hash = '';
            return result;
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:validateToken', async (_e, { token }) => {
        try {
            return svc().validateToken(token);
        }
        catch (err) {
            return { valid: false, error: err.message };
        }
    });
    // ─── Mode Management ──────────────────────────────────────────────
    electron_1.ipcMain.handle('employee:setMode', async (_e, { mode }) => {
        try {
            AppModeManager_1.default.getInstance().setMode(mode);
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:getMode', async () => {
        return { mode: AppModeManager_1.default.getInstance().getMode() };
    });
    // ─── HTTP Client (Employee side) ────────────────────────────────
    electron_1.ipcMain.handle('employee:connectToBoss', async (_e, { bossUrl, token }) => {
        try {
            AppModeManager_1.default.getInstance().setMode('employee');
            // Workspace-aware: register connection under the active workspace ID
            const activeWs = WorkspaceManager_1.default.getInstance().getActiveWorkspace();
            const wsId = activeWs?.id || 'legacy';
            const result = await HttpConnectionManager_1.default.getInstance().connect(wsId, bossUrl, token);
            // Also update legacy singleton for backward compat with old callers
            if (!result.success) {
                AppModeManager_1.default.getInstance().setMode('standalone');
            }
            return result;
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:disconnectFromBoss', async () => {
        try {
            // Disconnect the active workspace's connection
            const activeWs = WorkspaceManager_1.default.getInstance().getActiveWorkspace();
            if (activeWs) {
                HttpConnectionManager_1.default.getInstance().disconnect(activeWs.id);
            }
            // Also disconnect legacy singleton
            HttpClientService_1.default.getInstance().disconnect();
            AppModeManager_1.default.getInstance().setMode('standalone');
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:getConnectionStatus', async () => {
        // Return status for the active workspace connection (or legacy singleton)
        const activeWs = WorkspaceManager_1.default.getInstance().getActiveWorkspace();
        if (activeWs?.type === 'remote') {
            return HttpConnectionManager_1.default.getInstance().getStatus(activeWs.id);
        }
        return HttpClientService_1.default.getInstance().getStatus();
    });
    electron_1.ipcMain.handle('employee:proxyAction', async (_e, { channel, params }) => {
        try {
            const activeWs = WorkspaceManager_1.default.getInstance().getActiveWorkspace();
            if (activeWs?.type === 'remote') {
                return await HttpConnectionManager_1.default.getInstance().proxyAction(activeWs.id, channel, params);
            }
            return await HttpClientService_1.default.getInstance().proxyAction(channel, params);
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ─── Employee Groups ────────────────────────────────────────────────
    electron_1.ipcMain.handle('employee:listGroups', async () => {
        try {
            const groups = svc().getGroups();
            return { success: true, groups };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:createGroup', async (_e, { name, color }) => {
        try {
            return svc().createGroup({ name, color });
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:updateGroup', async (_e, { groupId, updates }) => {
        try {
            return svc().updateGroup(groupId, updates);
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('employee:deleteGroup', async (_e, { groupId }) => {
        try {
            return svc().deleteGroup(groupId);
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ─── Employee Analytics (Advanced) ───────────────────────────────
    electron_1.ipcMain.handle('employee:analytics:comparison', async (_e, { sinceTs, untilTs }) => {
        try {
            const data = DatabaseService_1.default.getInstance().getEmployeeComparison(sinceTs, untilTs);
            return { success: true, data };
        }
        catch (err) {
            return { success: false, error: err.message, data: [] };
        }
    });
    electron_1.ipcMain.handle('employee:analytics:messageTimeline', async (_e, { sinceTs, untilTs }) => {
        try {
            const data = DatabaseService_1.default.getInstance().getEmployeeMessageTimeline(sinceTs, untilTs);
            return { success: true, data };
        }
        catch (err) {
            return { success: false, error: err.message, data: [] };
        }
    });
    electron_1.ipcMain.handle('employee:analytics:onlineTimeline', async (_e, { sinceTs, untilTs }) => {
        try {
            const data = DatabaseService_1.default.getInstance().getEmployeeOnlineTimeline(sinceTs, untilTs);
            return { success: true, data };
        }
        catch (err) {
            return { success: false, error: err.message, data: [] };
        }
    });
    electron_1.ipcMain.handle('employee:analytics:responseDistribution', async (_e, { sinceTs, untilTs }) => {
        try {
            const data = DatabaseService_1.default.getInstance().getEmployeeResponseDistribution(sinceTs, untilTs);
            return { success: true, data };
        }
        catch (err) {
            return { success: false, error: err.message, data: [] };
        }
    });
    electron_1.ipcMain.handle('employee:analytics:hourlyActivity', async (_e, { sinceTs, untilTs }) => {
        try {
            const data = DatabaseService_1.default.getInstance().getEmployeeHourlyActivity(sinceTs, untilTs);
            return { success: true, data };
        }
        catch (err) {
            return { success: false, error: err.message, data: [] };
        }
    });
    Logger_1.default.log('[employeeIpc] Registered 26 employee IPC channels');
}
//# sourceMappingURL=employeeIpc.js.map