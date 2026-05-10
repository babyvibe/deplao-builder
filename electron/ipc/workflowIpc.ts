import { ipcMain } from 'electron';
import DatabaseService from '../../src/services/DatabaseService';
import WorkflowEngineService, { Workflow, WorkflowChannel } from '../../src/services/WorkflowEngineService';
import { v4 as uuidv4 } from 'uuid';
import Logger from '../../src/utils/Logger';

/** Helper: row → Workflow shape (pageIds array) */
function normalizeWorkflowChannel(channel?: string): WorkflowChannel {
    return channel === 'facebook' ? 'facebook' : 'zalo';
}

function hasUnsupportedWorkflowNodes(nodes: any[] = []): boolean {
    return nodes.some((node: any) => typeof node?.type === 'string' && node.type.startsWith('fb.'));
}

function rowToWorkflow(r: any): Workflow {
    const pageIdsRaw: string = r.page_ids || r.page_id || '';
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

export function registerWorkflowIpc(): void {

    // ── Label Event bridge REMOVED — now centralized in databaseIpc.ts and zaloIpc.ts ──

    // ─── List ─────────────────────────────────────────────────────────────────
    ipcMain.handle('workflow:list', async () => {
        try {
            const rows = DatabaseService.getInstance().getWorkflows();
            return { success: true, workflows: rows.map(rowToWorkflow) };
        } catch (e: any) {
            return { success: false, error: e.message, workflows: [] };
        }
    });

    // ─── Get single ───────────────────────────────────────────────────────────
    ipcMain.handle('workflow:get', async (_e, { id }: { id: string }) => {
        try {
            const row = DatabaseService.getInstance().getWorkflowById(id);
            if (!row) return { success: false, error: 'Not found' };
            return { success: true, workflow: rowToWorkflow(row) };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // ─── Save ─────────────────────────────────────────────────────────────────
    ipcMain.handle('workflow:save', async (_e, { workflow }: { workflow: Partial<Workflow> }) => {
        try {
            const now = Date.now();
            // Normalise pageIds: accept both pageIds[] and legacy pageId string
            const pageIds: string[] = Array.isArray(workflow.pageIds)
                ? workflow.pageIds.filter(Boolean)
                : (workflow.pageId ? [workflow.pageId] : []);
            const channel = normalizeWorkflowChannel((workflow as any).channel);
            if (channel !== 'zalo') {
                return { success: false, error: 'Workflow Facebook hiện chưa hỗ trợ tạo hoặc lưu.' };
            }
            if (hasUnsupportedWorkflowNodes(workflow.nodes || [])) {
                return { success: false, error: 'Workflow chứa node Facebook chưa được hỗ trợ ở phiên bản hiện tại.' };
            }
            const wf: Workflow = {
                id: workflow.id || uuidv4(),
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
            DatabaseService.getInstance().saveWorkflow(wf);
            DatabaseService.getInstance().save();
            WorkflowEngineService.getInstance().reloadWorkflow(wf.id);
            return { success: true, id: wf.id };
        } catch (e: any) {
            Logger.error(`[WorkflowIpc] save error: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    // ─── Delete ───────────────────────────────────────────────────────────────
    ipcMain.handle('workflow:delete', async (_e, { id }: { id: string }) => {
        try {
            DatabaseService.getInstance().deleteWorkflow(id);
            DatabaseService.getInstance().save();
            WorkflowEngineService.getInstance().removeWorkflow(id);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // ─── Toggle ───────────────────────────────────────────────────────────────
    ipcMain.handle('workflow:toggle', async (_e, { id, enabled }: { id: string; enabled: boolean }) => {
        try {
            if (enabled) {
                const row = DatabaseService.getInstance().getWorkflowById(id);
                if (!row) return { success: false, error: 'Not found' };
                const wf = rowToWorkflow(row);
                if (wf.channel !== 'zalo') {
                    return { success: false, error: 'Workflow Facebook hiện chưa hỗ trợ chạy.' };
                }
                if (hasUnsupportedWorkflowNodes(wf.nodes)) {
                    return { success: false, error: 'Workflow chứa node Facebook chưa được hỗ trợ chạy.' };
                }
            }
            DatabaseService.getInstance().toggleWorkflow(id, enabled);
            DatabaseService.getInstance().save();
            WorkflowEngineService.getInstance().reloadWorkflow(id);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // ─── Run manual ───────────────────────────────────────────────────────────
    ipcMain.handle('workflow:runManual', async (_e, { id, triggerData }: { id: string; triggerData?: any }) => {
        try {
            const row = DatabaseService.getInstance().getWorkflowById(id);
            if (!row) return { success: false, error: 'Not found' };
            const wf = rowToWorkflow(row);
            const log = await WorkflowEngineService.getInstance().executeWorkflow({ ...wf, enabled: true }, triggerData || {}, 'manual');
            return { success: true, log };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // ─── Clone workflow → target page ─────────────────────────────────────────
    ipcMain.handle('workflow:clone', async (_e, { id, targetZaloId }: { id: string; targetZaloId: string }) => {
        try {
            const row = DatabaseService.getInstance().getWorkflowById(id);
            if (!row) return { success: false, error: 'Không tìm thấy workflow gốc' };
            const wf = rowToWorkflow(row);
            if (wf.channel !== 'zalo' || hasUnsupportedWorkflowNodes(wf.nodes)) {
                return { success: false, error: 'Chỉ có thể nhân bản workflow Zalo ở phiên bản hiện tại.' };
            }
            const newId = DatabaseService.getInstance().cloneWorkflow(id, targetZaloId);
            if (!newId) return { success: false, error: 'Không tìm thấy workflow gốc' };
            DatabaseService.getInstance().save();
            WorkflowEngineService.getInstance().reloadWorkflow(newId);
            return { success: true, newId };
        } catch (e: any) {
            Logger.error(`[WorkflowIpc] clone error: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    // ─── Clone ALL workflows from one page → another ──────────────────────────
    ipcMain.handle('workflow:cloneAll', async (_e, { sourceZaloId, targetZaloId }: { sourceZaloId: string; targetZaloId: string }) => {
        try {
            const count = DatabaseService.getInstance().cloneAllWorkflows(sourceZaloId, targetZaloId);
            DatabaseService.getInstance().save();
            // Reload engine for newly cloned workflows
            const rows = DatabaseService.getInstance().getWorkflows();
            for (const r of rows) {
                const ids = (r.page_ids || '').split(',').filter(Boolean);
                if (ids.includes(targetZaloId)) {
                    WorkflowEngineService.getInstance().reloadWorkflow(r.id);
                }
            }
            return { success: true, count };
        } catch (e: any) {
            Logger.error(`[WorkflowIpc] cloneAll error: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    // ─── Get logs ─────────────────────────────────────────────────────────────
    ipcMain.handle('workflow:getLogs', async (_e, { id, limit }: { id: string; limit?: number }) => {
        try {
            const logs = DatabaseService.getInstance().getWorkflowRunLogs(id, limit || 50);
            return { success: true, logs };
        } catch (e: any) {
            return { success: false, error: e.message, logs: [] };
        }
    });

    // ─── Delete logs ──────────────────────────────────────────────────────────
    ipcMain.handle('workflow:deleteLogs', async (_e, { id }: { id: string }) => {
        try {
            const db = DatabaseService.getInstance() as any;
            db['run'](`DELETE FROM workflow_run_logs WHERE workflow_id=?`, [id]);
            DatabaseService.getInstance().save();
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });
}
