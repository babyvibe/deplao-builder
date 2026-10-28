/**
 * types.ts — kiểu dùng chung của Public API v1.
 *
 * Nguyên tắc (docs/api/README.md):
 *  - Mọi request quy về một Principal (API key | nhân viên | plugin).
 *  - Kiểm tra quyền chạy TRƯỚC khi vào IPC; route không chứa logic nghiệp vụ,
 *    chỉ map tham số → kênh IPC mà UI đang dùng → đóng gói kết quả.
 */

import type { Schema, ObjectSchema } from './schema';

// ─── Scope ───────────────────────────────────────────────────────────────────

export const API_SCOPES = [
    { id: 'accounts:read', group: 'Tài khoản', label: 'Xem danh sách tài khoản và trạng thái' },
    { id: 'accounts:manage', group: 'Tài khoản', label: 'Kết nối, ngắt kết nối, đổi proxy' },
    { id: 'chat:read', group: 'Chat', label: 'Đọc hội thoại, tin nhắn, nhãn, tin nhanh' },
    { id: 'chat:send', group: 'Chat', label: 'Gửi tin, file, sticker, reaction, typing' },
    { id: 'chat:manage', group: 'Chat', label: 'Đánh dấu đọc, thu hồi, ghim, gán nhãn, quản lý nhóm' },
    { id: 'contacts:read', group: 'Danh bạ', label: 'Xem bạn bè, lời mời, tra cứu người dùng' },
    { id: 'contacts:write', group: 'Danh bạ', label: 'Gửi/chấp nhận/từ chối lời mời, xoá bạn' },
    { id: 'crm:read', group: 'CRM', label: 'Xem khách hàng, tag, ghi chú, chiến dịch' },
    { id: 'crm:write', group: 'CRM', label: 'Sửa khách hàng, tag, ghi chú, chiến dịch' },
    { id: 'campaigns:run', group: 'CRM', label: 'Chạy/dừng chiến dịch' },
    { id: 'workflow:read', group: 'Workflow', label: 'Xem workflow và lịch sử chạy' },
    { id: 'workflow:write', group: 'Workflow', label: 'Tạo, sửa, bật/tắt, xoá workflow' },
    { id: 'workflow:run', group: 'Workflow', label: 'Chạy workflow, bắn sự kiện trigger.api' },
    { id: 'integrations:read', group: 'Tích hợp', label: 'Xem tích hợp (không lộ credential)' },
    { id: 'integrations:execute', group: 'Tích hợp', label: 'Gọi action của tích hợp (POS, vận chuyển...)' },
    { id: 'integrations:manage', group: 'Tích hợp', label: 'Thêm, sửa credential, bật/tắt, xoá tích hợp' },
    { id: 'erp:read', group: 'ERP', label: 'Xem công việc, dự án, lịch, ghi chú, nhân sự' },
    { id: 'erp:write', group: 'ERP', label: 'Tạo/sửa công việc, dự án, lịch, ghi chú' },
    { id: 'ai:use', group: 'AI', label: 'Chat với trợ lý AI, gợi ý trả lời' },
    { id: 'ai:manage', group: 'AI', label: 'Quản lý trợ lý AI, xem thống kê sử dụng' },
    { id: 'media:read', group: 'Media', label: 'Tải file đính kèm, thư viện media' },
    { id: 'media:write', group: 'Media', label: 'Upload file, quản lý thư viện media' },
    { id: 'analytics:read', group: 'Báo cáo', label: 'Xem báo cáo' },
    { id: 'events:subscribe', group: 'Sự kiện', label: 'Nhận sự kiện realtime (Socket.IO, SSE, polling)' },
    { id: 'webhooks:manage', group: 'Sự kiện', label: 'Quản lý webhook subscription của key này' },
    { id: 'employees:manage', group: 'Quản trị', label: 'Quản lý nhân viên, quyền, phân tài khoản' },
    { id: 'settings:read', group: 'Quản trị', label: 'Đọc cài đặt (danh sách cho phép)' },
    { id: 'settings:write', group: 'Quản trị', label: 'Ghi cài đặt (danh sách cho phép)' },
    { id: 'plugins:manage', group: 'Quản trị', label: 'Quản lý ứng dụng (plugin)' },
    { id: 'admin', group: 'Quản trị', label: 'Toàn quyền (mọi scope ở trên)' },
] as const;

