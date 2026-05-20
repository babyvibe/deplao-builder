"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAIAssistantIpc = registerAIAssistantIpc;
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const AIAssistantService_1 = __importDefault(require("../../src/services/AIAssistantService"));
const Logger_1 = __importDefault(require("../../src/utils/Logger"));
function registerAIAssistantIpc() {
    // ─── List all assistants ──────────────────────────────────────────────────
    electron_1.ipcMain.handle('ai:listAssistants', async () => {
        try {
            const assistants = AIAssistantService_1.default.getInstance().listAssistants();
            // Mask API keys for renderer
            const masked = assistants.map(a => ({ ...a, apiKey: a.apiKey ? '***' : '' }));
            return { success: true, assistants: masked };
        }
        catch (e) {
            Logger_1.default.error(`[AIAssistantIpc] listAssistants: ${e.message}`);
            return { success: false, error: e.message, assistants: [] };
        }
    });
    // ─── Get single assistant ──────────────────────────────────────────────────
    electron_1.ipcMain.handle('ai:getAssistant', async (_e, { id }) => {
        try {
            const assistant = AIAssistantService_1.default.getInstance().getAssistant(id);
            if (!assistant)
                return { success: false, error: 'Không tìm thấy trợ lý AI' };
            return { success: true, assistant: { ...assistant, apiKey: assistant.apiKey ? '***' : '' } };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Get default assistant ────────────────────────────────────────────────
    electron_1.ipcMain.handle('ai:getDefault', async () => {
        try {
            const assistant = AIAssistantService_1.default.getInstance().getDefaultAssistant();
            if (!assistant)
                return { success: true, assistant: null };
            return { success: true, assistant: { ...assistant, apiKey: '***' } };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Save (create/update) ─────────────────────────────────────────────────
    electron_1.ipcMain.handle('ai:saveAssistant', async (_e, { assistant }) => {
        try {
            // If apiKey is '***', preserve existing key (handled in service via ON CONFLICT)
            const pinnedLen = assistant?.pinnedProductsJson?.length || 0;
            Logger_1.default.info(`[AIAssistantIpc] saveAssistant: id=${assistant?.id}, posIntegrationId=${assistant?.posIntegrationId}, pinnedProductsJson.length=${pinnedLen}`);
            const id = AIAssistantService_1.default.getInstance().saveAssistant(assistant);
            return { success: true, id };
        }
        catch (e) {
            Logger_1.default.error(`[AIAssistantIpc] saveAssistant: ${e.message}`);
            return { success: false, error: e.message };
        }
    });
    // ─── Delete ───────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('ai:deleteAssistant', async (_e, { id }) => {
        try {
            AIAssistantService_1.default.getInstance().deleteAssistant(id);
            return { success: true };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Test connection ──────────────────────────────────────────────────────
    electron_1.ipcMain.handle('ai:testAssistant', async (_e, { id }) => {
        try {
            return await AIAssistantService_1.default.getInstance().testConnection(id);
        }
        catch (e) {
            return { success: false, message: e.message };
        }
    });
    // ─── Get files ────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('ai:getFiles', async (_e, { assistantId }) => {
        try {
            const files = AIAssistantService_1.default.getInstance().getFiles(assistantId);
            return { success: true, files };
        }
        catch (e) {
            return { success: false, error: e.message, files: [] };
        }
    });
    // ─── Upload file (read text content) ──────────────────────────────────────
    electron_1.ipcMain.handle('ai:uploadFile', async (_e, { assistantId, filePath: fp }) => {
        try {
            if (!fs.existsSync(fp))
                return { success: false, error: 'File không tồn tại' };
            const fileName = path.basename(fp);
            const stat = fs.statSync(fp);
            const ext = path.extname(fp).toLowerCase();
            // Read text content (supports txt, md, csv, json)
            let contentText = '';
            const textExts = ['.txt', '.md', '.csv', '.json', '.html', '.xml', '.log', '.yml', '.yaml'];
            if (textExts.includes(ext)) {
                contentText = fs.readFileSync(fp, 'utf-8').substring(0, 100000); // Max 100KB text
            }
            const id = AIAssistantService_1.default.getInstance().addFile(assistantId, fileName, fp, stat.size, contentText);
            return { success: true, id, fileName, fileSize: stat.size, hasContent: !!contentText };
        }
        catch (e) {
            Logger_1.default.error(`[AIAssistantIpc] uploadFile: ${e.message}`);
            return { success: false, error: e.message };
        }
    });
    // ─── Remove file ──────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('ai:removeFile', async (_e, { fileId }) => {
        try {
            AIAssistantService_1.default.getInstance().removeFile(fileId);
            return { success: true };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Get suggestions (for chat input) ─────────────────────────────────────
    electron_1.ipcMain.handle('ai:suggest', async (_e, { assistantId, chatHistory }) => {
        try {
            const suggestions = await AIAssistantService_1.default.getInstance().getSuggestions(assistantId, chatHistory);
            return { success: true, suggestions };
        }
        catch (e) {
            const status = e.response?.status;
            const errData = e.response?.data;
            Logger_1.default.error(`[AIAssistantIpc] suggest: status=${status}, message=${e.message}, responseData=${JSON.stringify(errData)?.substring(0, 500)}`);
            return { success: false, error: e.message, suggestions: [] };
        }
    });
    // ─── Direct chat ──────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('ai:chat', async (_e, { assistantId, messages, structured }) => {
        try {
            Logger_1.default.info(`[AIAssistantIpc] chat: assistantId=${assistantId}, messagesCount=${messages?.length}, structured=${!!structured}`);
            const result = await AIAssistantService_1.default.getInstance().chat(assistantId, messages, !!structured);
            return { success: true, ...result };
        }
        catch (e) {
            const status = e.response?.status;
            const errData = e.response?.data;
            Logger_1.default.error(`[AIAssistantIpc] chat: status=${status}, message=${e.message}, responseData=${JSON.stringify(errData)?.substring(0, 500)}`);
            return { success: false, error: e.message };
        }
    });
    // ─── Per-account assistant assignment ──────────────────────────────────────
    electron_1.ipcMain.handle('ai:getAccountAssistant', async (_e, { zaloId, role }) => {
        try {
            const assistant = AIAssistantService_1.default.getInstance().getAssistantForAccount(zaloId, role);
            if (!assistant)
                return { success: true, assistant: null };
            return { success: true, assistant: { ...assistant, apiKey: '***' } };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('ai:setAccountAssistant', async (_e, { zaloId, role, assistantId }) => {
        try {
            AIAssistantService_1.default.getInstance().setAccountAssistant(zaloId, role, assistantId);
            return { success: true };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('ai:getAccountAssistants', async (_e, { zaloId }) => {
        try {
            const assignments = AIAssistantService_1.default.getInstance().getAccountAssistants(zaloId);
            return { success: true, ...assignments };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Usage logs & reporting ────────────────────────────────────────────────
    electron_1.ipcMain.handle('ai:getUsageLogs', async (_e, opts) => {
        try {
            const logs = AIAssistantService_1.default.getInstance().getUsageLogs(opts);
            return { success: true, logs };
        }
        catch (e) {
            return { success: false, error: e.message, logs: [] };
        }
    });
    electron_1.ipcMain.handle('ai:getUsageStats', async (_e, opts) => {
        try {
            const stats = AIAssistantService_1.default.getInstance().getUsageStats(opts);
            return { success: true, stats };
        }
        catch (e) {
            return { success: false, error: e.message, stats: [] };
        }
    });
}
//# sourceMappingURL=aiAssistantIpc.js.map