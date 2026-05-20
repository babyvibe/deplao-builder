"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerErpTaskIpc = registerErpTaskIpc;
const electron_1 = require("electron");
const ErpTaskService_1 = __importDefault(require("../../src/services/erp/ErpTaskService"));
const erpIpcMiddleware_1 = require("./erpIpcMiddleware");
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['todo', 'doing', 'review', 'done', 'cancelled'];
function ensureAssignmentPermission(employeeIds, ctx) {
    if (!employeeIds.length)
        return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { erpCan } = require('../../src/services/erp/permissions');
    const uniqueIds = Array.from(new Set(employeeIds.filter(Boolean)));
    const isSelfOnly = uniqueIds.length === 1 && uniqueIds[0] === ctx.employeeId;
    const action = isSelfOnly ? 'task.assign_self' : 'task.assign_others';
    if (!erpCan(ctx.role, action))
        throw new Error(`Permission denied: ${action}`);
}
function registerErpTaskIpc() {
    const svc = () => ErpTaskService_1.default.getInstance();
    // ─── Projects ──────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('erp:project:list', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input) => ({
        projects: svc().listProjects({ archived: !!input?.archived }),
    })));
    electron_1.ipcMain.handle('erp:project:create', (0, erpIpcMiddleware_1.withErpAuth)('project.create', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.name, 'name', { max: 200 });
        return { project: svc().createProject({
                name: input.name,
                description: input.description,
                color: input.color,
                department_id: input.department_id,
            }, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:project:update', (0, erpIpcMiddleware_1.withErpAuth)('project.update', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        return { project: svc().updateProject(input.id, input.patch ?? {}) };
    }));
    electron_1.ipcMain.handle('erp:project:delete', (0, erpIpcMiddleware_1.withErpAuth)('project.delete', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        svc().deleteProject(input.id);
        return {};
    }));
    // ─── Tasks ─────────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('erp:task:list', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input) => ({
        tasks: svc().listTasks(input ?? {}),
    })));
    electron_1.ipcMain.handle('erp:task:get', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        const task = svc().getTaskDetail(input.id);
        if (!task)
            throw new Error('Không tìm thấy task');
        return { task };
    }));
    electron_1.ipcMain.handle('erp:task:create', (0, erpIpcMiddleware_1.withErpAuth)('task.create', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.input?.title, 'title', { max: 500 });
        if (input.input.priority)
            erpIpcMiddleware_1.erpValidate.enum(input.input.priority, 'priority', PRIORITIES);
        if (input.input.status)
            erpIpcMiddleware_1.erpValidate.enum(input.input.status, 'status', STATUSES);
        const employeeIds = Array.isArray(input?.input?.assignees) ? input.input.assignees.filter(Boolean) : [];
        ensureAssignmentPermission(employeeIds, ctx);
        return { task: svc().createTask(input.input, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:task:update', (0, erpIpcMiddleware_1.withErpAuth)('task.update', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        if (input.patch?.title !== undefined)
            erpIpcMiddleware_1.erpValidate.string(input.patch.title, 'title', { max: 500 });
        if (input.patch?.priority)
            erpIpcMiddleware_1.erpValidate.enum(input.patch.priority, 'priority', PRIORITIES);
        if (input.patch?.status)
            erpIpcMiddleware_1.erpValidate.enum(input.patch.status, 'status', STATUSES);
        const employeeIds = Array.isArray(input?.patch?.assignees) ? input.patch.assignees.filter(Boolean) : [];
        ensureAssignmentPermission(employeeIds, ctx);
        return { task: svc().updateTask(input.id, input.patch ?? {}, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:task:updateStatus', (0, erpIpcMiddleware_1.withErpAuth)('task.update', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        erpIpcMiddleware_1.erpValidate.enum(input?.status, 'status', STATUSES);
        return { task: svc().updateTask(input.id, { status: input.status }, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:task:assign', (0, erpIpcMiddleware_1.withErpAuth)(null, async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        const employeeIds = Array.isArray(input?.employeeIds) ? input.employeeIds : [];
        // Self-assign vs assigning others have different perms.
        const isSelfOnly = employeeIds.length === 1 && employeeIds[0] === ctx.employeeId;
        const action = isSelfOnly ? 'task.assign_self' : 'task.assign_others';
        // Defensive re-check.
        const { erpCan } = require('../../src/services/erp/permissions');
        if (!erpCan(ctx.role, action))
            throw new Error(`Permission denied: ${action}`);
        svc().assignTask(input.id, employeeIds, ctx.employeeId);
        return {};
    }));
    electron_1.ipcMain.handle('erp:task:delete', (0, erpIpcMiddleware_1.withErpAuth)('task.delete', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        svc().deleteTask(input.id);
        return {};
    }));
    electron_1.ipcMain.handle('erp:task:addChecklist', (0, erpIpcMiddleware_1.withErpAuth)('task.update', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.taskId, 'taskId');
        erpIpcMiddleware_1.erpValidate.string(input?.content, 'content', { max: 500 });
        return { item: svc().addChecklist(input.taskId, input.content) };
    }));
    electron_1.ipcMain.handle('erp:task:toggleChecklist', (0, erpIpcMiddleware_1.withErpAuth)('task.update', async (input) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        return { item: svc().toggleChecklist(Number(input.id), !!input.done) };
    }));
    electron_1.ipcMain.handle('erp:task:addComment', (0, erpIpcMiddleware_1.withErpAuth)('task.comment', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.taskId, 'taskId');
        erpIpcMiddleware_1.erpValidate.string(input?.content, 'content', { max: 5000 });
        return { comment: svc().addComment(input.taskId, ctx.employeeId, input.content, input.mentions ?? []) };
    }));
    electron_1.ipcMain.handle('erp:task:editComment', (0, erpIpcMiddleware_1.withErpAuth)('task.comment', async (input) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        erpIpcMiddleware_1.erpValidate.string(input?.content, 'content', { max: 5000 });
        return { comment: svc().editComment(Number(input.id), input.content) };
    }));
    electron_1.ipcMain.handle('erp:task:deleteComment', (0, erpIpcMiddleware_1.withErpAuth)('task.comment', async (input) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        svc().deleteComment(Number(input.id));
        return {};
    }));
    electron_1.ipcMain.handle('erp:task:listMyInbox', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input, ctx) => ({
        tasks: svc().getMyInbox(ctx.employeeId, input?.filter || 'week'),
    })));
    // ─── Watchers / Dependencies (Phase 2) ───────────────────────────────────
    electron_1.ipcMain.handle('erp:task:addWatcher', (0, erpIpcMiddleware_1.withErpAuth)('task.update', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.taskId, 'taskId');
        svc().addWatcher(input.taskId, input?.employeeId || ctx.employeeId);
        return {};
    }));
    electron_1.ipcMain.handle('erp:task:removeWatcher', (0, erpIpcMiddleware_1.withErpAuth)('task.update', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.taskId, 'taskId');
        svc().removeWatcher(input.taskId, input?.employeeId || ctx.employeeId);
        return {};
    }));
    electron_1.ipcMain.handle('erp:task:addDependency', (0, erpIpcMiddleware_1.withErpAuth)('task.update', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.taskId, 'taskId');
        erpIpcMiddleware_1.erpValidate.string(input?.dependsOnId, 'dependsOnId');
        const type = input?.type || 'FS';
        svc().addDependency(input.taskId, input.dependsOnId, type);
        return {};
    }));
    electron_1.ipcMain.handle('erp:task:removeDependency', (0, erpIpcMiddleware_1.withErpAuth)('task.update', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.taskId, 'taskId');
        erpIpcMiddleware_1.erpValidate.string(input?.dependsOnId, 'dependsOnId');
        svc().removeDependency(input.taskId, input.dependsOnId);
        return {};
    }));
}
//# sourceMappingURL=erpTaskIpc.js.map