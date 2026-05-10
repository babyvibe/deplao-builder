import { ipcMain } from 'electron';
import ErpNoteService from '../../src/services/erp/ErpNoteService';
import { withErpAuth, erpValidate } from './erpIpcMiddleware';

export function registerErpNoteIpc(): void {
  const svc = () => ErpNoteService.getInstance();

  ipcMain.handle('erp:note:listFolders', withErpAuth('erp.access', async (_input: any, ctx) => ({
    folders: svc().listFolders(ctx.employeeId),
  })));

  ipcMain.handle('erp:note:createFolder', withErpAuth('note.create', async (input: any, ctx) => {
    erpValidate.string(input?.name, 'name', { max: 120 });
    return { folder: svc().createFolder(input.name, ctx.employeeId, input.parent_id) };
  }));

  ipcMain.handle('erp:note:renameFolder', withErpAuth('note.update', async (input: any, ctx) => {
    erpValidate.int(input?.id, 'id');
    erpValidate.string(input?.name, 'name', { max: 120 });
    svc().renameFolderForEmployee(Number(input.id), input.name, ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:note:deleteFolder', withErpAuth('note.delete', async (input: any, ctx) => {
    erpValidate.int(input?.id, 'id');
    svc().deleteFolderForEmployee(Number(input.id), ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:note:list', withErpAuth('erp.access', async (input: any, ctx) => ({
    notes: svc().listNotesForEmployee(ctx.employeeId, input ?? {}),
  })));

  ipcMain.handle('erp:note:get', withErpAuth('erp.access', async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    const note = svc().getNoteForEmployee(input.id, ctx.employeeId);
    if (!note) throw new Error('Không tìm thấy note');
    return { note };
  }));

  ipcMain.handle('erp:note:create', withErpAuth('note.create', async (input: any, ctx) => {
    erpValidate.string(input?.input?.title, 'title', { max: 300 });
    return { note: svc().createNote(input.input, ctx.employeeId) };
  }));

  ipcMain.handle('erp:note:update', withErpAuth('note.update', async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    return { note: svc().updateNoteForEmployee(input.id, input.patch ?? {}, ctx.employeeId) };
  }));

  ipcMain.handle('erp:note:delete', withErpAuth('note.delete', async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    svc().deleteNoteForEmployee(input.id, ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:note:pin', withErpAuth('note.update', async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    return { note: svc().pinNoteForEmployee(input.id, !!input.pinned, ctx.employeeId) };
  }));

  ipcMain.handle('erp:note:listTags', withErpAuth('erp.access', async () => ({
    tags: svc().listTags(),
  })));

  ipcMain.handle('erp:note:createTag', withErpAuth('note.create', async (input: any) => {
    erpValidate.string(input?.name, 'name', { max: 50 });
    return { tag: svc().createTag(input.name, input.color) };
  }));

  ipcMain.handle('erp:note:addTag', withErpAuth('note.update', async (input: any) => {
    erpValidate.string(input?.noteId, 'noteId');
    erpValidate.int(input?.tagId, 'tagId');
    svc().addTagToNote(input.noteId, Number(input.tagId));
    return {};
  }));

  ipcMain.handle('erp:note:removeTag', withErpAuth('note.update', async (input: any) => {
    erpValidate.string(input?.noteId, 'noteId');
    erpValidate.int(input?.tagId, 'tagId');
    svc().removeTagFromNote(input.noteId, Number(input.tagId));
    return {};
  }));

  ipcMain.handle('erp:note:versions', withErpAuth('erp.access', async (input: any, ctx) => {
    erpValidate.string(input?.noteId, 'noteId');
    return { versions: svc().listVersionsForEmployee(input.noteId, ctx.employeeId) };
  }));

  ipcMain.handle('erp:note:restoreVersion', withErpAuth('note.update', async (input: any, ctx) => {
    erpValidate.int(input?.versionId, 'versionId');
    return { note: svc().restoreVersionForEmployee(Number(input.versionId), ctx.employeeId) };
  }));

  // ─── Share (Phase 2) ──────────────────────────────────────────────────────
  ipcMain.handle('erp:note:share', withErpAuth('note.share', async (input: any, ctx) => {
    erpValidate.string(input?.noteId, 'noteId');
    const scope = input?.scope || 'custom';
    erpValidate.enum(scope, 'scope', ['private', 'workspace', 'custom'] as const);
    const shares: Array<{ employeeId: string; permission: 'read' | 'edit' }> =
      Array.isArray(input?.shares) ? input.shares : [];
    svc().shareNote(input.noteId, shares, scope, ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:note:listShares', withErpAuth('erp.access', async (input: any, ctx) => {
    erpValidate.string(input?.noteId, 'noteId');
    return { shares: svc().listSharesForEmployee(input.noteId, ctx.employeeId) };
  }));
}

