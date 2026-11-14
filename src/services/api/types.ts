/**
 * types.ts: shared types of the Public API v1.
 *
 * Principles (docs/api/README.md):
 *  - Every request maps to one Principal (API key | employee | plugin).
 *  - Permissions are checked BEFORE entering IPC; routes contain no business logic,
 *    they only map parameters → the IPC channel the UI uses → wrap the result.
 */

import type { Schema, ObjectSchema } from './schema';
import { tr } from '../../shared/i18n';

// ─── Scope ───────────────────────────────────────────────────────────────────

export const API_SCOPES = [
    { id: 'accounts:read', group: 'Tài khoản', label: tr('Xem danh sách tài khoản và trạng thái') },
    { id: 'accounts:manage', group: 'Tài khoản', label: tr('Kết nối, ngắt kết nối, đổi proxy') },
    { id: 'chat:read', group: 'Chat', label: tr('Đọc hội thoại, tin nhắn, nhãn, tin nhanh') },
    { id: 'chat:send', group: 'Chat', label: tr('Gửi tin, file, sticker, reaction, typing') },
    { id: 'chat:manage', group: 'Chat', label: tr('Đánh dấu đọc, thu hồi, ghim, gán nhãn, quản lý nhóm') },
    { id: 'contacts:read', group: 'Danh bạ', label: tr('Xem bạn bè, lời mời, tra cứu người dùng') },
    { id: 'contacts:write', group: 'Danh bạ', label: tr('Gửi/chấp nhận/từ chối lời mời, xoá bạn') },
    { id: 'crm:read', group: 'CRM', label: tr('Xem khách hàng, tag, ghi chú, chiến dịch') },
    { id: 'crm:write', group: 'CRM', label: tr('Sửa khách hàng, tag, ghi chú, chiến dịch') },
    { id: 'campaigns:run', group: 'CRM', label: tr('Chạy/dừng chiến dịch') },
    { id: 'workflow:read', group: 'Workflow', label: tr('Xem workflow và lịch sử chạy') },
    { id: 'workflow:write', group: 'Workflow', label: tr('Tạo, sửa, bật/tắt, xoá workflow') },
    { id: 'workflow:run', group: 'Workflow', label: tr('Chạy workflow, bắn sự kiện trigger.api') },
    { id: 'integrations:read', group: 'Tích hợp', label: tr('Xem tích hợp (không lộ credential)') },
    { id: 'integrations:execute', group: 'Tích hợp', label: tr('Gọi action của tích hợp (POS, vận chuyển...)') },
    { id: 'integrations:manage', group: 'Tích hợp', label: tr('Thêm, sửa credential, bật/tắt, xoá tích hợp') },
    { id: 'erp:read', group: 'ERP', label: tr('Xem công việc, dự án, lịch, ghi chú, nhân sự') },
    { id: 'erp:write', group: 'ERP', label: tr('Tạo/sửa công việc, dự án, lịch, ghi chú') },
    { id: 'ai:use', group: 'AI', label: tr('Chat với trợ lý AI, gợi ý trả lời') },
    { id: 'ai:manage', group: 'AI', label: tr('Quản lý trợ lý AI, xem thống kê sử dụng') },
    { id: 'media:read', group: 'Media', label: tr('Tải file đính kèm, thư viện media') },
    { id: 'media:write', group: 'Media', label: tr('Upload file, quản lý thư viện media') },
    { id: 'analytics:read', group: 'Báo cáo', label: tr('Xem báo cáo') },
    { id: 'events:subscribe', group: 'Sự kiện', label: tr('Nhận sự kiện realtime (Socket.IO, SSE, polling)') },
    { id: 'webhooks:manage', group: 'Sự kiện', label: tr('Quản lý webhook subscription của key này') },
    { id: 'employees:manage', group: 'Quản trị', label: tr('Quản lý nhân viên, quyền, phân tài khoản') },
    { id: 'settings:read', group: 'Quản trị', label: tr('Đọc cài đặt (danh sách cho phép)') },
    { id: 'settings:write', group: 'Quản trị', label: tr('Ghi cài đặt (danh sách cho phép)') },
    { id: 'plugins:manage', group: 'Quản trị', label: tr('Quản lý ứng dụng (plugin)') },
    { id: 'admin', group: 'Quản trị', label: tr('Toàn quyền (mọi scope ở trên)') },
] as const;

export type ApiScope = typeof API_SCOPES[number]['id'];

export const ALL_SCOPE_IDS: readonly ApiScope[] = API_SCOPES.map(s => s.id);

