import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import AIAssistantService from '../../src/services/ai/AIAssistantService';
import DatabaseService from '../../src/services/database/DatabaseService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import { proxyToBossWithResult, uploadEmployeeMedia } from './proxyHelper';
import Logger from '../../src/utils/Logger';


function isEmployeeMode(): boolean {
    try {
        const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
        if (activeWs?.type === 'remote') return true;
    } catch {}
    return false;
}

/** File kiến thức nhân viên tải lên Boss tối đa (chỉ nội dung văn bản ≤ 100k ký tự được dùng; file lớn chỉ tốn băng thông). */
const AI_FILE_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Nhân viên: mọi lệnh ai:* chạy trên Boss qua proxyToBossWithResult (proxyHelper) và trả KẾT QUẢ THẬT của Boss.
// Lệnh ghi trước đây gửi kiểu fire-and-forget rồi trả { success: true } ngay → UI báo thành công cả khi Boss từ chối
// (thiếu quyền module ai_assistant, file không hợp lệ…), không có id trợ lý mới.

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
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:saveAssistant', { assistant });
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
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:deleteAssistant', { id });
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
  // Nhân viên: file nằm trên máy nhân viên → upload lên thư mục media của Boss trước (uploadEmployeeMedia — đường dẫn
  // Boss hợp lệ với chính sách file proxy), rồi Boss chạy chính handler này với đường dẫn Boss (đọc nội dung văn bản,
  // lưu bản ghi) và trả kết quả thật. Trước đây require sai đường dẫn ('../services/…' không tồn tại) → luôn rơi xuống
  // proxy với đường dẫn máy nhân viên (Boss từ chối PATH_FORBIDDEN) trong khi UI báo "Đã tải file lên".
  // Bản sao trên Boss (media/<tài khoản>/…) giữ lại: là file_path của bản ghi, như bản ghi tạo trên Boss trỏ tới file gốc;
  // không tự xoá vì cùng thư mục với media chat.
  ipcMain.handle('ai:uploadFile', async (_e, { assistantId, filePath: fp, fileName: requestedName }: { assistantId: string; filePath: string; fileName?: string }) => {
    try {
      if (!fp || !fs.existsSync(fp)) return { success: false, error: 'File không tồn tại' };
      const stat = fs.statSync(fp);

      if (isEmployeeMode()) {
        if (stat.size > AI_FILE_MAX_UPLOAD_BYTES) {
          return { success: false, error: `File kiến thức tối đa ${Math.round(AI_FILE_MAX_UPLOAD_BYTES / 1024 / 1024)} MB` };
        }
        let bossPath = '';
        try {
          [bossPath] = await uploadEmployeeMedia([fp]);
        } catch (err: any) {
          return { success: false, error: err?.message || 'Không tải được file lên Boss' };
        }
        if (!bossPath || bossPath === fp) return { success: false, error: 'Không tải được file lên Boss' };
        return await proxyToBossWithResult('ai:uploadFile', { assistantId, filePath: bossPath, fileName: path.basename(fp) });
      }

      if (!assistantId || !AIAssistantService.getInstance().getAssistant(assistantId)) {
        return { success: false, error: 'Không tìm thấy trợ lý AI' };
      }
      // Tên hiển thị: tên gốc trên máy nhân viên (bản upload trên Boss có thể thành "tên (1).txt")
      const fileName = (typeof requestedName === 'string' && path.basename(requestedName).trim()) || path.basename(fp);
      const ext = path.extname(fp).toLowerCase();

      // Boss: đọc file local (đường dẫn của Boss — file chọn trên Boss hoặc file nhân viên vừa upload)
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
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:removeFile', { fileId });
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
  ipcMain.handle('ai:chat', async (_e, { assistantId, messages, structured, maxTokens, rawSystem, temperature }: { assistantId: string; messages: any[]; structured?: boolean; maxTokens?: number; rawSystem?: boolean; temperature?: number }) => {
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
              body: JSON.stringify({ assistantId, messages, structured, maxTokens, rawSystem, temperature }),
              signal: AbortSignal.timeout(120000),
            });
            const json: any = await res.json();
            if (json?.success) return { success: true, result: json.result, totalTokens: json.totalTokens, promptTokens: json.promptTokens, completionTokens: json.completionTokens };
            return { success: false, error: json?.error || 'AI chat thất bại' };
          }
        } catch {}
        return { success: false, error: 'Không kết nối tới Boss' };
      }

      Logger.info(`[AIAssistantIpc] chat: assistantId=${assistantId}, messagesCount=${messages?.length}, structured=${!!structured}, maxTokens=${maxTokens ?? 'default'}, rawSystem=${!!rawSystem}`);
      const result = rawSystem
        ? await AIAssistantService.getInstance().chatRaw(assistantId, messages, { maxTokens, temperature })
        : await AIAssistantService.getInstance().chat(assistantId, messages, !!structured, maxTokens);
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
            if (isEmployeeMode()) return await proxyToBossWithResult('ai:setAccountAssistant', { zaloId, role, assistantId });
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

  // ─── AI Conversations (chat history persistence) ──────────────────────────
  ipcMain.handle('ai:getOrCreateConversation', async (_e, { zaloId, threadId, assistantId }: { zaloId: string; threadId: string; assistantId: string }) => {
    try {
      const conv = DatabaseService.getInstance().getOrCreateAIConversation(zaloId, threadId, assistantId);
      return { success: true, conversation: conv };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ai:getConversationMessages', async (_e, { conversationId }: { conversationId: string }) => {
    try {
      const messages = DatabaseService.getInstance().getAIConversationMessages(conversationId);
      return { success: true, messages };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ai:addConversationMessage', async (_e, { conversationId, role, content, segmentsJson }: { conversationId: string; role: string; content: string; segmentsJson?: string }) => {
    try {
      DatabaseService.getInstance().addAIConversationMessage(conversationId, role, content, segmentsJson);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ai:getConversations', async (_e, { zaloId, threadId }: { zaloId: string; threadId: string }) => {
    try {
      const conversations = DatabaseService.getInstance().getAIConversations(zaloId, threadId);
      return { success: true, conversations };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ai:deleteConversation', async (_e, { conversationId }: { conversationId: string }) => {
    try {
      DatabaseService.getInstance().deleteAIConversation(conversationId);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });
}

