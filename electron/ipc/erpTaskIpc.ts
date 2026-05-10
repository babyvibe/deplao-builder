import { ipcMain } from 'electron';
import ErpTaskService from '../../src/services/erp/ErpTaskService';
import { withErpAuth, erpValidate } from './erpIpcMiddleware';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const STATUSES   = ['todo', 'doing', 'review', 'done', 'cancelled'] as const;

function ensureAssignmentPermission(employeeIds: string[], ctx: any) {
  if (!employeeIds.length) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { erpCan } = require('../../src/services/erp/permissions');
  const uniqueIds = Array.from(new Set(employeeIds.filter(Boolean)));
  const isSelfOnly = uniqueIds.length === 1 && uniqueIds[0] === ctx.employeeId;
  const action = isSelfOnly ? 'task.assign_self' : 'task.assign_others';
  if (!erpCan(ctx.role, action)) throw new Error(`Permission denied: ${action}`);
}

export function registerErpTaskIpc(): void {
  const svc = () => ErpTaskService.getInstance();

  // ─── Projects ──────────────────────────────────────────────────────────────

  ipcMain.handle('erp:project:list', withErpAuth('erp.access', async (input: any) => ({
    projects: svc().listProjects({ archived: !!input?.archived }),
  })));

  ipcMain.handle('erp:project:create', withErpAuth('project.create', async (input: any, ctx) => {
    erpValidate.string(input?.name, 'name', { max: 200 });
    return { project: svc().createProject({
      name: input.name,
      description: input.description,
      color: input.color,
      department_id: input.department_id,
    }, ctx.employeeId) };
  }));

  ipcMain.handle('erp:project:update', withErpAuth('project.update', async (input: any) => {
    erpValidate.string(input?.id, 'id');
    return { project: svc().updateProject(input.id, input.patch ?? {}) };
  }));

  ipcMain.handle('erp:project:delete', withErpAuth('project.delete', async (input: any) => {
    erpValidate.string(input?.id, 'id');
    svc().deleteProject(input.id);
    return {};
  }));

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  ipcMain.handle('erp:task:list', withErpAuth('erp.access', async (input: any) => ({
    tasks: svc().listTasks(input ?? {}),
  })));

  ipcMain.handle('erp:task:get', withErpAuth('erp.access', async (input: any) => {
    erpValidate.string(input?.id, 'id');
    const task = svc().getTaskDetail(input.id);
    if (!task) throw new Error('Không tìm thấy task');
    return { task };
  }));

  ipcMain.handle('erp:task:create', withErpAuth('task.create', async (input: any, ctx) => {
    erpValidate.string(input?.input?.title, 'title', { max: 500 });
    if (input.input.priority) erpValidate.enum(input.input.priority, 'priority', PRIORITIES);
    if (input.input.status) erpValidate.enum(input.input.status, 'status', STATUSES);
    const employeeIds: string[] = Array.isArray(input?.input?.assignees) ? input.input.assignees.filter(Boolean) : [];
    ensureAssignmentPermission(employeeIds, ctx);
    return { task: svc().createTask(input.input, ctx.employeeId) };
  }));

  ipcMain.handle('erp:task:update', withErpAuth('task.update', async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    if (input.patch?.title !== undefined) erpValidate.string(input.patch.title, 'title', { max: 500 });
    if (input.patch?.priority) erpValidate.enum(input.patch.priority, 'priority', PRIORITIES);
    if (input.patch?.status)   erpValidate.enum(input.patch.status,   'status',   STATUSES);
    const employeeIds: string[] = Array.isArray(input?.patch?.assignees) ? input.patch.assignees.filter(Boolean) : [];
    ensureAssignmentPermission(employeeIds, ctx);
    return { task: svc().updateTask(input.id, input.patch ?? {}, ctx.employeeId) };
  }));

  ipcMain.handle('erp:task:updateStatus', withErpAuth('task.update', async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    erpValidate.enum(input?.status, 'status', STATUSES);
    return { task: svc().updateTask(input.id, { status: input.status }, ctx.employeeId) };
  }));

  ipcMain.handle('erp:task:assign', withErpAuth(null, async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    const employeeIds: string[] = Array.isArray(input?.employeeIds) ? input.employeeIds : [];
    // Self-assign vs assigning others have different perms.
    const isSelfOnly = employeeIds.length === 1 && employeeIds[0] === ctx.employeeId;
    const action = isSelfOnly ? 'task.assign_self' : 'task.assign_others';
    // Defensive re-check.
    const { erpCan } = require('../../src/services/erp/permissions');
    if (!erpCan(ctx.role, action)) throw new Error(`Permission denied: ${action}`);
    svc().assignTask(input.id, employeeIds, ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:task:delete', withErpAuth('task.delete', async (input: any) => {
    erpValidate.string(input?.id, 'id');
    svc().deleteTask(input.id);
    return {};
  }));

  ipcMain.handle('erp:task:addChecklist', withErpAuth('task.update', async (input: any) => {
    erpValidate.string(input?.taskId, 'taskId');
    erpValidate.string(input?.content, 'content', { max: 500 });
    return { item: svc().addChecklist(input.taskId, input.content) };
  }));

  ipcMain.handle('erp:task:toggleChecklist', withErpAuth('task.update', async (input: any) => {
    erpValidate.int(input?.id, 'id');
    return { item: svc().toggleChecklist(Number(input.id), !!input.done) };
  }));

  ipcMain.handle('erp:task:addComment', withErpAuth('task.comment', async (input: any, ctx) => {
    erpValidate.string(input?.taskId, 'taskId');
    erpValidate.string(input?.content, 'content', { max: 5000 });
    return { comment: svc().addComment(input.taskId, ctx.employeeId, input.content, input.mentions ?? []) };
  }));

  ipcMain.handle('erp:task:editComment', withErpAuth('task.comment', async (input: any) => {
    erpValidate.int(input?.id, 'id');
    erpValidate.string(input?.content, 'content', { max: 5000 });
    return { comment: svc().editComment(Number(input.id), input.content) };
  }));

  ipcMain.handle('erp:task:deleteComment', withErpAuth('task.comment', async (input: any) => {
    erpValidate.int(input?.id, 'id');
    svc().deleteComment(Number(input.id));
    return {};
  }));

  ipcMain.handle('erp:task:listMyInbox', withErpAuth('erp.access', async (input: any, ctx) => ({
    tasks: svc().getMyInbox(ctx.employeeId, input?.filter || 'week'),
  })));

  // ─── Watchers / Dependencies (Phase 2) ───────────────────────────────────

  ipcMain.handle('erp:task:addWatcher', withErpAuth('task.update', async (input: any, ctx) => {
    erpValidate.string(input?.taskId, 'taskId');
    svc().addWatcher(input.taskId, input?.employeeId || ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:task:removeWatcher', withErpAuth('task.update', async (input: any, ctx) => {
    erpValidate.string(input?.taskId, 'taskId');
    svc().removeWatcher(input.taskId, input?.employeeId || ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:task:addDependency', withErpAuth('task.update', async (input: any) => {
    erpValidate.string(input?.taskId, 'taskId');
    erpValidate.string(input?.dependsOnId, 'dependsOnId');
    const type = (input?.type as 'FS' | 'SS' | 'FF' | 'SF') || 'FS';
    svc().addDependency(input.taskId, input.dependsOnId, type);
    return {};
  }));

  ipcMain.handle('erp:task:removeDependency', withErpAuth('task.update', async (input: any) => {
    erpValidate.string(input?.taskId, 'taskId');
    erpValidate.string(input?.dependsOnId, 'dependsOnId');
    svc().removeDependency(input.taskId, input.dependsOnId);
    return {};
  }));
}

