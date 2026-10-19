/**
 * ERP: dự án, công việc, lịch, ghi chú, thông báo, phòng ban, chức vụ, hồ sơ, chấm công, nghỉ phép.
 *
 * Mọi route gọi đúng kênh erp:* mà UI dùng; kiểm tra quyền ERP (RBAC) chạy trong withErpAuth
 * với danh tính của key (ErpAuthContext.runAs). Body giữ đúng định dạng của handler ERP.
 */
import { s, Schema } from '../schema';
import { ApiContext, ApiScope, HttpMethod, route, RouteDef } from '../types';

type InputBuilder = (ctx: ApiContext) => any;

interface ErpOp {
    method: HttpMethod;
    path: string;
    channel: string;
    scope: ApiScope;
    summary: string;
    operationId: string;
    params?: any;
    query?: any;
    body?: Schema<any>;
    input: InputBuilder;
    pick?: string;
    description?: string;
    example?: any;
}

const anyObject = () => s.any('object');
const idParam = s.object({ id: s.id() });
const numIdParam = s.object({ id: s.int().min(1) });

function erp(op: ErpOp): RouteDef {
    return route({
        method: op.method,
        path: op.path,
        scope: op.scope,
        tags: ['ERP'],
        operationId: op.operationId,
        summary: op.summary,
        description: op.description ? `${op.description}\n\nKênh: \`${op.channel}\`` : `Kênh: \`${op.channel}\``,
        params: op.params,
        query: op.query,
        body: op.body,
        examples: op.example ? { request: op.example } : undefined,
        handler: async ctx => {
            const res = await ctx.call(op.channel, op.input(ctx));
            if (!res || typeof res !== 'object') return res ?? null;
            const { success, ...rest } = res;
            return op.pick ? (rest as any)[op.pick] ?? null : rest;
        },
    });
}

