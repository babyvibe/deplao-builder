/**
 * ErpRestRoutes — ERP qua REST của nhân viên (Boss phục vụ): bảng route → kênh IPC erp:* (phần thuần, có test).
 *
 * Máy nhân viên không giữ dữ liệu ERP: DataAccessor gửi REST → Boss chạy ĐÚNG handler IPC erp:* mà UI Boss dùng
 * (cùng kiểm tra, cùng service, cùng event realtime, cùng phong bì `{ success, ...trường, error, code }`) với danh tính
 * ERP của nhân viên (HttpRelayService.executeErpRest: ErpAuthContext.forEmployee → runAs). Người làm KHÔNG BAO GIỜ lấy
 * từ tham số — id nhân viên trong tham số chỉ là đối tượng (giao việc, người theo dõi, hồ sơ cần xem / sửa…).
 *
 *  - `action` = ĐÚNG chuỗi quyền handler truyền cho withErpAuth (null = handler tự kiểm tra theo tham số: giao việc,
 *    sửa hồ sơ, xem chấm công người khác). Boss kiểm tra quyền module 'erp' (employeeAccess / restCommandPolicy) và
 *    `action` TRƯỚC khi vào IPC → 403 `permission_denied`; withErpAuth kiểm tra lại cùng action.
 *    erpRestRoutes.test.ts đối chiếu bảng với electron/ipc/erp*Ipc.ts: mọi kênh có route, cùng action.
 *  - `input(req)` dựng tham số handler từ tham số REST + phần động của đường dẫn. Query GET là CHUỖI → ép kiểu
 *    (`archived=false` không được thành true, `all=true` phải là boolean như handler so `=== true`).
 *  - Thứ tự: route cụ thể đứng trước route có `:tham_số` (route khớp đầu tiên thắng); `when` chọn biến thể theo body.
 *
 * Trước đây chỉ dự án / công việc / lịch có route (gọi thẳng service, KHÔNG kiểm tra quyền ERP — nhân viên vượt RBAC
 * được: tạo task giao cho người khác, sửa / xoá lịch của người khác, đọc lịch theo organizerId tuỳ ý); ghi chú, nhân sự,
 * chấm công, nghỉ phép, thông báo đi IPC trên máy nhân viên → đọc / ghi DB cục bộ, Boss và nhân viên khác không thấy.
 */

export type ErpRestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Tham số route nhận: query (GET) / body JSON (lệnh) + phần động của đường dẫn (đã giải mã %xx). */
export interface ErpRestRequest {
  params: Record<string, any>;
  path: Record<string, string>;
}

export interface ErpRestRoute {
  methods: readonly ErpRestMethod[];
  /** Mẫu đường dẫn, `:ten` = một đoạn động. */
  path: string;
  /** Kênh IPC erp:* trên Boss. */
  channel: string;
  /** Chuỗi quyền của withErpAuth trong handler (null = handler tự kiểm tra). */
  action: string | null;
  /** Biến thể theo tham số (vd `action: 'remove'`) — không khớp thì xét route sau. */
  when?: (params: Record<string, any>) => boolean;
  input: (req: ErpRestRequest) => Record<string, unknown>;
}

export interface ErpRestMatch {
  route: ErpRestRoute;
  path: Record<string, string>;
  /** Tham số gửi cho handler IPC. */
  input: Record<string, any>;
}

export const ERP_REST_MODULE = 'erp';
export const ERP_REST_QUERY_PREFIX = '/api/query/erp/';
export const ERP_REST_COMMAND_PREFIX = '/api/command/erp/';

export function isErpRestPath(pathname: string): boolean {
  const p = String(pathname || '');
  return p.startsWith(ERP_REST_QUERY_PREFIX) || p.startsWith(ERP_REST_COMMAND_PREFIX);
}

// ── Ép kiểu tham số ─────────────────────────────────────────────────────────────────────────────────────────────