export type ApiScope = typeof API_SCOPES[number]['id'];

export const ALL_SCOPE_IDS: readonly ApiScope[] = API_SCOPES.map(s => s.id);

export function isApiScope(v: string): v is ApiScope {
    return (ALL_SCOPE_IDS as readonly string[]).includes(v);
}

/** Preset gợi ý trong UI tạo key. */
export const SCOPE_PRESETS: Record<string, { label: string; scopes: ApiScope[] }> = {
    readonly: {
        label: 'Chỉ đọc',
        scopes: ['accounts:read', 'chat:read', 'contacts:read', 'crm:read', 'workflow:read', 'integrations:read', 'erp:read', 'media:read', 'analytics:read', 'events:subscribe'],
    },
    chatbot: {
        label: 'Chat bot',
        scopes: ['accounts:read', 'chat:read', 'chat:send', 'chat:manage', 'contacts:read', 'media:read', 'media:write', 'events:subscribe', 'webhooks:manage', 'ai:use'],
    },
    crmSync: {
        label: 'Đồng bộ CRM',
        scopes: ['accounts:read', 'chat:read', 'contacts:read', 'crm:read', 'crm:write', 'events:subscribe', 'webhooks:manage'],
    },
    full: { label: 'Toàn quyền', scopes: ['admin'] },
};

// ─── Principal ───────────────────────────────────────────────────────────────

export type ErpRoleName = 'owner' | 'admin' | 'manager' | 'member' | 'guest';

export interface Principal {
    /** 'system' = lời gọi nội bộ của Deplao (đọc danh bạ tài khoản, anonymous cho route public). */
    kind: 'apikey' | 'employee' | 'plugin' | 'system';
    /** api_keys.id | employee_id | plugin id */
    id: string;
    name: string;
    scopes: Set<ApiScope>;
    /** null = mọi tài khoản; mảng = chỉ các account id này. */
    accountIds: string[] | null;
    /** 0 = không giới hạn (mặc định). */
    rateLimitPerMin: number;
    /** Danh tính khi gọi kênh erp:* (withErpAuth). */
    erp: { employeeId: string; role: ErpRoleName };
    /** IP được phép (null = mọi IP). */
    allowedIps: string[] | null;
}

export function principalLogId(p: Principal): string {
    if (p.kind === 'apikey') return p.id;
    return `${p.kind}:${p.id}`;
}

// ─── Lỗi ─────────────────────────────────────────────────────────────────────

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
    UNAUTHORIZED: { status: 401, description: 'Thiếu key, key sai, key bị thu hồi hoặc hết hạn' },
    FORBIDDEN_SCOPE: { status: 403, description: 'Key thiếu scope cần cho endpoint' },
    FORBIDDEN_ACCOUNT: { status: 403, description: 'Key không được cấp tài khoản này' },
    FORBIDDEN_IP: { status: 403, description: 'IP gọi không nằm trong danh sách cho phép của key' },
    FORBIDDEN_ERP: { status: 403, description: 'Vai trò ERP của key không đủ quyền' },
    NOT_FOUND: { status: 404, description: 'Không tìm thấy endpoint hoặc dữ liệu' },
    METHOD_NOT_ALLOWED: { status: 405, description: 'Sai HTTP method' },
    VALIDATION_ERROR: { status: 400, description: 'Tham số không hợp lệ (xem details)' },
    INVALID_JSON: { status: 400, description: 'Body không phải JSON hợp lệ' },
    PAYLOAD_TOO_LARGE: { status: 413, description: 'Body vượt giới hạn' },
    CONFLICT: { status: 409, description: 'Xung đột trạng thái' },
    ACCOUNT_OFFLINE: { status: 409, description: 'Tài khoản chưa kết nối' },
    CHANNEL_UNSUPPORTED: { status: 422, description: 'Kênh của tài khoản không hỗ trợ thao tác này' },
    RATE_LIMITED: { status: 429, description: 'Vượt giới hạn tốc độ do bạn tự đặt cho key' },
    AUTH_BLOCKED: { status: 429, description: 'IP bị tạm chặn vì gửi quá nhiều key sai' },
    UPSTREAM_ERROR: { status: 502, description: 'Zalo/Facebook/Telegram hoặc handler nội bộ trả lỗi' },
    NOT_IMPLEMENTED: { status: 501, description: 'Thiếu kênh IPC tương ứng' },
    API_DISABLED: { status: 503, description: 'API đang tắt trong Cài đặt' },
    TIMEOUT: { status: 504, description: 'Xử lý quá thời gian cho phép' },
    PLUGIN_ERROR: { status: 502, description: 'Route/node của plugin trả lỗi' },
    PLUGIN_DISABLED: { status: 404, description: 'Plugin chưa cài hoặc đang tắt' },
    INTERNAL_ERROR: { status: 500, description: 'Lỗi không mong đợi' },
};