export function isApiScope(v: string): v is ApiScope {
    return (ALL_SCOPE_IDS as readonly string[]).includes(v);
}

/** Suggested presets in the key creation UI. */
export const SCOPE_PRESETS: Record<string, { label: string; scopes: ApiScope[] }> = {
    readonly: {
        label: tr('Chỉ đọc'),
        scopes: ['accounts:read', 'chat:read', 'contacts:read', 'crm:read', 'workflow:read', 'integrations:read', 'erp:read', 'media:read', 'analytics:read', 'events:subscribe'],
    },
    chatbot: {
        label: 'Chat bot',
        scopes: ['accounts:read', 'chat:read', 'chat:send', 'chat:manage', 'contacts:read', 'media:read', 'media:write', 'events:subscribe', 'webhooks:manage', 'ai:use'],
    },
    crmSync: {
        label: tr('Đồng bộ CRM'),
        scopes: ['accounts:read', 'chat:read', 'contacts:read', 'crm:read', 'crm:write', 'events:subscribe', 'webhooks:manage'],
    },
    full: { label: tr('Toàn quyền'), scopes: ['admin'] },
};

// ─── Principal ───────────────────────────────────────────────────────────────

export type ErpRoleName = 'owner' | 'admin' | 'manager' | 'member' | 'guest';

export interface Principal {
    /** 'system' = internal Deplao call (reads the account list, anonymous for public routes). */
    kind: 'apikey' | 'employee' | 'plugin' | 'system';
    /** api_keys.id | employee_id | plugin id */
    id: string;
    name: string;
    scopes: Set<ApiScope>;
    /** null = all accounts; array = only these account ids. */
    accountIds: string[] | null;
    /** 0 = no limit (default). */
    rateLimitPerMin: number;
    /** Identity used when calling erp:* channels (withErpAuth). */
    erp: { employeeId: string; role: ErpRoleName };
    /** Allowed IPs (null = any IP). */
    allowedIps: string[] | null;
}

export function principalLogId(p: Principal): string {
    if (p.kind === 'apikey') return p.id;
    return `${p.kind}:${p.id}`;
}

// ─── Errors ─────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly details?: any,
        public readonly headers?: Record<string, string>,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

export const ERROR_CODES: Record<string, { status: number; description: string }> = {
    UNAUTHORIZED: { status: 401, description: tr('Thiếu key, key sai, key bị thu hồi hoặc hết hạn') },
    FORBIDDEN_SCOPE: { status: 403, description: tr('Key thiếu scope cần cho endpoint') },
    FORBIDDEN_ACCOUNT: { status: 403, description: tr('Key không được cấp tài khoản này') },
    FORBIDDEN_IP: { status: 403, description: tr('IP gọi không nằm trong danh sách cho phép của key') },
    FORBIDDEN_ERP: { status: 403, description: tr('Vai trò ERP của key không đủ quyền') },
    NOT_FOUND: { status: 404, description: tr('Không tìm thấy endpoint hoặc dữ liệu') },
    METHOD_NOT_ALLOWED: { status: 405, description: 'Sai HTTP method' },
    VALIDATION_ERROR: { status: 400, description: tr('Tham số không hợp lệ (xem details)') },
    INVALID_JSON: { status: 400, description: tr('Body không phải JSON hợp lệ') },
    PAYLOAD_TOO_LARGE: { status: 413, description: tr('Body vượt giới hạn') },
    CONFLICT: { status: 409, description: tr('Xung đột trạng thái') },
    ACCOUNT_OFFLINE: { status: 409, description: tr('Tài khoản chưa kết nối') },
    CHANNEL_UNSUPPORTED: { status: 422, description: tr('Kênh của tài khoản không hỗ trợ thao tác này') },
    RATE_LIMITED: { status: 429, description: tr('Vượt giới hạn tốc độ do bạn tự đặt cho key') },
    AUTH_BLOCKED: { status: 429, description: tr('IP bị tạm chặn vì gửi quá nhiều key sai') },
    UPSTREAM_ERROR: { status: 502, description: tr('Zalo/Facebook/Telegram hoặc handler nội bộ trả lỗi') },
    NOT_IMPLEMENTED: { status: 501, description: tr('Thiếu kênh IPC tương ứng') },
    API_DISABLED: { status: 503, description: tr('API đang tắt trong Cài đặt') },
    TIMEOUT: { status: 504, description: tr('Xử lý quá thời gian cho phép') },
    PLUGIN_ERROR: { status: 502, description: tr('Route/node của plugin trả lỗi') },
    PLUGIN_DISABLED: { status: 404, description: tr('Plugin chưa cài hoặc đang tắt') },
    INTERNAL_ERROR: { status: 500, description: tr('Lỗi không mong đợi') },
};