/** Có giá trị (query bỏ khoá rỗng; body có thể gửi null). */
function given(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function str(v: unknown): string | undefined {
  return given(v) ? String(v) : undefined;
}

/** `true` / "true" / 1 / "1" → true; còn lại false (query "false" KHÔNG thành true). */
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === 'true' || v === '1';
}

/** Số từ query / body; không phải số → giữ nguyên để handler báo lỗi kiểm tra (erpValidate.int). */
function num(v: unknown): unknown {
  if (!given(v)) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : v;
}

/** Như num, nhưng "null" / null → null (query không gửi được null: DataAccessor mã hoá thành "null"). */
function nullableNum(v: unknown): unknown {
  if (v === null || v === 'null') return null;
  return num(v);
}

function nullableStr(v: unknown): string | null | undefined {
  if (v === null || v === 'null') return null;
  return str(v);
}

function obj(v: unknown): Record<string, any> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
}

/** Mảng từ body / query (mảng JSON đã parse hoặc "a,b"). */
function list(v: unknown): unknown[] | undefined {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
}

/** Bỏ khoá undefined (handler phân biệt "không gửi" với "gửi rỗng", vd parentTaskId / folderId). */
function compact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k] = v;
  return out;
}

const GET: readonly ErpRestMethod[] = ['GET'];
const POST: readonly ErpRestMethod[] = ['POST'];
const UPDATE: readonly ErpRestMethod[] = ['PATCH', 'PUT'];
const DELETE: readonly ErpRestMethod[] = ['DELETE'];
/** Lệnh "bật / đổi một trường" — DataAccessor dùng PATCH, nhận thêm POST / PUT. */
const ACTION: readonly ErpRestMethod[] = ['PATCH', 'PUT', 'POST'];

const none = (): Record<string, unknown> => ({});
const patchOf = (p: Record<string, any>) => obj(p.patch) ?? {};

/**
 * Bảng route ERP. Mỗi kênh erp:* có ít nhất một route (test kiểm tra). Đường dẫn cũ (DataAccessor bản trước) giữ
 * nguyên: tasks/assign, tasks/watcher, tasks/comment, tasks/checklist…, calendar, calendar/:id.
 */
