/**
 * IpcInvoker — con đường DUY NHẤT để API v1 và plugin chạm vào nghiệp vụ:
 * gọi đúng IPC handler mà UI đang dùng (registry bọc ipcMain.handle), với
 *  - hàng đợi đồng thời (mặc định 4, 0 = không giới hạn) để không dồn main thread,
 *  - timeout (mặc định 30 s),
 *  - danh tính ERP của principal (ErpAuthContext.runAs),
 *  - ngữ cảnh "lời gọi từ API" (apiCallContext) để handler/EventHub biết nguồn.
 *
 * Kiểm tra quyền đã chạy ở ApiRouter TRƯỚC khi tới đây (kênh uỷ quyền cho plugin — PLUGIN_DELEGATED_CHANNEL_PREFIXES —
 * thì ở PluginApiBridge, kèm giấy uỷ quyền PluginGrant).
 */
import { AsyncLocalStorage } from 'async_hooks';
import { ApiError, IpcCallOptions, Principal, principalLogId } from './types';
import { getApiSettingNumber } from './settings';

export type IpcHandler = (event: any, ...args: any[]) => any;

export interface HandlerSource {
    get(channel: string): IpcHandler | undefined;
}

export interface ApiCallInfo {
    principalId: string;
    kind: Principal['kind'];
    name: string;
    requestId: string;
}

const callContext = new AsyncLocalStorage<ApiCallInfo>();

/** Lời gọi hiện tại có đến từ API/plugin không (null = từ UI hoặc nội bộ). */
export function getCurrentApiCall(): ApiCallInfo | null {
    return callContext.getStore() || null;
}

// ─── Semaphore ───────────────────────────────────────────────────────────────

export class Semaphore {
    private active = 0;
    private queue: Array<() => void> = [];

    constructor(private readonly getLimit: () => number) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this.active -= 1;
            this.next();
        };
        try {
            return await fn();
        } finally {
            release();
        }
    }

    private acquire(): Promise<void> {
        const limit = this.getLimit();
        if (!limit || limit <= 0 || this.active < limit) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this.queue.push(() => {
                this.active += 1;
                resolve();
            });
        });
    }

    private next(): void {
        const limit = this.getLimit();
        while (this.queue.length > 0 && (!limit || limit <= 0 || this.active < limit)) {
            const start = this.queue.shift()!;
            start();
        }
    }

    stats(): { active: number; queued: number; limit: number } {
        return { active: this.active, queued: this.queue.length, limit: this.getLimit() };
    }
}

// ─── Chuẩn hoá kết quả IPC ──────────────────────────────────────────────────

const OFFLINE_PATTERNS = [
    /chưa kết nối/i,
    /không còn kết nối/i,
    /not connected/i,
    /no active connection/i,
];

export function mapIpcError(message: string, code?: string, errorMap?: Record<string, [number, string]>): ApiError {
    const msg = String(message || 'Lỗi không xác định');
    if (errorMap && errorMap[msg]) {
        const [status, apiCode] = errorMap[msg];
        return new ApiError(status, apiCode, msg);
    }
    if (code === 'permission_denied' || /Permission denied/i.test(msg)) return new ApiError(403, 'FORBIDDEN_ERP', msg);
    if (code === 'validation_error') return new ApiError(400, 'VALIDATION_ERROR', msg);
    if (OFFLINE_PATTERNS.some(re => re.test(msg))) return new ApiError(409, 'ACCOUNT_OFFLINE', msg);
    if (/không tìm thấy|not found/i.test(msg)) return new ApiError(404, 'NOT_FOUND', msg);
    return new ApiError(502, 'UPSTREAM_ERROR', msg);
}

/**
 * Handler IPC trả nhiều dạng: `{ success, ...data }`, `{ success:false, error }`,
 * `{ error }` (zaloIpc thiếu auth), mảng hoặc giá trị trần. Ném ApiError khi thất bại.
 */
export function unwrapIpcResult(res: any, opts: IpcCallOptions = {}): any {
    if (res === null || res === undefined || typeof res !== 'object' || Array.isArray(res)) return res;
    const hasSuccess = Object.prototype.hasOwnProperty.call(res, 'success');
    const failed = hasSuccess
        ? res.success === false
        : (typeof res.error === 'string' && res.error.length > 0 && Object.keys(res).every(k => ['error', 'code', 'message'].includes(k)));
    if (!failed) return res;
    throw mapIpcError(String(res.error || res.message || 'Lỗi không xác định'), res.code, opts.errorMap);
}

// ─── Invoker ────────────────────────────────────────────────────────────────

export interface ErpRunner {
    runAs<T>(principal: Principal, fn: () => T): T;
}

/** Mặc định: ErpAuthContext.runAs với danh tính của principal. */
export const defaultErpRunner: ErpRunner = {
    runAs<T>(principal: Principal, fn: () => T): T {
        try {
            const ErpAuthContext = require('../erp/ErpAuthContext').default;
            const ctx = principal.kind === 'employee'
                ? ErpAuthContext.forEmployee(principal.erp.employeeId)
                : {
                    employeeId: principal.erp.employeeId,
                    role: principal.erp.role,
                    permissionOverrides: {},
                    mode: 'boss',
                };
            return ErpAuthContext.runAs(ctx, fn);
        } catch {
            return fn();
        }
    },
};

