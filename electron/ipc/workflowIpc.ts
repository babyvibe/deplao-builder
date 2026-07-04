import { ipcMain } from 'electron';
import DatabaseService from '../../src/services/database/DatabaseService';
import WorkflowEngineService, { Workflow, WorkflowChannel } from '../../src/services/workflow/WorkflowEngineService';
import AppModeManager from '../../src/utils/AppModeManager';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import EmployeeService from '../../src/services/employee/EmployeeService';
import { v4 as uuidv4 } from 'uuid';
import Logger from '../../src/utils/Logger';
import WebhookGatewayService from '../../src/services/workflow/WebhookGatewayService';
import TunnelService from '../../src/services/tunnel/TunnelService';

function isEmployeeMode(): boolean {
    try {
        const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
        if (activeWs?.type === 'remote') return true;
    } catch {}
    return false;
}

/** Helper: row → Workflow shape (pageIds array) */
function normalizeWorkflowChannel(channel?: string): WorkflowChannel {
    return channel === 'facebook' ? 'facebook' : 'zalo';
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

/** Get assigned zaloIds for the current employee, or null if not in employee mode */
function getEmployeeAssignedAccounts(): string[] | null {
    try {
        const mode = AppModeManager.getInstance().getMode();
        if (mode !== 'employee') return null;

        const employeeId = AppModeManager.getInstance().getEmployeeId();
        if (!employeeId) return null;

        const emp = EmployeeService.getInstance().getEmployeeById(employeeId);
        if (!emp?.assigned_accounts) return null;

        return typeof emp.assigned_accounts === 'string'
            ? JSON.parse(emp.assigned_accounts)
            : emp.assigned_accounts;
    } catch {
        return null;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Generate a fresh UUID webhook token */
function generateWebhookToken(): string {
  return uuidv4();
}

/** Check if a workflow has a trigger.webhook node */
function hasWebhookTrigger(nodes: any[]): boolean {
  return nodes.some(n => n.type === "trigger.webhook");
}

/** Ensure webhook token exists on a trigger.webhook node config */
function ensureWebhookToken(nodes: any[]): string | null {
  const hookNode = nodes.find(n => n.type === "trigger.webhook");
  if (!hookNode) return null;
  if (!hookNode.config) hookNode.config = {};
  if (!hookNode.config.webhookToken) {
    hookNode.config.webhookToken = generateWebhookToken();
  }
  return hookNode.config.webhookToken;
}

export function registerWorkflowIpc(): void {

    // ── Label Event bridge REMOVED - now centralized in databaseIpc.ts and zaloIpc.ts ──

    // ─── List ─────────────────────────────────────────────────────────────────
    ipcMain.handle('workflow:list', async () => {
        try {
            const rows = DatabaseService.getInstance().getWorkflows();
            if (isEmployeeMode()) return { success: true, workflows: [] };
            let workflows = rows.map(rowToWorkflow);

            // Employee mode: filter workflows by assigned accounts
            const assignedAccounts = getEmployeeAssignedAccounts();
            if (assignedAccounts) {
                const accountSet = new Set(assignedAccounts);
                workflows = workflows.filter(wf => {
                    // Global workflows (no pageIds) - always show
                    if (wf.pageIds.length === 0) return true;
                    // Only show workflows that include at least one assigned account
                    return wf.pageIds.some(id => accountSet.has(id));
                });
            }

            return { success: true, workflows };
        } catch (e: any) {
            return { success: false, error: e.message, workflows: [] };
        }
    });

    // ─── Get single ───────────────────────────────────────────────────────────
    ipcMain.handle('workflow:get', async (_e, { id }: { id: string }) => {
        try {
            if (isEmployeeMode()) return { success: false, error: "Không khả dụng" };
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
            // Auto-generate webhook token if workflow has trigger.webhook
            let webhookToken: string | null = null;
            if (hasWebhookTrigger(wf.nodes)) {
              webhookToken = ensureWebhookToken(wf.nodes);
            }
            DatabaseService.getInstance().saveWorkflow(wf);
            DatabaseService.getInstance().save();
            WorkflowEngineService.getInstance().reloadWorkflow(wf.id);
            return { success: true, id: wf.id, webhookToken };
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
                // FB workflows are now supported - no channel check needed
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
            if (wf.channel !== 'zalo' && wf.channel !== 'facebook') {
                return { success: false, error: 'Chỉ có thể nhân bản workflow Zalo hoặc Facebook ở phiên bản hiện tại.' };
            }
            const newId = DatabaseService.getInstance().cloneWorkflow(id, targetZaloId);
            if (!newId) return { success: false, error: 'Không tìm thấy workflow gốc' };
            // Regenerate webhook token for cloned workflow if it has trigger.webhook
            const clonedRow = DatabaseService.getInstance().getWorkflowById(newId);
            if (clonedRow) {
              const clonedWf = rowToWorkflow(clonedRow);
              if (hasWebhookTrigger(clonedWf.nodes)) {
                ensureWebhookToken(clonedWf.nodes);
                DatabaseService.getInstance().saveWorkflow(clonedWf);
              }
            }
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

    // ─── Webhook: Get webhook URL ────────────────────────────────────────
    ipcMain.handle('workflow:getWebhookUrl', async (_e, { id }: { id: string }) => {
        try {
            const row = DatabaseService.getInstance().getWorkflowById(id);
            if (!row) return { success: false, error: 'Not found' };
            const wf = rowToWorkflow(row);
            const hookNode = wf.nodes.find(n => n.type === 'trigger.webhook');
            if (!hookNode) return { success: false, error: 'Workflow này không có trigger.webhook' };
            const token = hookNode.config?.webhookToken || '';
            const tunnelUrl = TunnelService.getUrl(9889);
            const webhookUrl = tunnelUrl ? tunnelUrl + '/api/workflow/webhook/' + token : null;
            return { success: true, webhookUrl, token, tunnelActive: !!tunnelUrl };
        } catch (e: any) {
            Logger.error('[WorkflowIpc] getWebhookUrl error: ' + e.message);
            return { success: false, error: e.message };
        }
    });

    // ─── Webhook: Gateway Tunnel ───────────────────────────────────────
    ipcMain.handle('workflow:startTunnel', async () => {
        try {
            const result = await WebhookGatewayService.getInstance().startTunnel();
            return result;
        } catch (e: any) {
            Logger.error('[WorkflowIpc] startTunnel error: ' + e.message);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('workflow:stopTunnel', async () => {
        try {
            const result = await WebhookGatewayService.getInstance().stopTunnel();
            return result;
        } catch (e: any) {
            Logger.error('[WorkflowIpc] stopTunnel error: ' + e.message);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('workflow:getTunnelStatus', async () => {
        try {
            return { success: true, ...WebhookGatewayService.getInstance().getStatus() };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // ─── Webhook: Regenerate token ─────────────────────────────────────────
    ipcMain.handle('workflow:regenerateWebhookToken', async (_e, { id }: { id: string }) => {
        try {
            const row = DatabaseService.getInstance().getWorkflowById(id);
            if (!row) return { success: false, error: 'Not found' };
            const wf = rowToWorkflow(row);
            const hookNode = wf.nodes.find(n => n.type === 'trigger.webhook');
            if (!hookNode) return { success: false, error: 'Workflow này không có trigger.webhook' };
            const newToken = generateWebhookToken();
            if (!hookNode.config) hookNode.config = {};
            hookNode.config.webhookToken = newToken;
            // Save updated node config back to DB
            DatabaseService.getInstance().saveWorkflow(wf);
            DatabaseService.getInstance().save();
            WorkflowEngineService.getInstance().reloadWorkflow(wf.id);
            const tunnelUrl = TunnelService.getUrl(9889);
            const webhookUrl = tunnelUrl ? tunnelUrl + '/api/workflow/webhook/' + newToken : null;
            return { success: true, webhookUrl, token: newToken };
        } catch (e: any) {
            Logger.error('[WorkflowIpc] regenerateWebhookToken error: ' + e.message);
            return { success: false, error: e.message };
        }
    });

    // ─── Webhook: Get/Set port config ─────────────────────────────────────
    ipcMain.handle('workflow:getPortConfig', async () => {
        try {
            const db = DatabaseService.getInstance();
            const intPort = db.getSetting('webhook_port_integration');
            const wfPort = db.getSetting('webhook_port_workflow');
            return { success: true, integrationPort: intPort ? Number(intPort) : 9888, workflowPort: wfPort ? Number(wfPort) : 9889 };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('workflow:setPortConfig', async (_e, { key, port }: { key: string; port: number }) => {
        try {
            DatabaseService.getInstance().setSetting(key, String(port));
            DatabaseService.getInstance().save();
            return { success: true };
        } catch (e: any) {
            Logger.error('[WorkflowIpc] setPortConfig error: ' + e.message);
            return { success: false, error: e.message };
        }
    });
}
