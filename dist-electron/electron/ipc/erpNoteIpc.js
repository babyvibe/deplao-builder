"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerErpNoteIpc = registerErpNoteIpc;
const electron_1 = require("electron");
const ErpNoteService_1 = __importDefault(require("../../src/services/erp/ErpNoteService"));
const erpIpcMiddleware_1 = require("./erpIpcMiddleware");
function registerErpNoteIpc() {
    const svc = () => ErpNoteService_1.default.getInstance();
    electron_1.ipcMain.handle('erp:note:listFolders', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (_input, ctx) => ({
        folders: svc().listFolders(ctx.employeeId),
    })));
    electron_1.ipcMain.handle('erp:note:createFolder', (0, erpIpcMiddleware_1.withErpAuth)('note.create', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.name, 'name', { max: 120 });
        return { folder: svc().createFolder(input.name, ctx.employeeId, input.parent_id) };
    }));
    electron_1.ipcMain.handle('erp:note:renameFolder', (0, erpIpcMiddleware_1.withErpAuth)('note.update', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        erpIpcMiddleware_1.erpValidate.string(input?.name, 'name', { max: 120 });
        svc().renameFolderForEmployee(Number(input.id), input.name, ctx.employeeId);
        return {};
    }));
    electron_1.ipcMain.handle('erp:note:deleteFolder', (0, erpIpcMiddleware_1.withErpAuth)('note.delete', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        svc().deleteFolderForEmployee(Number(input.id), ctx.employeeId);
        return {};
    }));
    electron_1.ipcMain.handle('erp:note:list', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input, ctx) => ({
        notes: svc().listNotesForEmployee(ctx.employeeId, input ?? {}),
    })));
    electron_1.ipcMain.handle('erp:note:get', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        const note = svc().getNoteForEmployee(input.id, ctx.employeeId);
        if (!note)
            throw new Error('Không tìm thấy note');
        return { note };
    }));
    electron_1.ipcMain.handle('erp:note:create', (0, erpIpcMiddleware_1.withErpAuth)('note.create', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.input?.title, 'title', { max: 300 });
        return { note: svc().createNote(input.input, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:note:update', (0, erpIpcMiddleware_1.withErpAuth)('note.update', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        return { note: svc().updateNoteForEmployee(input.id, input.patch ?? {}, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:note:delete', (0, erpIpcMiddleware_1.withErpAuth)('note.delete', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        svc().deleteNoteForEmployee(input.id, ctx.employeeId);
        return {};
    }));
    electron_1.ipcMain.handle('erp:note:pin', (0, erpIpcMiddleware_1.withErpAuth)('note.update', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        return { note: svc().pinNoteForEmployee(input.id, !!input.pinned, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:note:listTags', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async () => ({
        tags: svc().listTags(),
    })));
    electron_1.ipcMain.handle('erp:note:createTag', (0, erpIpcMiddleware_1.withErpAuth)('note.create', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.name, 'name', { max: 50 });
        return { tag: svc().createTag(input.name, input.color) };
    }));
    electron_1.ipcMain.handle('erp:note:addTag', (0, erpIpcMiddleware_1.withErpAuth)('note.update', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.noteId, 'noteId');
        erpIpcMiddleware_1.erpValidate.int(input?.tagId, 'tagId');
        svc().addTagToNote(input.noteId, Number(input.tagId));
        return {};
    }));
    electron_1.ipcMain.handle('erp:note:removeTag', (0, erpIpcMiddleware_1.withErpAuth)('note.update', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.noteId, 'noteId');
        erpIpcMiddleware_1.erpValidate.int(input?.tagId, 'tagId');
        svc().removeTagFromNote(input.noteId, Number(input.tagId));
        return {};
    }));
    electron_1.ipcMain.handle('erp:note:versions', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.noteId, 'noteId');
        return { versions: svc().listVersionsForEmployee(input.noteId, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:note:restoreVersion', (0, erpIpcMiddleware_1.withErpAuth)('note.update', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.int(input?.versionId, 'versionId');
        return { note: svc().restoreVersionForEmployee(Number(input.versionId), ctx.employeeId) };
    }));
    // ─── Share (Phase 2) ──────────────────────────────────────────────────────
    electron_1.ipcMain.handle('erp:note:share', (0, erpIpcMiddleware_1.withErpAuth)('note.share', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.noteId, 'noteId');
        const scope = input?.scope || 'custom';
        erpIpcMiddleware_1.erpValidate.enum(scope, 'scope', ['private', 'workspace', 'custom']);
        const shares = Array.isArray(input?.shares) ? input.shares : [];
        svc().shareNote(input.noteId, shares, scope, ctx.employeeId);
        return {};
    }));
    electron_1.ipcMain.handle('erp:note:listShares', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.noteId, 'noteId');
        return { shares: svc().listSharesForEmployee(input.noteId, ctx.employeeId) };
    }));
}
//# sourceMappingURL=erpNoteIpc.js.map