/**
 * Giấy uỷ quyền PluginApiBridge cấp cho MỘT lời gọi kênh quản trị được uỷ quyền (PLUGIN_DELEGATED_CHANNEL_PREFIXES),
 * SAU KHI bridge đã kiểm quyền manifest + tiền tố tài nguyên. Chỉ code trong main tạo được (plugin chạy ở tiến trình
 * riêng, API key đi qua route có kênh cố định). Handler đọc lại qua event.pluginGrant — không tin payload.
 */
export interface PluginGrant {
    pluginId: string;
    /** Tên ứng dụng (manifest) — chỉ để hiện cho người dùng, vd trong hộp thoại xác nhận. */
    pluginName?: string;
    /** Quyền manifest đã kiểm, vd 'cloudflare:workers'. */
    permission: string;
    /** Tiền tố tên tài nguyên của plugin (pluginShortName). */
    resourcePrefix: string;
    /** realpath thư mục plugin đã cài — đường dẫn file plugin gửi lên phải nằm trong đây. */
    pluginDir: string;
    /** Ghi tiến độ vào nhật ký của plugin (tuỳ chọn). */
    log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function fakeEvent(principal: Principal, pluginGrant?: PluginGrant): any {
    return {
        sender: {
            id: -1,
            send: () => { /* API không có renderer nhận progress */ },
            isDestroyed: () => false,
        },
        senderFrame: null,
        fromApi: true,
        apiPrincipalId: principalLogId(principal),
        ...(pluginGrant ? { pluginGrant } : {}),
    };
}

/**
 * Kênh quản trị (key, webhook của app, plugin, Cloudflare) — principal ngoài 'system' không được gọi.
 * cloudflare:* còn tự chặn mọi lời gọi từ API/plugin (e.fromApi) ngay trong handler.
 */
export const ADMIN_CHANNEL_PREFIXES = ['api:', 'plugins:', 'cloudflare:'];

/**
 * Ngoại lệ DUY NHẤT của luật trên: kênh quản trị mà principal 'plugin' được gọi khi — và chỉ khi — lời gọi mang giấy
 * uỷ quyền (info.pluginGrant) của chính plugin đó do PluginApiBridge cấp sau khi kiểm quyền manifest + tiền tố.
 * API key, nhân viên, plugin không có giấy (vd route API v1 gọi thay plugin) vẫn bị chặn như mọi kênh quản trị khác.
 * Handler (electron/ipc/cloud/cloudflareWorkersIpc.ts) kiểm lại giấy + tiền tố + thư mục.
 */
export const PLUGIN_DELEGATED_CHANNEL_PREFIXES = ['cloudflare:workers:'];

export function isAdminChannel(channel: string): boolean {
    return ADMIN_CHANNEL_PREFIXES.some(p => channel.startsWith(p));
}

export function isPluginDelegatedChannel(channel: string): boolean {
    return PLUGIN_DELEGATED_CHANNEL_PREFIXES.some(p => channel.startsWith(p));
}

/** Lời gọi này có được uỷ quyền cho plugin không: principal plugin + giấy của CHÍNH plugin đó + kênh được uỷ quyền. */
function delegatedGrant(channel: string, principal: Principal, grant: PluginGrant | undefined): PluginGrant | undefined {
    if (principal.kind !== 'plugin' || !grant || !isPluginDelegatedChannel(channel)) return undefined;
    if (typeof grant.pluginId !== 'string' || grant.pluginId !== principal.id) return undefined;
    return grant;
}

export class IpcInvoker {
    private readonly semaphore: Semaphore;

    constructor(
        private readonly source: HandlerSource,
        private readonly erpRunner: ErpRunner = defaultErpRunner,
        private readonly limits: { concurrency: () => number; timeoutMs: () => number } = {
            concurrency: () => getApiSettingNumber('api_ipc_concurrency'),
            timeoutMs: () => getApiSettingNumber('api_ipc_timeout_ms') || 30_000,
        },
    ) {
        this.semaphore = new Semaphore(limits.concurrency);
    }

    has(channel: string): boolean {
        return !!this.source.get(channel);
    }

    async invoke(channel: string, args: any[], principal: Principal, info: { requestId: string; timeoutMs?: number; pluginGrant?: PluginGrant }): Promise<any> {
        const grant = delegatedGrant(channel, principal, info.pluginGrant);
        if (principal.kind !== 'system' && isAdminChannel(channel) && !grant) {
            // Kênh quản trị API/plugin chỉ dành cho giao diện của chủ máy — không tự nâng quyền qua API.
            throw new ApiError(403, 'FORBIDDEN_SCOPE', `Kênh ${channel} chỉ dùng trong app`);
        }
        const handler = this.source.get(channel);
        if (!handler) throw new ApiError(501, 'NOT_IMPLEMENTED', `Thiếu kênh IPC ${channel}`);
        const timeoutMs = info.timeoutMs || this.limits.timeoutMs() || 30_000;
        const event = fakeEvent(principal, grant);
        const call: ApiCallInfo = {
            principalId: principalLogId(principal),
            kind: principal.kind,
            name: principal.name,
            requestId: info.requestId,
        };
        return this.semaphore.run(() => new Promise<any>((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new ApiError(504, 'TIMEOUT', `Kênh ${channel} xử lý quá ${Math.round(timeoutMs / 1000)} giây`));
            }, timeoutMs);
            Promise.resolve()
                .then(() => callContext.run(call, () => this.erpRunner.runAs(principal, () => handler(event, ...args))))
                .then(value => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(value);
                }, err => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    reject(err instanceof ApiError ? err : mapIpcError(err?.message || String(err)));
                });
        }));
    }

    stats(): { active: number; queued: number; limit: number } {
        return this.semaphore.stats();
    }
}
