/**
 * IpcInvoker: the ONLY path through which API v1 and plugins touch the business logic:
 * calls the exact IPC handler the UI uses (the registry wraps ipcMain.handle), with
 *  - a concurrency queue (default 4, 0 = unlimited) so the main thread is not flooded,
 *  - a timeout (default 30 s),
 *  - the ERP identity of the principal (ErpAuthContext.runAs),
 *  - the "call from API" context (apiCallContext) so the handler / EventHub knows the source.
 *
 * Permission checks already ran in ApiRouter BEFORE reaching here (delegated channels, see PLUGIN_DELEGATED_CHANNEL_PREFIXES,
 * are checked in PluginApiBridge, together with the PluginGrant).
 */
import { AsyncLocalStorage } from 'async_hooks';
import { ApiError, IpcCallOptions, Principal, principalLogId } from './types';
import { getApiSettingNumber } from './settings';
import { tr } from '../../shared/i18n';

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

/** Whether the current call comes from an API / plugin (null = from the UI or internal). */
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

// ─── Normalize IPC results ──────────────────────────────────────────────────

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
 * IPC handlers return several shapes: `{ success, ...data }`, `{ success:false, error }`,
 * `{ error }` (zaloIpc when auth is missing), an array, or a bare value. Throws ApiError on failure.
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

/** Default: ErpAuthContext.runAs with the principal's identity. */
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
 * Grant that PluginApiBridge issues for ONE call to a delegated admin channel (PLUGIN_DELEGATED_CHANNEL_PREFIXES),
 * AFTER the bridge has checked the manifest permission + resource prefix. Only code in main can create it (plugins run in a separate
 * process, API keys go through routes with fixed channels). The handler re-reads it via event.pluginGrant: the payload is not trusted.
 */
export interface PluginGrant {
    pluginId: string;
    /** App name (manifest): only to show to the user, e.g. in a confirmation dialog. */
    pluginName?: string;
    /** Manifest permission that was checked, e.g. 'cloudflare:workers'. */
    permission: string;
    /** The plugin's resource name prefix (pluginShortName). */
    resourcePrefix: string;
    /** realpath of the installed plugin folder: the plugin file path sent up must be inside it. */
    pluginDir: string;
    /** Writes progress to the plugin's log (optional). */
    log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function fakeEvent(principal: Principal, pluginGrant?: PluginGrant): any {
    return {
        sender: {
            id: -1,
            send: () => { /* the API has no renderer to receive progress */ },
            isDestroyed: () => false,
        },
        senderFrame: null,
        fromApi: true,
        apiPrincipalId: principalLogId(principal),
        ...(pluginGrant ? { pluginGrant } : {}),
    };
}

/**
 * Admin channels (keys, app webhooks, plugins, Cloudflare): principals other than 'system' must not call them.
 * cloudflare:* also blocks every call from the API/plugins (e.fromApi) inside the handler itself.
 */
export const ADMIN_CHANNEL_PREFIXES = ['api:', 'plugins:', 'cloudflare:'];

/**
 * The ONLY exception to the rule above: an admin channel that the 'plugin' principal may call when, and only when, the call carries the grant
 * (info.pluginGrant) of that same plugin, issued by PluginApiBridge after it checked the manifest permission + prefix.
 * API keys, employees, and plugins without a grant (e.g. an API v1 route calling on behalf of a plugin) are still blocked like every other admin channel.
 * The handler (electron/ipc/cloud/cloudflareWorkersIpc.ts) re-checks the grant + prefix + folder.
 */
export const PLUGIN_DELEGATED_CHANNEL_PREFIXES = ['cloudflare:workers:'];

export function isAdminChannel(channel: string): boolean {
    return ADMIN_CHANNEL_PREFIXES.some(p => channel.startsWith(p));
}

export function isPluginDelegatedChannel(channel: string): boolean {
    return PLUGIN_DELEGATED_CHANNEL_PREFIXES.some(p => channel.startsWith(p));
}

/** Whether this call may be delegated to a plugin: plugin principal + that plugin's own grant + the delegated channel. */
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
            // API / plugin admin channels are for the machine owner's UI only: they cannot raise their own permissions through the API.
            throw new ApiError(403, 'FORBIDDEN_SCOPE', tr('Kênh {{channel}} chỉ dùng trong app', { channel }));
        }
        const handler = this.source.get(channel);
        if (!handler) throw new ApiError(501, 'NOT_IMPLEMENTED', tr('Thiếu kênh IPC {{channel}}', { channel }));
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
                reject(new ApiError(504, 'TIMEOUT', tr('Kênh {{channel}} xử lý quá {{v1}} giây', { channel, v1: Math.round(timeoutMs / 1000) })));
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