// ─── Route ───────────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Return this value when the handler has already written the response itself (file stream, SSE). */
export const RESPONSE_HANDLED = Symbol('RESPONSE_HANDLED');

export interface Pagination {
    limit: number;
    offset?: number;
    total?: number;
    has_more?: boolean;
    next_offset?: number | null;
    next_before?: number | null;
    /** Event polling: pass it as ?since= next time. */
    next_since?: number | null;
}

/** The handler returns `{ data, pagination }` instead of bare data when pagination is needed. */
export interface Paged<T = any> {
    __paged: true;
    data: T;
    pagination: Pagination;
}

export function paged<T>(data: T, pagination: Pagination): Paged<T> {
    return { __paged: true, data, pagination };
}

export interface AccountInfo {
    id: string;
    channel: 'zalo' | 'facebook' | 'telegram_user' | 'telegram_bot' | string;
    display_name: string;
    avatar_url: string;
    phone: string;
    online: boolean;
    is_business: boolean;
    listener_active: boolean;
    created_at: string | number | null;
    last_seen: string | number | null;
}

export interface IpcCallOptions {
    /** Map the handler's exact error message to an API code. */
    errorMap?: Record<string, [number, string]>;
    /** Treat `{ success: true }` with no data as valid (default true). */
    allowEmpty?: boolean;
    timeoutMs?: number;
}

export interface ApiContext {
    principal: Principal;
    params: Record<string, any>;
    query: Record<string, any>;
    body: any;
    requestId: string;
    ip: string;
    /** Call a shared IPC handler (goes through the queue + timeout + ERP identity). Returns the result as is. */
    ipc: (channel: string, ...args: any[]) => Promise<any>;
    /** Like ipc() but throws an ApiError when the handler returns `{ success:false }`. */
    call: (channel: string, payload?: any, opts?: IpcCallOptions) => Promise<any>;
    /** Check account permission + get info (channel, online). Throws 403/404. */
    account: (accountId: string) => Promise<AccountInfo>;
    /** All accounts on the machine (not yet filtered by permission; the route filters them with accountAllowed). */
    listAccounts: () => Promise<AccountInfo[]>;
    /** Auth for zalo:* handlers (like the UI's buildZaloAuth). Checks account permission first. Never returned outside. */
    zaloAuth: (accountId: string) => Promise<Record<string, string>>;
    /** Original request/response, only present when called over HTTP. */
    raw?: { req: import('http').IncomingMessage; res: import('http').ServerResponse };
    /**
     * Calling a file route (rawResponse.file) without HTTP (plugin): streamFile returns FileContent (base64) instead of a stream,
     * a file larger than maxBytes → 413.
     */
    binary?: { maxBytes: number };
}

/** File content when a file route is called without HTTP (ApiContext.binary). */
export interface FileContent {
    name: string;
    mime: string;
    size: number;
    base64: string;
}

export interface RouteExample {
    request?: any;
    response?: any;
}

export interface RouteDef {
    method: HttpMethod;
    /** Relative to /api/v1, for example '/accounts/:accountId/conversations'. */
    path: string;
    /** null = public (health, docs). 'any' = login required, no specific scope needed. */
    scope: ApiScope | 'any' | null;
    tags: string[];
    summary: string;
    description?: string;
    operationId?: string;
    params?: ObjectSchema<any>;
    query?: ObjectSchema<any>;
    body?: Schema<any>;
    /** Schema of the `data` part (used for the docs). */
    response?: Schema<any>;
    /**
     * Response that is not a JSON envelope (file, SSE). `file: true` = the handler returns a file on the machine via streamFile →
     * plugins can call it (they receive FileContent as base64, see ApiRouter.invoke `binary`); other routes are called over HTTP only.
     */
    rawResponse?: { contentType: string; description: string; file?: boolean };
    /** Special body Content-Type (upload). */
    rawBody?: { contentType: string; description: string };
    /** Separate body limit (bytes). */
    maxBodyBytes?: number;
    /** Specific errors that must be documented. */
    errors?: string[];
    examples?: RouteExample;
    /** Not shown in the OpenAPI (internal route). */
    hidden?: boolean;
    handler: (ctx: ApiContext) => Promise<any> | any;
}

export function route(def: RouteDef): RouteDef {
    return def;
}