// ─── Route ───────────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Trả về giá trị này khi handler đã tự ghi response (stream file, SSE). */
export const RESPONSE_HANDLED = Symbol('RESPONSE_HANDLED');

export interface Pagination {
    limit: number;
    offset?: number;
    total?: number;
    has_more?: boolean;
    next_offset?: number | null;
    next_before?: number | null;
    /** Polling sự kiện: truyền vào ?since= lần sau. */
    next_since?: number | null;
}

/** Handler trả `{ data, pagination }` thay vì data trần khi cần phân trang. */
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
    /** Map nguyên văn message lỗi của handler sang mã API. */
    errorMap?: Record<string, [number, string]>;
    /** Coi `{ success: true }` không có dữ liệu là hợp lệ (mặc định true). */
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
    /** Gọi IPC handler chung (đi qua hàng đợi + timeout + danh tính ERP). Trả nguyên kết quả. */
    ipc: (channel: string, ...args: any[]) => Promise<any>;
    /** Như ipc() nhưng ném ApiError khi handler trả `{ success:false }`. */
    call: (channel: string, payload?: any, opts?: IpcCallOptions) => Promise<any>;
    /** Kiểm tra quyền tài khoản + lấy thông tin (kênh, online). Ném 403/404. */
    account: (accountId: string) => Promise<AccountInfo>;
    /** Mọi tài khoản trên máy (chưa lọc theo quyền — route tự lọc bằng accountAllowed). */
    listAccounts: () => Promise<AccountInfo[]>;
    /** Auth cho handler zalo:* (như buildZaloAuth của UI). Kiểm tra quyền tài khoản trước. Không trả ra ngoài. */
    zaloAuth: (accountId: string) => Promise<Record<string, string>>;
    /** Request/response gốc — chỉ có khi gọi qua HTTP. */
    raw?: { req: import('http').IncomingMessage; res: import('http').ServerResponse };
    /**
     * Gọi route file (rawResponse.file) không qua HTTP (plugin): streamFile trả FileContent (base64) thay vì stream,
     * file lớn hơn maxBytes → 413.
     */
    binary?: { maxBytes: number };
}

/** Nội dung file khi route file được gọi không qua HTTP (ApiContext.binary). */
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
    /** Tương đối với /api/v1, ví dụ '/accounts/:accountId/conversations'. */
    path: string;
    /** null = public (health, docs). 'any' = cần đăng nhập, không cần scope cụ thể. */
    scope: ApiScope | 'any' | null;
    tags: string[];
    summary: string;
    description?: string;
    operationId?: string;
    params?: ObjectSchema<any>;
    query?: ObjectSchema<any>;
    body?: Schema<any>;
    /** Schema phần `data` (dùng cho docs). */
    response?: Schema<any>;
    /**
     * Response không phải JSON envelope (file, SSE). `file: true` = handler trả file trên máy qua streamFile →
     * plugin gọi được (nhận FileContent base64, xem ApiRouter.invoke `binary`); route khác chỉ gọi qua HTTP.
     */
    rawResponse?: { contentType: string; description: string; file?: boolean };
    /** Content-Type body đặc biệt (upload). */
    rawBody?: { contentType: string; description: string };
    /** Giới hạn body riêng (byte). */
    maxBodyBytes?: number;
    /** Lỗi đặc thù cần ghi vào docs. */
    errors?: string[];
    examples?: RouteExample;
    /** Không xuất hiện trong OpenAPI (route nội bộ). */
    hidden?: boolean;
    handler: (ctx: ApiContext) => Promise<any> | any;
}

export function route(def: RouteDef): RouteDef {
    return def;
}