export function erpRoutes(): RouteDef[] {
    return [
        // Dự án
        erp({ method: 'GET', path: '/erp/projects', channel: 'erp:project:list', scope: 'erp:read', operationId: 'listErpProjects', summary: 'Dự án', query: s.object({ archived: s.boolean().default(false) }), input: c => ({ archived: c.query.archived }), pick: 'projects' }),
        erp({ method: 'POST', path: '/erp/projects', channel: 'erp:project:create', scope: 'erp:write', operationId: 'createErpProject', summary: 'Tạo dự án', body: s.object({ name: s.string().min(1).max(200), description: s.string().max(5000).optional(), color: s.string().max(20).optional(), department_id: s.any().optional() }), input: c => c.body, pick: 'project' }),
        erp({ method: 'PATCH', path: '/erp/projects/:id', channel: 'erp:project:update', scope: 'erp:write', operationId: 'updateErpProject', summary: 'Sửa dự án', params: idParam, body: anyObject(), input: c => ({ id: c.params.id, patch: c.body || {} }), pick: 'project' }),
        erp({ method: 'DELETE', path: '/erp/projects/:id', channel: 'erp:project:delete', scope: 'erp:write', operationId: 'deleteErpProject', summary: 'Xoá dự án', params: idParam, input: c => ({ id: c.params.id }) }),

        // Công việc
        erp({ method: 'GET', path: '/erp/tasks', channel: 'erp:task:list', scope: 'erp:read', operationId: 'listErpTasks', summary: 'Công việc (lọc theo dự án, trạng thái, người làm...)', description: 'Query được chuyển nguyên cho bộ lọc của trang Công việc (vd: project_id, status, assignee_id, search).', query: s.object({}).passthrough(), input: c => c.query, pick: 'tasks' }),
        erp({ method: 'GET', path: '/erp/tasks/inbox', channel: 'erp:task:listMyInbox', scope: 'erp:read', operationId: 'getErpTaskInbox', summary: 'Hộp việc của tôi', query: s.object({ filter: s.enum(['today', 'week', 'overdue', 'all'] as const).default('week') }), input: c => ({ filter: c.query.filter }), pick: 'tasks' }),
        erp({ method: 'GET', path: '/erp/tasks/:id', channel: 'erp:task:get', scope: 'erp:read', operationId: 'getErpTask', summary: 'Chi tiết công việc', params: idParam, input: c => ({ id: c.params.id }), pick: 'task' }),
        erp({
            method: 'POST', path: '/erp/tasks', channel: 'erp:task:create', scope: 'erp:write', operationId: 'createErpTask', summary: 'Tạo công việc',
            body: s.object({ title: s.string().min(1).max(500) }).passthrough(),
            example: { title: 'Gọi lại khách DH2291', project_id: 'p1', priority: 'high', status: 'todo', due_date: 1760000000000, assignees: ['emp-001'] },
            input: c => ({ input: c.body }), pick: 'task',
        }),
        erp({ method: 'PATCH', path: '/erp/tasks/:id', channel: 'erp:task:update', scope: 'erp:write', operationId: 'updateErpTask', summary: 'Sửa công việc', params: idParam, body: anyObject(), input: c => ({ id: c.params.id, patch: c.body || {} }), pick: 'task' }),
        erp({ method: 'POST', path: '/erp/tasks/:id/status', channel: 'erp:task:updateStatus', scope: 'erp:write', operationId: 'setErpTaskStatus', summary: 'Đổi trạng thái công việc', params: idParam, body: s.object({ status: s.string().min(1).max(30) }), input: c => ({ id: c.params.id, status: c.body.status }), pick: 'task' }),
        erp({ method: 'POST', path: '/erp/tasks/:id/assign', channel: 'erp:task:assign', scope: 'erp:write', operationId: 'assignErpTask', summary: 'Giao việc cho nhân viên', params: idParam, body: s.object({ employee_ids: s.array(s.id()).max(100) }), input: c => ({ id: c.params.id, employeeIds: c.body.employee_ids }) }),
        erp({ method: 'DELETE', path: '/erp/tasks/:id', channel: 'erp:task:delete', scope: 'erp:write', operationId: 'deleteErpTask', summary: 'Xoá công việc', params: idParam, input: c => ({ id: c.params.id }) }),
        erp({ method: 'POST', path: '/erp/tasks/:id/checklist', channel: 'erp:task:addChecklist', scope: 'erp:write', operationId: 'addErpChecklistItem', summary: 'Thêm mục checklist', params: idParam, body: s.object({ content: s.string().min(1).max(1000) }), input: c => ({ taskId: c.params.id, content: c.body.content }), pick: 'item' }),
        erp({ method: 'PATCH', path: '/erp/checklist/:id', channel: 'erp:task:toggleChecklist', scope: 'erp:write', operationId: 'toggleErpChecklistItem', summary: 'Đánh dấu xong/chưa xong mục checklist', params: numIdParam, body: s.object({ done: s.boolean() }), input: c => ({ id: c.params.id, done: c.body.done }), pick: 'item' }),
        erp({ method: 'POST', path: '/erp/tasks/:id/comments', channel: 'erp:task:addComment', scope: 'erp:write', operationId: 'addErpTaskComment', summary: 'Bình luận vào công việc', params: idParam, body: s.object({ content: s.string().min(1).max(10000), mentions: s.array(s.id()).max(50).default([]) }), input: c => ({ taskId: c.params.id, content: c.body.content, mentions: c.body.mentions }), pick: 'comment' }),
        erp({ method: 'PATCH', path: '/erp/comments/:id', channel: 'erp:task:editComment', scope: 'erp:write', operationId: 'editErpTaskComment', summary: 'Sửa bình luận', params: numIdParam, body: s.object({ content: s.string().min(1).max(10000) }), input: c => ({ id: c.params.id, content: c.body.content }), pick: 'comment' }),
        erp({ method: 'DELETE', path: '/erp/comments/:id', channel: 'erp:task:deleteComment', scope: 'erp:write', operationId: 'deleteErpTaskComment', summary: 'Xoá bình luận', params: numIdParam, input: c => ({ id: c.params.id }) }),
        erp({ method: 'POST', path: '/erp/tasks/:id/watchers', channel: 'erp:task:addWatcher', scope: 'erp:write', operationId: 'addErpTaskWatcher', summary: 'Theo dõi công việc', params: idParam, body: s.object({ employee_id: s.id().optional() }).optional(), input: c => ({ taskId: c.params.id, employeeId: c.body?.employee_id }) }),
        erp({ method: 'DELETE', path: '/erp/tasks/:id/watchers/:employeeId', channel: 'erp:task:removeWatcher', scope: 'erp:write', operationId: 'removeErpTaskWatcher', summary: 'Bỏ theo dõi', params: s.object({ id: s.id(), employeeId: s.id() }), input: c => ({ taskId: c.params.id, employeeId: c.params.employeeId }) }),
        erp({ method: 'POST', path: '/erp/tasks/:id/dependencies', channel: 'erp:task:addDependency', scope: 'erp:write', operationId: 'addErpTaskDependency', summary: 'Thêm phụ thuộc', params: idParam, body: s.object({ depends_on_id: s.id() }), input: c => ({ taskId: c.params.id, dependsOnId: c.body.depends_on_id }) }),
        erp({ method: 'DELETE', path: '/erp/tasks/:id/dependencies/:dependsOnId', channel: 'erp:task:removeDependency', scope: 'erp:write', operationId: 'removeErpTaskDependency', summary: 'Bỏ phụ thuộc', params: s.object({ id: s.id(), dependsOnId: s.id() }), input: c => ({ taskId: c.params.id, dependsOnId: c.params.dependsOnId }) }),

        // Lịch
        erp({ method: 'GET', path: '/erp/calendar/events', channel: 'erp:calendar:listEvents', scope: 'erp:read', operationId: 'listErpCalendarEvents', summary: 'Sự kiện lịch trong khoảng thời gian', query: s.object({ from: s.timestamp(), to: s.timestamp(), limit: s.int().min(1).max(1000).optional(), offset: s.int().min(0).optional() }), input: c => c.query, pick: 'events' }),
        erp({
            method: 'POST', path: '/erp/calendar/events', channel: 'erp:calendar:createEvent', scope: 'erp:write', operationId: 'createErpCalendarEvent', summary: 'Tạo sự kiện lịch',
            body: s.object({ title: s.string().min(1).max(300), start_at: s.timestamp() }).passthrough(),
            example: { title: 'Hẹn khách xem nhà', start_at: 1760000000000, end_at: 1760003600000, attendees: ['emp-001'] },
            input: c => ({ input: c.body }), pick: 'event',
        }),
        erp({ method: 'PATCH', path: '/erp/calendar/events/:id', channel: 'erp:calendar:updateEvent', scope: 'erp:write', operationId: 'updateErpCalendarEvent', summary: 'Sửa sự kiện', params: idParam, body: anyObject(), input: c => ({ id: c.params.id, patch: c.body || {} }), pick: 'event' }),
        erp({ method: 'DELETE', path: '/erp/calendar/events/:id', channel: 'erp:calendar:deleteEvent', scope: 'erp:write', operationId: 'deleteErpCalendarEvent', summary: 'Xoá sự kiện', params: idParam, input: c => ({ id: c.params.id }) }),
        erp({ method: 'POST', path: '/erp/calendar/events/:id/respond', channel: 'erp:calendar:respond', scope: 'erp:write', operationId: 'respondErpCalendarEvent', summary: 'Trả lời lời mời (accepted/declined/tentative)', params: idParam, body: s.object({ status: s.string().min(1).max(20) }), input: c => ({ eventId: c.params.id, status: c.body.status }) }),

        // Ghi chú
        erp({ method: 'GET', path: '/erp/notes', channel: 'erp:note:list', scope: 'erp:read', operationId: 'listErpNotes', summary: 'Ghi chú', query: s.object({}).passthrough(), input: c => c.query, pick: 'notes' }),
        erp({ method: 'GET', path: '/erp/notes/:id', channel: 'erp:note:get', scope: 'erp:read', operationId: 'getErpNote', summary: 'Một ghi chú', params: idParam, input: c => ({ id: c.params.id }), pick: 'note' }),
        erp({ method: 'POST', path: '/erp/notes', channel: 'erp:note:create', scope: 'erp:write', operationId: 'createErpNote', summary: 'Tạo ghi chú', body: s.object({ title: s.string().max(500).optional() }).passthrough(), input: c => ({ input: c.body }), pick: 'note' }),
        erp({ method: 'PATCH', path: '/erp/notes/:id', channel: 'erp:note:update', scope: 'erp:write', operationId: 'updateErpNote', summary: 'Sửa ghi chú', params: idParam, body: anyObject(), input: c => ({ id: c.params.id, patch: c.body || {} }), pick: 'note' }),
        erp({ method: 'DELETE', path: '/erp/notes/:id', channel: 'erp:note:delete', scope: 'erp:write', operationId: 'deleteErpNote', summary: 'Xoá ghi chú', params: idParam, input: c => ({ id: c.params.id }) }),
        erp({ method: 'POST', path: '/erp/notes/:id/pin', channel: 'erp:note:pin', scope: 'erp:write', operationId: 'pinErpNote', summary: 'Ghim / bỏ ghim ghi chú', params: idParam, body: s.object({ pinned: s.boolean() }), input: c => ({ id: c.params.id, pinned: c.body.pinned }), pick: 'note' }),
        erp({ method: 'GET', path: '/erp/notes/:id/versions', channel: 'erp:note:versions', scope: 'erp:read', operationId: 'listErpNoteVersions', summary: 'Lịch sử phiên bản ghi chú', params: idParam, input: c => ({ noteId: c.params.id }), pick: 'versions' }),
        erp({ method: 'GET', path: '/erp/note-folders', channel: 'erp:note:listFolders', scope: 'erp:read', operationId: 'listErpNoteFolders', summary: 'Thư mục ghi chú', input: () => ({}), pick: 'folders' }),
        erp({ method: 'GET', path: '/erp/note-tags', channel: 'erp:note:listTags', scope: 'erp:read', operationId: 'listErpNoteTags', summary: 'Tag ghi chú', input: () => ({}), pick: 'tags' }),

        // Thông báo
        erp({ method: 'GET', path: '/erp/notifications', channel: 'erp:notify:listInbox', scope: 'erp:read', operationId: 'listErpNotifications', summary: 'Thông báo ERP', query: s.object({}).passthrough(), input: c => c.query }),
        erp({ method: 'GET', path: '/erp/notifications/unread-count', channel: 'erp:notify:unreadCount', scope: 'erp:read', operationId: 'getErpUnreadCount', summary: 'Số thông báo chưa đọc', input: () => ({}) }),
        erp({ method: 'POST', path: '/erp/notifications/read', channel: 'erp:notify:markRead', scope: 'erp:write', operationId: 'markErpNotificationsRead', summary: 'Đánh dấu đã đọc', body: s.object({ ids: s.array(s.int()).min(1).max(1000) }), input: c => ({ ids: c.body.ids }) }),
        erp({ method: 'POST', path: '/erp/notifications/read-all', channel: 'erp:notify:markAllRead', scope: 'erp:write', operationId: 'markAllErpNotificationsRead', summary: 'Đánh dấu tất cả đã đọc', input: () => ({}) }),

        // Nhân sự
        erp({ method: 'GET', path: '/erp/departments', channel: 'erp:department:list', scope: 'erp:read', operationId: 'listErpDepartments', summary: 'Phòng ban', input: () => ({}), pick: 'departments' }),
        erp({ method: 'POST', path: '/erp/departments', channel: 'erp:department:create', scope: 'erp:write', operationId: 'createErpDepartment', summary: 'Tạo phòng ban', body: s.object({ name: s.string().min(1).max(200) }).passthrough(), input: c => c.body, pick: 'department' }),
        erp({ method: 'PATCH', path: '/erp/departments/:id', channel: 'erp:department:update', scope: 'erp:write', operationId: 'updateErpDepartment', summary: 'Sửa phòng ban', params: numIdParam, body: anyObject(), input: c => ({ id: c.params.id, patch: c.body || {} }), pick: 'department' }),
        erp({ method: 'DELETE', path: '/erp/departments/:id', channel: 'erp:department:delete', scope: 'erp:write', operationId: 'deleteErpDepartment', summary: 'Xoá phòng ban', params: numIdParam, input: c => ({ id: c.params.id }) }),
        erp({ method: 'GET', path: '/erp/positions', channel: 'erp:position:list', scope: 'erp:read', operationId: 'listErpPositions', summary: 'Chức vụ', input: () => ({}), pick: 'positions' }),
        erp({ method: 'GET', path: '/erp/profiles', channel: 'erp:employee:listByDepartment', scope: 'erp:read', operationId: 'listErpProfiles', summary: 'Hồ sơ nhân sự (theo phòng ban)', query: s.object({ department_id: s.int().optional() }), input: c => ({ departmentId: c.query.department_id }) }),
        erp({ method: 'GET', path: '/erp/profiles/:employeeId', channel: 'erp:employee:getProfile', scope: 'erp:read', operationId: 'getErpProfile', summary: 'Hồ sơ một nhân sự', params: s.object({ employeeId: s.id() }), input: c => ({ employeeId: c.params.employeeId }), pick: 'profile' }),
        erp({ method: 'GET', path: '/erp/attendance', channel: 'erp:attendance:list', scope: 'erp:read', operationId: 'listErpAttendance', summary: 'Bảng chấm công', query: s.object({}).passthrough(), input: c => c.query }),
        erp({ method: 'GET', path: '/erp/leaves/pending', channel: 'erp:leave:listPending', scope: 'erp:read', operationId: 'listPendingErpLeaves', summary: 'Đơn nghỉ phép chờ duyệt', input: () => ({}) }),
        erp({ method: 'POST', path: '/erp/leaves/:id/decide', channel: 'erp:leave:decide', scope: 'erp:write', operationId: 'decideErpLeave', summary: 'Duyệt / từ chối đơn nghỉ', params: numIdParam, body: s.object({ status: s.enum(['approved', 'rejected'] as const), note: s.string().max(1000).optional() }), input: c => ({ id: c.params.id, status: c.body.status, note: c.body.note }), pick: 'leave' }),
    ];
}