export const ERP_REST_ROUTES: readonly ErpRestRoute[] = [
  // ── Dự án ──
  { methods: GET, path: '/api/query/erp/projects', channel: 'erp:project:list', action: 'erp.access',
    input: ({ params: p }) => ({ archived: bool(p.archived) }) },
  { methods: POST, path: '/api/command/erp/projects', channel: 'erp:project:create', action: 'project.create',
    input: ({ params: p }) => ({ name: p.name, description: p.description, color: p.color, department_id: p.department_id }) },
  { methods: UPDATE, path: '/api/command/erp/projects/:id', channel: 'erp:project:update', action: 'project.update',
    input: ({ params: p, path }) => ({ id: path.id, patch: patchOf(p) }) },
  { methods: DELETE, path: '/api/command/erp/projects/:id', channel: 'erp:project:delete', action: 'project.delete',
    input: ({ path }) => ({ id: path.id }) },

  // ── Công việc ──
  { methods: GET, path: '/api/query/erp/tasks', channel: 'erp:task:list', action: 'erp.access',
    input: ({ params: p }) => compact({
      projectId: str(p.projectId),
      assigneeId: str(p.assigneeId),
      priority: str(p.priority),
      status: str(p.status),
      dueRange: Array.isArray(p.dueRange) && p.dueRange.length === 2 ? p.dueRange.map(Number) : undefined,
      search: str(p.search),
      archived: given(p.archived) ? bool(p.archived) : undefined,
      parentTaskId: nullableStr(p.parentTaskId),
      limit: num(p.limit),
      offset: num(p.offset),
    }) },
  // ⚠️ /tasks/inbox phải đứng trước /tasks/:id
  { methods: GET, path: '/api/query/erp/tasks/inbox', channel: 'erp:task:listMyInbox', action: 'erp.access',
    input: ({ params: p }) => compact({ filter: str(p.filter) }) },
  { methods: GET, path: '/api/query/erp/tasks/:id', channel: 'erp:task:get', action: 'erp.access',
    input: ({ path }) => ({ id: path.id }) },
  { methods: POST, path: '/api/command/erp/tasks', channel: 'erp:task:create', action: 'task.create',
    input: ({ params: p }) => ({ input: obj(p.input) ?? {} }) },
  // Đường dẫn tên riêng (POST) trước /tasks/:id (PATCH/PUT/DELETE)
  { methods: POST, path: '/api/command/erp/tasks/assign', channel: 'erp:task:assign', action: null,
    input: ({ params: p }) => ({ id: str(p.id), employeeIds: list(p.employeeIds) ?? [] }) },
  { methods: POST, path: '/api/command/erp/tasks/watcher', channel: 'erp:task:removeWatcher', action: 'task.update',
    when: (p) => p.action === 'remove',
    input: ({ params: p }) => compact({ taskId: str(p.taskId), employeeId: str(p.employeeId) }) },
  { methods: POST, path: '/api/command/erp/tasks/watcher', channel: 'erp:task:addWatcher', action: 'task.update',
    input: ({ params: p }) => compact({ taskId: str(p.taskId), employeeId: str(p.employeeId) }) },
  { methods: POST, path: '/api/command/erp/tasks/dependency', channel: 'erp:task:removeDependency', action: 'task.update',
    when: (p) => p.action === 'remove',
    input: ({ params: p }) => ({ taskId: str(p.taskId), dependsOnId: str(p.dependsOnId) }) },
  { methods: POST, path: '/api/command/erp/tasks/dependency', channel: 'erp:task:addDependency', action: 'task.update',
    input: ({ params: p }) => compact({ taskId: str(p.taskId), dependsOnId: str(p.dependsOnId), type: str(p.type) }) },
  { methods: POST, path: '/api/command/erp/tasks/comment', channel: 'erp:task:addComment', action: 'task.comment',
    input: ({ params: p }) => ({ taskId: str(p.taskId), content: p.content, mentions: list(p.mentions) ?? [] }) },
  { methods: UPDATE, path: '/api/command/erp/tasks/comments/:id', channel: 'erp:task:editComment', action: 'task.comment',
    input: ({ params: p, path }) => ({ id: num(path.id), content: p.content }) },
  { methods: DELETE, path: '/api/command/erp/tasks/comments/:id', channel: 'erp:task:deleteComment', action: 'task.comment',
    input: ({ path }) => ({ id: num(path.id) }) },
  { methods: POST, path: '/api/command/erp/tasks/checklist', channel: 'erp:task:addChecklist', action: 'task.update',
    input: ({ params: p }) => ({ taskId: str(p.taskId), content: p.content }) },
  { methods: ACTION, path: '/api/command/erp/tasks/checklist/:id/toggle', channel: 'erp:task:toggleChecklist', action: 'task.update',
    input: ({ params: p, path }) => ({ id: num(path.id), done: bool(p.done) }) },
  { methods: ACTION, path: '/api/command/erp/tasks/:id/status', channel: 'erp:task:updateStatus', action: 'task.update',
    input: ({ params: p, path }) => ({ id: path.id, status: p.status }) },
  { methods: UPDATE, path: '/api/command/erp/tasks/:id', channel: 'erp:task:update', action: 'task.update',
    input: ({ params: p, path }) => ({ id: path.id, patch: patchOf(p) }) },
  // Người tạo xoá được task của mình, task khác cần task.delete — handler kiểm tra (erpAccessRules.taskDeleteAction)
  { methods: DELETE, path: '/api/command/erp/tasks/:id', channel: 'erp:task:delete', action: null,
    input: ({ path }) => ({ id: path.id }) },

  // ── Lịch (chỉ sự kiện mình tổ chức / được mời — handler lọc theo danh tính) ──
  { methods: GET, path: '/api/query/erp/calendar/events', channel: 'erp:calendar:listEvents', action: 'calendar.view',
    input: ({ params: p }) => compact({ from: num(p.from), to: num(p.to), limit: num(p.limit), offset: num(p.offset) }) },
  { methods: GET, path: '/api/query/erp/calendar/conflicts', channel: 'erp:calendar:checkConflict', action: 'calendar.view',
    input: ({ params: p }) => compact({
      employeeIds: list(p.employeeIds),
      start_at: num(p.start_at),
      end_at: num(p.end_at),
      excludeEventId: str(p.excludeEventId),
    }) },
  { methods: POST, path: '/api/command/erp/calendar', channel: 'erp:calendar:createEvent', action: 'calendar.create_personal',
    input: ({ params: p }) => ({ input: obj(p.input) ?? {} }) },
  { methods: POST, path: '/api/command/erp/calendar/:id/respond', channel: 'erp:calendar:respond', action: 'calendar.update',
    input: ({ params: p, path }) => ({ eventId: path.id, status: p.status }) },
  { methods: UPDATE, path: '/api/command/erp/calendar/:id', channel: 'erp:calendar:updateEvent', action: 'calendar.update',
    input: ({ params: p, path }) => ({ id: path.id, patch: patchOf(p) }) },
  { methods: DELETE, path: '/api/command/erp/calendar/:id', channel: 'erp:calendar:deleteEvent', action: 'calendar.delete',
    input: ({ path }) => ({ id: path.id }) },

  // ── Ghi chú (phạm vi: tác giả / chia sẻ / workspace — handler lọc theo danh tính) ──
  { methods: GET, path: '/api/query/erp/note-folders', channel: 'erp:note:listFolders', action: 'erp.access', input: none },
  { methods: POST, path: '/api/command/erp/note-folders', channel: 'erp:note:createFolder', action: 'note.create',
    input: ({ params: p }) => compact({ name: p.name, parent_id: num(p.parent_id) }) },
  { methods: UPDATE, path: '/api/command/erp/note-folders/:id', channel: 'erp:note:renameFolder', action: 'note.update',
    input: ({ params: p, path }) => ({ id: num(path.id), name: p.name }) },
  { methods: DELETE, path: '/api/command/erp/note-folders/:id', channel: 'erp:note:deleteFolder', action: 'note.delete',
    input: ({ path }) => ({ id: num(path.id) }) },
  { methods: GET, path: '/api/query/erp/note-tags', channel: 'erp:note:listTags', action: 'erp.access', input: none },
  { methods: POST, path: '/api/command/erp/note-tags', channel: 'erp:note:createTag', action: 'note.create',
    input: ({ params: p }) => compact({ name: p.name, color: str(p.color) }) },
  { methods: POST, path: '/api/command/erp/note-versions/:versionId/restore', channel: 'erp:note:restoreVersion', action: 'note.update',
    input: ({ path }) => ({ versionId: num(path.versionId) }) },
  { methods: GET, path: '/api/query/erp/notes', channel: 'erp:note:list', action: 'erp.access',
    input: ({ params: p }) => compact({
      folderId: num(p.folderId),
      tagId: num(p.tagId),
      search: str(p.search),
      authorId: str(p.authorId),
      limit: num(p.limit),
      offset: num(p.offset),
    }) },
  { methods: GET, path: '/api/query/erp/notes/:id/versions', channel: 'erp:note:versions', action: 'erp.access',
    input: ({ path }) => ({ noteId: path.id }) },
  { methods: GET, path: '/api/query/erp/notes/:id/shares', channel: 'erp:note:listShares', action: 'erp.access',
    input: ({ path }) => ({ noteId: path.id }) },
  { methods: GET, path: '/api/query/erp/notes/:id', channel: 'erp:note:get', action: 'erp.access',
    input: ({ path }) => ({ id: path.id }) },
  { methods: POST, path: '/api/command/erp/notes', channel: 'erp:note:create', action: 'note.create',
    input: ({ params: p }) => ({ input: obj(p.input) ?? {} }) },
  { methods: POST, path: '/api/command/erp/notes/:id/pin', channel: 'erp:note:pin', action: 'note.update',
    input: ({ params: p, path }) => ({ id: path.id, pinned: bool(p.pinned) }) },
  { methods: POST, path: '/api/command/erp/notes/:id/share', channel: 'erp:note:share', action: 'note.share',
    input: ({ params: p, path }) => compact({ noteId: path.id, scope: str(p.scope), shares: list(p.shares) ?? [] }) },
  { methods: POST, path: '/api/command/erp/notes/:id/tags', channel: 'erp:note:addTag', action: 'note.update',
    input: ({ params: p, path }) => ({ noteId: path.id, tagId: num(p.tagId) }) },
  { methods: DELETE, path: '/api/command/erp/notes/:id/tags/:tagId', channel: 'erp:note:removeTag', action: 'note.update',
    input: ({ path }) => ({ noteId: path.id, tagId: num(path.tagId) }) },
  { methods: UPDATE, path: '/api/command/erp/notes/:id', channel: 'erp:note:update', action: 'note.update',
    input: ({ params: p, path }) => ({ id: path.id, patch: patchOf(p) }) },
  { methods: DELETE, path: '/api/command/erp/notes/:id', channel: 'erp:note:delete', action: 'note.delete',
    input: ({ path }) => ({ id: path.id }) },

  // ── Nhân sự: phòng ban / chức vụ / hồ sơ ──
  { methods: GET, path: '/api/query/erp/departments', channel: 'erp:department:list', action: 'erp.access', input: none },
  { methods: POST, path: '/api/command/erp/departments', channel: 'erp:department:create', action: 'department.manage',
    input: ({ params: p }) => compact({
      name: p.name, parent_id: nullableNum(p.parent_id), manager_employee_id: p.manager_employee_id, description: p.description,
    }) },
  { methods: UPDATE, path: '/api/command/erp/departments/:id', channel: 'erp:department:update', action: 'department.manage',
    input: ({ params: p, path }) => ({ id: num(path.id), patch: patchOf(p) }) },
  { methods: DELETE, path: '/api/command/erp/departments/:id', channel: 'erp:department:delete', action: 'department.manage',
    input: ({ path }) => ({ id: num(path.id) }) },
  { methods: GET, path: '/api/query/erp/positions', channel: 'erp:position:list', action: 'erp.access', input: none },
  { methods: POST, path: '/api/command/erp/positions', channel: 'erp:position:create', action: 'position.manage',
    input: ({ params: p }) => compact({ name: p.name, level: num(p.level), department_id: nullableNum(p.department_id) }) },
  { methods: UPDATE, path: '/api/command/erp/positions/:id', channel: 'erp:position:update', action: 'position.manage',
    input: ({ params: p, path }) => ({ id: num(path.id), patch: patchOf(p) }) },
  { methods: DELETE, path: '/api/command/erp/positions/:id', channel: 'erp:position:delete', action: 'position.manage',
    input: ({ path }) => ({ id: num(path.id) }) },
  { methods: GET, path: '/api/query/erp/profiles', channel: 'erp:employee:listByDepartment', action: 'employee.view_others',
    input: ({ params: p }) => compact({ departmentId: nullableNum(p.departmentId) }) },
  { methods: GET, path: '/api/query/erp/profiles/:employeeId', channel: 'erp:employee:getProfile', action: 'erp.access',
    input: ({ path }) => ({ employeeId: path.employeeId }) },
  { methods: UPDATE, path: '/api/command/erp/profiles/:employeeId', channel: 'erp:employee:updateProfile', action: null,
    input: ({ params: p, path }) => ({ employeeId: path.employeeId, patch: patchOf(p) }) },
  { methods: DELETE, path: '/api/command/erp/profiles/:employeeId', channel: 'erp:employee:deleteProfile', action: 'employee.edit_others',
    input: ({ path }) => ({ employeeId: path.employeeId }) },
  { methods: GET, path: '/api/query/erp/license/seat', channel: 'erp:license:seatStatus', action: 'erp.access', input: none },

  // ── Chấm công (check-in / check-out luôn cho chính mình) ──
  { methods: GET, path: '/api/query/erp/attendance/today', channel: 'erp:attendance:today', action: 'erp.access', input: none },
  { methods: GET, path: '/api/query/erp/attendance', channel: 'erp:attendance:list', action: null,
    input: ({ params: p }) => compact({ all: bool(p.all), employeeId: str(p.employeeId), from: str(p.from), to: str(p.to) }) },
  { methods: POST, path: '/api/command/erp/attendance/check-in', channel: 'erp:attendance:checkIn', action: 'attendance.checkin',
    input: ({ params: p }) => compact({ note: str(p.note) }) },
  { methods: POST, path: '/api/command/erp/attendance/check-out', channel: 'erp:attendance:checkOut', action: 'attendance.checkin',
    input: ({ params: p }) => compact({ note: str(p.note) }) },

  // ── Nghỉ phép (duyệt: chỉ quản lý trực tiếp của người xin nghỉ — handler kiểm tra) ──
  { methods: GET, path: '/api/query/erp/leaves/my', channel: 'erp:leave:listMy', action: 'erp.access', input: none },
  { methods: GET, path: '/api/query/erp/leaves/pending', channel: 'erp:leave:listPending', action: 'leave.approve', input: none },
  { methods: POST, path: '/api/command/erp/leaves', channel: 'erp:leave:create', action: 'leave.create',
    input: ({ params: p }) => ({ input: obj(p.input) ?? {} }) },
  { methods: POST, path: '/api/command/erp/leaves/:id/decide', channel: 'erp:leave:decide', action: 'leave.approve',
    input: ({ params: p, path }) => compact({ id: num(path.id), status: p.status, note: str(p.note) }) },
  { methods: POST, path: '/api/command/erp/leaves/:id/cancel', channel: 'erp:leave:cancel', action: 'leave.create',
    input: ({ path }) => ({ id: num(path.id) }) },

  // ── Thông báo (chỉ của chính mình — handler lọc theo người nhận) ──
  { methods: GET, path: '/api/query/erp/notifications', channel: 'erp:notify:listInbox', action: 'erp.access',
    input: ({ params: p }) => compact({ unreadOnly: bool(p.unreadOnly), limit: num(p.limit), offset: num(p.offset) }) },
  { methods: GET, path: '/api/query/erp/notifications/unread-count', channel: 'erp:notify:unreadCount', action: 'erp.access', input: none },
  { methods: POST, path: '/api/command/erp/notifications/read', channel: 'erp:notify:markRead', action: 'erp.access',
    input: ({ params: p }) => ({ ids: list(p.ids) ?? [] }) },
  { methods: POST, path: '/api/command/erp/notifications/read-all', channel: 'erp:notify:markAllRead', action: 'erp.access', input: none },
  { methods: POST, path: '/api/command/erp/notifications/delete', channel: 'erp:notify:delete', action: 'erp.access',
    input: ({ params: p }) => ({ ids: list(p.ids) ?? [] }) },
  { methods: POST, path: '/api/command/erp/notifications/delete-all', channel: 'erp:notify:deleteAll', action: 'erp.access', input: none },

  // ── Thông báo qua Zalo (Cài đặt, owner / admin). Tài khoản gửi đi tham số `zaloId` → Boss kiểm tra tài khoản được giao
  //    (employeeAccess) như mọi lệnh theo tài khoản; không gửi `zaloId` = giữ tài khoản đang chọn ──
  { methods: GET, path: '/api/query/erp/notifications/zalo', channel: 'erp:notify:zaloStatus', action: 'settings.erp', input: none },
  { methods: POST, path: '/api/command/erp/notifications/zalo', channel: 'erp:notify:setZaloSettings', action: 'settings.erp',
    input: ({ params: p }) => ({
      settings: compact({ enabled: given(p.enabled) ? bool(p.enabled) : undefined, accountId: str(p.zaloId), types: list(p.types) }),
    }) },
  // employeeId = người nhận tin thử (đối tượng, không phải người làm)
  { methods: POST, path: '/api/command/erp/notifications/zalo/test', channel: 'erp:notify:testZalo', action: 'settings.erp',
    input: ({ params: p }) => compact({ employeeId: str(p.employeeId) }) },
];

