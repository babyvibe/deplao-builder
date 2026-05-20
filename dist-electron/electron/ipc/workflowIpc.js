"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWorkflowIpc = registerWorkflowIpc;
const electron_1 = require("electron");
const DatabaseService_1 = __importDefault(require("../../src/services/DatabaseService"));
const WorkflowEngineService_1 = __importDefault(require("../../src/services/WorkflowEngineService"));
const uuid_1 = require("uuid");
const Logger_1 = __importDefault(require("../../src/utils/Logger"));
/** Helper: row → Workflow shape (pageIds array) */
function normalizeWorkflowChannel(channel) {
    return channel === 'facebook' ? 'facebook' : 'zalo';
}
function hasUnsupportedWorkflowNodes(nodes = []) {
    return nodes.some((node) => typeof node?.type === 'string' && node.type.startsWith('fb.'));
}
function rowToWorkflow(r) {
    const pageIdsRaw = r.page_ids || r.page_id || '';
    const pageIds = pageIdsRaw.split(',').filter(Boolean);
    return {
        id: r.id, name: r.name, description: r.description || '',
        enabled: r.enabled === 1 || r.enabled === true,
        channel: normalizeWorkflowChannel(r.channel),
        pageId: pageIds[0] || '',
        pageIds,
        nodes: JSON.parse(r.nodes_json || '[]'),
        edges: JSON.parse(r.edges_json || '[]'),
        createdAt: r.created_at, updatedAt: r.updated_at,
    };
}
function registerWorkflowIpc() {
    // ── Label Event bridge REMOVED — now centralized in databaseIpc.ts and zaloIpc.ts ──
    // ─── List ─────────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workflow:list', async () => {
        try {
            const rows = DatabaseService_1.default.getInstance().getWorkflows();
            return { success: true, workflows: rows.map(rowToWorkflow) };
        }
        catch (e) {
            return { success: false, error: e.message, workflows: [] };
        }
    });
    // ─── Get single ───────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workflow:get', async (_e, { id }) => {
        try {
            const row = DatabaseService_1.default.getInstance().getWorkflowById(id);
            if (!row)
                return { success: false, error: 'Not found' };
            return { success: true, workflow: rowToWorkflow(row) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Save ─────────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workflow:save', async (_e, { workflow }) => {
        try {
            const now = Date.now();
            // Normalise pageIds: accept both pageIds[] and legacy pageId string
            const pageIds = Array.isArray(workflow.pageIds)
                ? workflow.pageIds.filter(Boolean)
                : (workflow.pageId ? [workflow.pageId] : []);
            const channel = normalizeWorkflowChannel(workflow.channel);
            if (channel !== 'zalo') {
                return { success: false, error: 'Workflow Facebook hiện chưa hỗ trợ tạo hoặc lưu.' };
            }
            if (hasUnsupportedWorkflowNodes(workflow.nodes || [])) {
                return { success: false, error: 'Workflow chứa node Facebook chưa được hỗ trợ ở phiên bản hiện tại.' };
            }
            const wf = {
                id: workflow.id || (0, uuid_1.v4)(),
                name: workflow.name || 'Workflow mới',
                description: workflow.description || '',
                enabled: workflow.enabled ?? true,
                channel,
                pageId: pageIds[0] || '',
                pageIds,
                nodes: workflow.nodes || [],
                edges: workflow.edges || [],
                createdAt: workflow.createdAt || now,
                updatedAt: now,
            };
            DatabaseService_1.default.getInstance().saveWorkflow(wf);
            DatabaseService_1.default.getInstance().save();
            WorkflowEngineService_1.default.getInstance().reloadWorkflow(wf.id);
            return { success: true, id: wf.id };
        }
        catch (e) {
            Logger_1.default.error(`[WorkflowIpc] save error: ${e.message}`);
            return { success: false, error: e.message };
        }
    });
    // ─── Delete ───────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workflow:delete', async (_e, { id }) => {
        try {
            DatabaseService_1.default.getInstance().deleteWorkflow(id);
            DatabaseService_1.default.getInstance().save();
            WorkflowEngineService_1.default.getInstance().removeWorkflow(id);
            return { success: true };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Toggle ───────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workflow:toggle', async (_e, { id, enabled }) => {
        try {
            if (enabled) {
                const row = DatabaseService_1.default.getInstance().getWorkflowById(id);
                if (!row)
                    return { success: false, error: 'Not found' };
                const wf = rowToWorkflow(row);
                if (wf.channel !== 'zalo') {
                    return { success: false, error: 'Workflow Facebook hiện chưa hỗ trợ chạy.' };
                }
                if (hasUnsupportedWorkflowNodes(wf.nodes)) {
                    return { success: false, error: 'Workflow chứa node Facebook chưa được hỗ trợ chạy.' };
                }
            }
            DatabaseService_1.default.getInstance().toggleWorkflow(id, enabled);
            DatabaseService_1.default.getInstance().save();
            WorkflowEngineService_1.default.getInstance().reloadWorkflow(id);
            return { success: true };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Run manual ───────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workflow:runManual', async (_e, { id, triggerData }) => {
        try {
            const row = DatabaseService_1.default.getInstance().getWorkflowById(id);
            if (!row)
                return { success: false, error: 'Not found' };
            const wf = rowToWorkflow(row);
            const log = await WorkflowEngineService_1.default.getInstance().executeWorkflow({ ...wf, enabled: true }, triggerData || {}, 'manual');
            return { success: true, log };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Clone workflow → target page ─────────────────────────────────────────
    electron_1.ipcMain.handle('workflow:clone', async (_e, { id, targetZaloId }) => {
        try {
            const row = DatabaseService_1.default.getInstance().getWorkflowById(id);
            if (!row)
                return { success: false, error: 'Không tìm thấy workflow gốc' };
            const wf = rowToWorkflow(row);
            if (wf.channel !== 'zalo' || hasUnsupportedWorkflowNodes(wf.nodes)) {
                return { success: false, error: 'Chỉ có thể nhân bản workflow Zalo ở phiên bản hiện tại.' };
            }
            const newId = DatabaseService_1.default.getInstance().cloneWorkflow(id, targetZaloId);
            if (!newId)
                return { success: false, error: 'Không tìm thấy workflow gốc' };
            DatabaseService_1.default.getInstance().save();
            WorkflowEngineService_1.default.getInstance().reloadWorkflow(newId);
            return { success: true, newId };
        }
        catch (e) {
            Logger_1.default.error(`[WorkflowIpc] clone error: ${e.message}`);
            return { success: false, error: e.message };
        }
    });
    // ─── Clone ALL workflows from one page → another ──────────────────────────
    electron_1.ipcMain.handle('workflow:cloneAll', async (_e, { sourceZaloId, targetZaloId }) => {
        try {
            const count = DatabaseService_1.default.getInstance().cloneAllWorkflows(sourceZaloId, targetZaloId);
            DatabaseService_1.default.getInstance().save();
            // Reload engine for newly cloned workflows
            const rows = DatabaseService_1.default.getInstance().getWorkflows();
            for (const r of rows) {
                const ids = (r.page_ids || '').split(',').filter(Boolean);
                if (ids.includes(targetZaloId)) {
                    WorkflowEngineService_1.default.getInstance().reloadWorkflow(r.id);
                }
            }
            return { success: true, count };
        }
        catch (e) {
            Logger_1.default.error(`[WorkflowIpc] cloneAll error: ${e.message}`);
            return { success: false, error: e.message };
        }
    });
    // ─── Get logs ─────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workflow:getLogs', async (_e, { id, limit }) => {
        try {
            const logs = DatabaseService_1.default.getInstance().getWorkflowRunLogs(id, limit || 50);
            return { success: true, logs };
        }
        catch (e) {
            return { success: false, error: e.message, logs: [] };
        }
    });
    // ─── Delete logs ──────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workflow:deleteLogs', async (_e, { id }) => {
        try {
            const db = DatabaseService_1.default.getInstance();
            db['run'](`DELETE FROM workflow_run_logs WHERE workflow_id=?`, [id]);
            DatabaseService_1.default.getInstance().save();
            return { success: true };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
}
//# sourceMappingURL=workflowIpc.js.map