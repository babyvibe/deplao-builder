import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import AIAssistantService from '../../src/services/AIAssistantService';
import Logger from '../../src/utils/Logger';

export function registerAIAssistantIpc(): void {

  // ─── List all assistants ──────────────────────────────────────────────────
  ipcMain.handle('ai:listAssistants', async () => {
    try {
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
      AIAssistantService.getInstance().deleteAssistant(id);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ─── Test connection ──────────────────────────────────────────────────────
  ipcMain.handle('ai:testAssistant', async (_e, { id }: { id: string }) => {
    try {
      return await AIAssistantService.getInstance().testConnection(id);
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  });

  // ─── Get files ────────────────────────────────────────────────────────────
  ipcMain.handle('ai:getFiles', async (_e, { assistantId }: { assistantId: string }) => {
    try {
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

      // Read text content (supports txt, md, csv, json)
      let contentText = '';
      const textExts = ['.txt', '.md', '.csv', '.json', '.html', '.xml', '.log', '.yml', '.yaml'];
      if (textExts.includes(ext)) {
        contentText = fs.readFileSync(fp, 'utf-8').substring(0, 100000); // Max 100KB text
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
      AIAssistantService.getInstance().removeFile(fileId);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ─── Get suggestions (for chat input) ─────────────────────────────────────
  ipcMain.handle('ai:suggest', async (_e, { assistantId, chatHistory }: { assistantId: string; chatHistory: any[] }) => {
    try {
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
  ipcMain.handle('ai:chat', async (_e, { assistantId, messages, structured }: { assistantId: string; messages: any[]; structured?: boolean }) => {
    try {
      Logger.info(`[AIAssistantIpc] chat: assistantId=${assistantId}, messagesCount=${messages?.length}, structured=${!!structured}`);
      const result = await AIAssistantService.getInstance().chat(assistantId, messages, !!structured);
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
      const assistant = AIAssistantService.getInstance().getAssistantForAccount(zaloId, role);
      if (!assistant) return { success: true, assistant: null };
      return { success: true, assistant: { ...assistant, apiKey: '***' } };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ai:setAccountAssistant', async (_e, { zaloId, role, assistantId }: { zaloId: string; role: 'suggestion' | 'panel'; assistantId: string | null }) => {
    try {
      AIAssistantService.getInstance().setAccountAssistant(zaloId, role, assistantId);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ai:getAccountAssistants', async (_e, { zaloId }: { zaloId: string }) => {
    try {
      const assignments = AIAssistantService.getInstance().getAccountAssistants(zaloId);
      return { success: true, ...assignments };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ─── Usage logs & reporting ────────────────────────────────────────────────
  ipcMain.handle('ai:getUsageLogs', async (_e, opts: any) => {
    try {
      const logs = AIAssistantService.getInstance().getUsageLogs(opts);
      return { success: true, logs };
    } catch (e: any) {
      return { success: false, error: e.message, logs: [] };
    }
  });

  ipcMain.handle('ai:getUsageStats', async (_e, opts: any) => {
    try {
      const stats = AIAssistantService.getInstance().getUsageStats(opts);
      return { success: true, stats };
    } catch (e: any) {
      return { success: false, error: e.message, stats: [] };
    }
  });
}