// ── Khớp route ─────────────────────────────────────────────────────────────────────────────────────────────────

interface CompiledRoute { route: ErpRestRoute; re: RegExp; keys: string[] }

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileRoute(route: ErpRestRoute): CompiledRoute {
  const keys: string[] = [];
  const pattern = route.path.split('/').map((seg) => {
    if (seg.startsWith(':')) {
      keys.push(seg.slice(1));
      return '([^/]+)';
    }
    return escapeRe(seg);
  }).join('/');
  return { route, re: new RegExp(`^${pattern}$`), keys };
}

const COMPILED: readonly CompiledRoute[] = ERP_REST_ROUTES.map(compileRoute);

function decodeSegment(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

/** Route khớp đầu tiên (đúng method, đường dẫn và `when`) + phần động đã giải mã. */
function findRoute(method: string, pathname: string, params: Record<string, any>): { route: ErpRestRoute; path: Record<string, string> } | null {
  const m = String(method || '').toUpperCase();
  const p = String(pathname || '');
  for (const compiled of COMPILED) {
    if (!compiled.route.methods.includes(m as ErpRestMethod)) continue;
    const hit = compiled.re.exec(p);
    if (!hit) continue;
    if (compiled.route.when && !compiled.route.when(params)) continue;
    const path: Record<string, string> = {};
    compiled.keys.forEach((key, i) => { path[key] = decodeSegment(hit[i + 1] ?? ''); });
    return { route: compiled.route, path };
  }
  return null;
}

/** Route ERP cho một request (null = không có — Boss trả "Unknown endpoint"). */
export function matchErpRestRoute(method: string, pathname: string, params?: Record<string, any> | null): ErpRestMatch | null {
  const safeParams = params && typeof params === 'object' ? params : {};
  const found = findRoute(method, pathname, safeParams);
  if (!found) return null;
  return { route: found.route, path: found.path, input: found.route.input({ params: safeParams, path: found.path }) as Record<string, any> };
}

/**
 * Tên tham số REST mà route ERP đọc khi dựng input (theo dõi qua Proxy) — employeeRestContract.test dùng để kiểm tra
 * "Boss đọc MỌI tham số nhân viên gửi" cho các route ERP (route chung trong handleRestApi chuyển nguyên params).
 */
export function erpRestParamKeys(method: string, pathname: string, params: Record<string, any>): string[] {
  const read = new Set<string>();
  const tracked = new Proxy(params || {}, {
    get(target, key, receiver) {
      if (typeof key === 'string') read.add(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === 'string') read.add(key);
      return Reflect.has(target, key);
    },
  });
  const found = findRoute(method, pathname, tracked);
  if (found) found.route.input({ params: tracked, path: found.path });
  return [...read];
}

/** Mã lỗi từ chối → HTTP 403 (RestQueryService không tính vào mất kết nối). Còn lại 200 như lệnh IPC. */
const FORBIDDEN_CODES: ReadonlySet<string> = new Set(['permission_denied', 'MODULE_FORBIDDEN', 'PATH_FORBIDDEN', 'ACCOUNT_FORBIDDEN']);

export function erpRestHttpStatus(result: unknown): number {
  const r = result as { success?: unknown; code?: unknown } | null | undefined;
  return r && r.success === false && typeof r.code === 'string' && FORBIDDEN_CODES.has(r.code) ? 403 : 200;
}

/**
 * Danh sách tệp đính kèm trong input của lệnh task (tạo: `input.attachments`, sửa: `patch.attachments`) — Boss kiểm tra
 * đường dẫn trước khi chạy handler. null = lệnh không mang tệp đính kèm.
 */
export function erpTaskAttachmentHolder(channel: string, input: Record<string, any> | null | undefined): { attachments: any[] } | null {
  const holder = channel === 'erp:task:create' ? obj(input?.input) : channel === 'erp:task:update' ? obj(input?.patch) : undefined;
  if (!holder || !Array.isArray(holder.attachments)) return null;
  return holder as { attachments: any[] };
}
