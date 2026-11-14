import { ipcMain } from 'electron';
import ErpTaskService from '../../../src/services/erp/ErpTaskService';
import type { ErpAuthCtx } from '../../../src/services/erp/ErpAuthContext';
import { assignmentAction, taskDeleteAction } from '../../../src/services/erp/erpAccessRules';
import { withErpAuth, erpValidate, erpAllowed, requireErpPermission } from './erpIpcMiddleware';
import { tr } from '../../../src/shared/i18n';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const STATUSES   = ['todo', 'doing', 'review', 'done', 'cancelled'] as const;

/** Task assignment permission based on a CHANGE of the assignee compared with the current one (erpAccessRules.assignmentAction). */
function ensureAssignmentPermission(nextIds: string[], currentIds: string[], ctx: ErpAuthCtx) {
  const action = assignmentAction(nextIds, currentIds, ctx.employeeId);
  if (action) requireErpPermission(action, ctx);
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
    if (!task) throw new Error(tr('Không tìm thấy task'));
    return { task };
  }));

  ipcMain.handle('erp:task:create', withErpAuth('task.create', async (input: any, ctx) => {
    erpValidate.string(input?.input?.title, 'title', { max: 500 });
    if (input.input.priority) erpValidate.enum(input.input.priority, 'priority', PRIORITIES);
    if (input.input.status) erpValidate.enum(input.input.status, 'status', STATUSES);
    const employeeIds: string[] = Array.isArray(input?.input?.assignees) ? input.input.assignees.filter(Boolean) : [];
    ensureAssignmentPermission(employeeIds, [], ctx);
    return { task: svc().createTask(input.input, ctx.employeeId) };
  }));

  ipcMain.handle('erp:task:update', withErpAuth('task.update', async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    if (input.patch?.title !== undefined) erpValidate.string(input.patch.title, 'title', { max: 500 });
    if (input.patch?.priority) erpValidate.enum(input.patch.priority, 'priority', PRIORITIES);
    if (input.patch?.status)   erpValidate.enum(input.patch.status,   'status',   STATUSES);
    if (input.patch?.assignees !== undefined) {
      const employeeIds: string[] = Array.isArray(input.patch.assignees) ? input.patch.assignees.filter(Boolean) : [];
      ensureAssignmentPermission(employeeIds, svc().getTaskAssignees(input.id), ctx);
    }
    return { task: svc().updateTask(input.id, input.patch ?? {}, ctx.employeeId) };
  }));

  ipcMain.handle('erp:task:updateStatus', withErpAuth('task.update', async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    erpValidate.enum(input?.status, 'status', STATUSES);
    return { task: svc().updateTask(input.id, { status: input.status }, ctx.employeeId) };
  }));

  ipcMain.handle('erp:task:assign', withErpAuth(null, async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    const employeeIds: string[] = Array.isArray(input?.employeeIds) ? input.employeeIds.filter(Boolean) : [];
    // Self-assign (assign_self) is different from assigning to others (assign_others): checked by the change compared with the current value
    ensureAssignmentPermission(employeeIds, svc().getTaskAssignees(input.id), ctx);
    svc().assignTask(input.id, employeeIds, ctx.employeeId);
    return {};
  }));

  // The task creator can delete their own task (needs task edit permission); other people's tasks need task.delete
  // (the same rules as the employee REST before, now in one place for the Boss UI, employees and the API).
  ipcMain.handle('erp:task:delete', withErpAuth(null, async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    const reporterId = svc().getTaskReporterId(input.id);
    if (reporterId === undefined) throw new Error(tr('Không tìm thấy task'));
    const action = taskDeleteAction(reporterId, ctx.employeeId, erpAllowed('task.update', ctx));
    if (action) requireErpPermission(action, ctx);
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

  // Edit / delete a comment: its author, or someone who can edit every task (before, anyone with task.comment could edit / delete
  // other people's comments by id)
  const ensureCommentAuthor = (commentId: number, ctx: ErpAuthCtx) => {
    const authorId = svc().getCommentAuthorId(commentId);
    if (authorId === undefined) throw new Error(tr('Không tìm thấy bình luận'));
    if (authorId !== ctx.employeeId) requireErpPermission('task.edit_any', ctx);
  };

  ipcMain.handle('erp:task:editComment', withErpAuth('task.comment', async (input: any, ctx) => {
    erpValidate.int(input?.id, 'id');
    erpValidate.string(input?.content, 'content', { max: 5000 });
    ensureCommentAuthor(Number(input.id), ctx);
    return { comment: svc().editComment(Number(input.id), input.content) };
  }));

  ipcMain.handle('erp:task:deleteComment', withErpAuth('task.comment', async (input: any, ctx) => {
    erpValidate.int(input?.id, 'id');
    ensureCommentAuthor(Number(input.id), ctx);
    svc().deleteComment(Number(input.id));
    return {};
  }));

  ipcMain.handle('erp:task:listMyInbox', withErpAuth('erp.access', async (input: any, ctx) => {
    const viewAll = erpAllowed('task.edit_any', ctx); // owner, admin, manager (+ own permissions)
    return { tasks: svc().getMyInbox(ctx.employeeId, input?.filter || 'week', viewAll) };
  }));

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

