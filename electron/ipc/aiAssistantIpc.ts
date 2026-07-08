import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import AIAssistantService from '../../src/services/ai/AIAssistantService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import { proxyToBoss } from './proxyHelper';
import Logger from '../../src/utils/Logger';


function isEmployeeMode(): boolean {
    try {
        const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
        if (activeWs?.type === 'remote') return true;
    } catch {}
    return false;
}

/** Proxy request-response tới Boss (giống wrap() trong zaloIpc) — trả về kết quả từ Boss */
async function proxyToBossWithResult(channel: string, params: any): Promise<any> {
    try {
        const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
        if (!activeWs || activeWs.type !== 'remote') throw new Error('Không kết nối tới Boss');
        const HCM = require('../../src/services/http/HttpConnectionManager').default;
        return await HCM.getInstance().proxyAction(activeWs.id, channel, { ...params, _fromRelay: true });
    } catch (err: any) {
        Logger.warn(`[AIAssistantIpc] proxyToBoss ${channel} failed: ${err.message}`);
        return { success: false, error: err.message };
    }
}

export function registerAIAssistantIpc(): void {

  // ─── List all assistants ──────────────────────────────────────────────────
  ipcMain.handle('ai:listAssistants', async () => {
    try {
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:listAssistants', {});

      const assistants = AIAssistantService.getInstance().listAssistants();
      // Mask API keys for renderer
      const masked = assistants.map(a => ({ ...a, apiKey: a.apiKey ? '***' : '' }));
      return { success: true, assistants: masked };
    } catch (e: any) {
      Logger.error(`[AIAssistantIpc] listAssistants: ${e.message}`);
      return { success: false, error: e.message, assistants: [] };
    }
  });

  // ─── Get single assistant ──────────────────────────────────────────────────
  ipcMain.handle('ai:getAssistant', async (_e, { id }: { id: string }) => {
    try {
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:getAssistant', { id });

      const assistant = AIAssistantService.getInstance().getAssistant(id);
      if (!assistant) return { success: false, error: 'Không tìm thấy trợ lý AI' };
      return { success: true, assistant: { ...assistant, apiKey: assistant.apiKey ? '***' : '' } };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ─── Get default assistant ────────────────────────────────────────────────
  ipcMain.handle('ai:getDefault', async () => {
    try {
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:getDefault', {});

      const assistant = AIAssistantService.getInstance().getDefaultAssistant();
      if (!assistant) return { success: true, assistant: null };
      return { success: true, assistant: { ...assistant, apiKey: '***' } };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ─── Save (create/update) ─────────────────────────────────────────────────
  ipcMain.handle('ai:saveAssistant', async (_e, { assistant }: { assistant: any }) => {
    try {
            if (isEmployeeMode()) { proxyToBoss("ai:saveAssistant", { assistant: assistant }); return { success: true }; }
      // If apiKey is '***', preserve existing key (handled in service via ON CONFLICT)
      const pinnedLen = assistant?.pinnedProductsJson?.length || 0;
      Logger.info(`[AIAssistantIpc] saveAssistant: id=${assistant?.id}, posIntegrationId=${assistant?.posIntegrationId}, pinnedProductsJson.length=${pinnedLen}`);
      const id = AIAssistantService.getInstance().saveAssistant(assistant);
      return { success: true, id };
    } catch (e: any) {
      Logger.error(`[AIAssistantIpc] saveAssistant: ${e.message}`);
      return { success: false, error: e.message };
    }
  });

  // ─── Delete ───────────────────────────────────────────────────────────────
  ipcMain.handle('ai:deleteAssistant', async (_e, { id }: { id: string }) => {
    try {
            if (isEmployeeMode()) { proxyToBoss("ai:deleteAssistant", { id: id }); return { success: true }; }
      AIAssistantService.getInstance().deleteAssistant(id);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ─── Test connection ──────────────────────────────────────────────────────
  ipcMain.handle('ai:testAssistant', async (_e, { id }: { id: string }) => {
    try {
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:testAssistant', { id });
      return await AIAssistantService.getInstance().testConnection(id);
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  });

  // ─── Get files ────────────────────────────────────────────────────────────
  ipcMain.handle('ai:getFiles', async (_e, { assistantId }: { assistantId: string }) => {
    try {
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:getFiles', { assistantId });

      const files = AIAssistantService.getInstance().getFiles(assistantId);
      return { success: true, files };
    } catch (e: any) {
      return { success: false, error: e.message, files: [] };
    }
  });

  // ─── Upload file (read text content) ──────────────────────────────────────
  ipcMain.handle('ai:uploadFile', async (_e, { assistantId, filePath: fp }: { assistantId: string; filePath: string }) => {
    try {
      if (!fs.existsSync(fp)) return { success: false, error: 'File không tồn tại' };
      const fileName = path.basename(fp);
      const stat = fs.statSync(fp);
      const ext = path.extname(fp).toLowerCase();

      // Employee mode: upload file content lên Boss trước, dùng Boss path
      if (isEmployeeMode()) {
        try {
          const buffer = fs.readFileSync(fp);
          const HttpClientService = require('../services/http/HttpClientService').default;
          const uploadResult = await HttpClientService.getInstance().uploadMedia(buffer, fileName);
          if (uploadResult.success && uploadResult.bossPath) {
            // Dùng Boss path thay vì local path
            const id = AIAssistantService.getInstance().addFile(assistantId, fileName, uploadResult.bossPath, stat.size, '');
            return { success: true, id, fileName, fileSize: stat.size, bossPath: uploadResult.bossPath };
          }
        } catch {}
        // Fallback: proxy thông thường (boss không có file)
        proxyToBoss('ai:uploadFile', { assistantId, filePath: fp });
        return { success: true };
      }

      // Boss mode: đọc file local
      let contentText = '';
      const textExts = ['.txt', '.md', '.csv', '.json', '.html', '.xml', '.log', '.yml', '.yaml'];
      if (textExts.includes(ext)) {
        contentText = fs.readFileSync(fp, 'utf-8').substring(0, 100000);
      }

      const id = AIAssistantService.getInstance().addFile(assistantId, fileName, fp, stat.size, contentText);
      return { success: true, id, fileName, fileSize: stat.size, hasContent: !!contentText };
    } catch (e: any) {
      Logger.error(`[AIAssistantIpc] uploadFile: ${e.message}`);
      return { success: false, error: e.message };
    }
  });

  // ─── Remove file ──────────────────────────────────────────────────────────
  ipcMain.handle('ai:removeFile', async (_e, { fileId }: { fileId: number }) => {
    try {
            if (isEmployeeMode()) { proxyToBoss("ai:removeFile", { fileId: fileId }); return { success: true }; }
      AIAssistantService.getInstance().removeFile(fileId);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ─── Get suggestions (for chat input) ─────────────────────────────────────
  ipcMain.handle('ai:suggest', async (_e, { assistantId, chatHistory }: { assistantId: string; chatHistory: any[] }) => {
    try {
      // Employee mode: proxy qua Boss REST API để Boss gọi AI
      if (isEmployeeMode()) {
        try {
          const { default: WorkspaceManager } = require('../../src/utils/WorkspaceManager');
          const ws = WorkspaceManager.getInstance().getActiveWorkspace();
          if (ws?.bossUrl && ws?.token) {
            const baseUrl = ws.bossUrl.replace(/\/+$/, '');
            const res = await fetch(`${baseUrl}/api/command/ai/suggest`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${ws.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ assistantId, chatHistory }),
              signal: AbortSignal.timeout(60000),
            });
            const json: any = await res.json();
            if (json?.success) return { success: true, suggestions: json.suggestions || [] };
            return { success: false, error: json?.error || 'AI suggest thất bại', suggestions: [] };
          }
        } catch {}
        return { success: false, error: 'Không kết nối tới Boss', suggestions: [] };
      }

      const suggestions = await AIAssistantService.getInstance().getSuggestions(assistantId, chatHistory);
      return { success: true, suggestions };
    } catch (e: any) {
      const status = e.response?.status;
      const errData = e.response?.data;
      Logger.error(`[AIAssistantIpc] suggest: status=${status}, message=${e.message}, responseData=${JSON.stringify(errData)?.substring(0, 500)}`);
      return { success: false, error: e.message, suggestions: [] };
    }
  });

  // ─── Direct chat ──────────────────────────────────────────────────────────
  ipcMain.handle('ai:chat', async (_e, { assistantId, messages, structured, maxTokens }: { assistantId: string; messages: any[]; structured?: boolean; maxTokens?: number }) => {
    try {
      // Employee mode: proxy qua Boss REST API để Boss gọi AI
      if (isEmployeeMode()) {
        try {
          const { default: WorkspaceManager } = require('../../src/utils/WorkspaceManager');
          const ws = WorkspaceManager.getInstance().getActiveWorkspace();
          if (ws?.bossUrl && ws?.token) {
            const baseUrl = ws.bossUrl.replace(/\/+$/, '');
            const res = await fetch(`${baseUrl}/api/command/ai/chat`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${ws.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ assistantId, messages, structured, maxTokens }),
              signal: AbortSignal.timeout(120000),
            });
            const json: any = await res.json();
            if (json?.success) return { success: true, result: json.result, totalTokens: json.totalTokens, promptTokens: json.promptTokens, completionTokens: json.completionTokens };
            return { success: false, error: json?.error || 'AI chat thất bại' };
          }
        } catch {}
        return { success: false, error: 'Không kết nối tới Boss' };
      }

      Logger.info(`[AIAssistantIpc] chat: assistantId=${assistantId}, messagesCount=${messages?.length}, structured=${!!structured}, maxTokens=${maxTokens ?? 'default'}`);
      const result = await AIAssistantService.getInstance().chat(assistantId, messages, !!structured, maxTokens);
      return { success: true, ...result };
    } catch (e: any) {
      const status = e.response?.status;
      const errData = e.response?.data;
      Logger.error(`[AIAssistantIpc] chat: status=${status}, message=${e.message}, responseData=${JSON.stringify(errData)?.substring(0, 500)}`);
      return { success: false, error: e.message };
    }
  });

  // ─── Per-account assistant assignment ──────────────────────────────────────
  ipcMain.handle('ai:getAccountAssistant', async (_e, { zaloId, role }: { zaloId: string; role: 'suggestion' | 'panel' }) => {
    try {
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:getAccountAssistant', { zaloId, role });
      const assistant = AIAssistantService.getInstance().getAssistantForAccount(zaloId, role);
      if (!assistant) return { success: true, assistant: null };
      return { success: true, assistant: { ...assistant, apiKey: '***' } };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ai:setAccountAssistant', async (_e, { zaloId, role, assistantId }: { zaloId: string; role: 'suggestion' | 'panel'; assistantId: string | null }) => {
    try {
            if (isEmployeeMode()) { proxyToBoss("ai:setAccountAssistant", { zaloId: zaloId, role: role, assistantId: assistantId }); return { success: true }; }
      AIAssistantService.getInstance().setAccountAssistant(zaloId, role, assistantId);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ai:getAccountAssistants', async (_e, { zaloId }: { zaloId: string }) => {
    try {
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:getAccountAssistants', { zaloId });
      const assignments = AIAssistantService.getInstance().getAccountAssistants(zaloId);
      return { success: true, ...assignments };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ─── Usage logs & reporting ────────────────────────────────────────────────
  ipcMain.handle('ai:getUsageLogs', async (_e, opts: any) => {
    try {
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:getUsageLogs', opts);
      const logs = AIAssistantService.getInstance().getUsageLogs(opts);
      return { success: true, logs };
    } catch (e: any) {
      return { success: false, error: e.message, logs: [] };
    }
  });

  ipcMain.handle('ai:getUsageStats', async (_e, opts: any) => {
    try {
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:getUsageStats', opts);
      const stats = AIAssistantService.getInstance().getUsageStats(opts);
      return { success: true, stats };
    } catch (e: any) {
      return { success: false, error: e.message, stats: [] };
    }
  });
}

