/**
 * cloudflareWorkersIpc: cloudflare:workers:* channels: Worker + D1 on the connected Cloudflare account, for apps
 * (plugins) with the "cloudflare:workers" permission (fintrack-deplao-app/docs/CONTRACTS.md §1). registerCloudflareIpc() registers
 * these channels together with cloudflare:* (electron/ipc/cloud/cloudflareIpc.ts). The logic lives in src/services/cloudflare/workers.
 *
 * Who may call them (re-checked here, even though the layer above already checked):
 *  - The machine owner's UI: a real Electron event (no fromApi), host machine + local workspace. The name only needs Cloudflare's format;
 *    bundleDir / dir are absolute paths. (The preload does not expose these channels yet: no screen uses them.)
 *  - Apps (plugins): ONLY when PluginApiBridge has checked the manifest permission + resource prefix and IpcInvoker attached the grant
 *    (event.pluginGrant, see PLUGIN_DELEGATED_CHANNEL_PREFIXES in src/services/api/IpcInvoker.ts). The prefix comes
 *    from the grant (the payload is not trusted); the folder must be inside the installed app's folder (realpath).
 *  - API keys / plugins without a grant: IpcInvoker blocks them first (admin channel 'cloudflare:'); a fromApi event without a grant
 *    (e.g. principal 'system') that still reaches here is rejected (APP_ONLY).
 *  - Domain attach (domainAttach) from an app: Deplao asks the user with its own dialog (after checking the name,
 *    before writing DNS). One dialog per app at a time; if the user clicks "Không" (No), the app is asked again only after 60 seconds (prevents stacked prompts).
 * Returns { success: true, result } | { success: false, error, code[, retryAfterMs] }. Does not log tokens, JWTs, secrets, SQL.
 */
import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import Logger, { sanitizeLogText } from '../../../src/utils/Logger';
import { CloudError } from '../../../src/services/cloudflare/contracts';
import type { PluginGrant } from '../../../src/services/api/IpcInvoker';
import type { DomainConfirm, WorkersDeployer, WorkersScope } from '../../../src/services/cloudflare/workers/WorkersDeployer';
import { assertResourceName, WORKERS_PERMISSION } from '../../../src/services/cloudflare/workers/validate';
import { tr } from '../../../src/shared/i18n';

export const CLOUDFLARE_WORKERS_CHANNELS = [
    'cloudflare:workers:status',
    'cloudflare:workers:get',
    'cloudflare:workers:deploy',
    'cloudflare:workers:d1Ensure',
    'cloudflare:workers:d1Migrate',
    'cloudflare:workers:d1Query',
    'cloudflare:workers:zones',
    'cloudflare:workers:domains',
    'cloudflare:workers:domainAttach',
    'cloudflare:workers:domainDetach',
] as const;

export type CloudflareWorkersChannel = typeof CLOUDFLARE_WORKERS_CHANNELS[number];

/** The domain attach question for the user: which app, which Worker, which name on which domain. */
export interface DomainConfirmRequest {
    pluginId: string;
    pluginName: string;
    worker: string;
    hostname: string;
    zoneName: string;
}

export interface WorkersIpcDeps {
    deployer: () => Pick<WorkersDeployer, 'scoped'>;
    isEmployeeMachine: () => boolean;
    isWorkspaceAvailable: () => boolean;
    /** Asks the user before an app attaches a domain (default: Deplao's dialog). true = agree. */
    confirmDomain?: (req: DomainConfirmRequest) => Promise<boolean>;
    now?: () => number;
}

/** Deplao's dialog (the visible main window is the parent window); the safe button ("Không" (No)) is the default. */
async function nativeConfirmDomain(req: DomainConfirmRequest): Promise<boolean> {
    const { BrowserWindow, dialog } = require('electron') as typeof import('electron');
    const options: import('electron').MessageBoxOptions = {
        type: 'question',
        buttons: [tr('Gắn tên miền'), tr('Không')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: tr('Gắn tên miền cho ứng dụng'),
        message: tr('Ứng dụng “{{pluginName}}” muốn gắn {{hostname}} cho Worker “{{worker}}”.', { pluginName: req.pluginName, hostname: req.hostname, worker: req.worker }),
        detail: tr('Cloudflare sẽ tạo bản ghi DNS và chứng chỉ cho {{hostname}} trên tên miền {{zoneName}} của bạn. Mọi truy cập tới địa chỉ này do Worker của ứng dụng trả lời. Gỡ được bất cứ lúc nào trong ứng dụng.', { hostname: req.hostname, zoneName: req.zoneName }),
    };
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
    const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return res.response === 0;
}

const defaultDeps: WorkersIpcDeps = {
    deployer: () => (require('../../../src/services/cloudflare/workers/WorkersDeployer') as typeof import('../../../src/services/cloudflare/workers/WorkersDeployer')).workersDeployer,
    isEmployeeMachine: () => {
        try {
            return require('../../../src/utils/app/AppModeManager').default.getInstance().getMode() === 'employee';
        } catch {
            return false;
        }
    },
    isWorkspaceAvailable: () => require('../../../src/services/api/runtime').isWorkspaceAvailable(),
    confirmDomain: nativeConfirmDomain,
};

/** Clicking "Không" (No) → that app must wait this long before it is asked again. */
const DECLINE_COOLDOWN_MS = 60_000;

type Caller = { kind: 'app' } | { kind: 'plugin'; grant: PluginGrant };

/** Caller: the machine owner's UI (real event) or an app with a valid grant for the cloudflare:workers permission. */
function callerOf(e: any): Caller {
    if (!e?.fromApi) return { kind: 'app' };
    const g = e.pluginGrant as PluginGrant | undefined;
    const valid = !!g
        && g.permission === WORKERS_PERMISSION
        && typeof g.pluginId === 'string' && !!g.pluginId
        && typeof g.resourcePrefix === 'string' && !!g.resourcePrefix
        && typeof g.pluginDir === 'string' && !!g.pluginDir;
    if (!valid) {
        throw new CloudError('APP_ONLY', tr('Worker / D1 chỉ dùng được từ app trên máy chủ hoặc từ ứng dụng đã được cấp quyền cloudflare:workers'));
    }
    return { kind: 'plugin', grant: g as PluginGrant };
}

function obj(v: unknown): Record<string, any> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

/** Absolute folder (realpath). App: must be inside the app folder named in its grant. */
function absDir(v: unknown, caller: Caller, label: string): string {
    if (typeof v !== 'string' || !v || v.length > 1000 || !path.isAbsolute(v)) {
        throw new CloudError('VALIDATION_ERROR', tr('{{label}} phải là đường dẫn tuyệt đối tới thư mục', { label }));
    }
    let real: string;
    try {
        real = fs.realpathSync(v);
    } catch {
        throw new CloudError('CF_BUNDLE_INVALID', tr('Không thấy thư mục {{label}}', { label }));
    }
    if (caller.kind === 'plugin') {
        let root: string;
        try {
            root = fs.realpathSync(caller.grant.pluginDir);
        } catch {
            throw new CloudError('CF_BUNDLE_INVALID', tr('Không thấy thư mục của ứng dụng trên máy'));
        }
        if (real !== root && !real.startsWith(root + path.sep)) {
            throw new CloudError('CF_BUNDLE_INVALID', tr('{{label}} phải nằm trong thư mục của ứng dụng', { label }));
        }
    }
    if (!fs.statSync(real).isDirectory()) throw new CloudError('CF_BUNDLE_INVALID', tr('{{label}} không phải thư mục', { label }));
    return real;
}

/** Expected errors (wrong name, missing permission, not connected, user clicked "Không" (No)…), not logged. */
const QUIET_CODES = new Set([
    'APP_ONLY', 'EMPLOYEE_MACHINE', 'REMOTE_WORKSPACE', 'CF_NOT_CONNECTED', 'CF_PERMISSION', 'CF_NAME_FORBIDDEN',
    'CF_DECLINED', 'VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT',
]);

function fail(channel: string, err: unknown): { success: false; error: string; code: string; retryAfterMs?: number } {
    if (err instanceof CloudError) {
        if (!QUIET_CODES.has(err.code)) {
            // d1Query: log only the code; D1's error message may quote a piece of SQL / data.
            const detail = channel === 'cloudflare:workers:d1Query' ? '' : ` — ${sanitizeLogText(err.message, 300)}`;
            Logger.warn(`[cloudflareWorkersIpc] ${channel}: ${err.code}${detail}`);
        }
        const out: { success: false; error: string; code: string; retryAfterMs?: number } = { success: false, error: err.message, code: err.code };
        if (err.retryAfterMs) out.retryAfterMs = err.retryAfterMs;
        return out;
    }
    const message = sanitizeLogText(String((err as any)?.message || err || tr('Lỗi không xác định')), 500);
    Logger.error(`[cloudflareWorkersIpc] ${channel}: ${message}`);
    return { success: false, error: message, code: 'INTERNAL_ERROR' };
}

type Handler = (e: any, arg: any) => Promise<Record<string, unknown>>;

interface CallCtx {
    caller: Caller;
    scope: WorkersScope;
    arg: Record<string, any>;
    /** Progress → the app's log (WorkersDeployer writes to the app log itself). */
    progress: (message: string) => void;
}

/** Handler per channel (kept apart from ipcMain so tests can call it directly). */
export function createCloudflareWorkersHandlers(deps: WorkersIpcDeps = defaultDeps): Record<CloudflareWorkersChannel, Handler> {
    const now = deps.now ?? Date.now;
    /** Apps that have a domain attach dialog waiting for an answer. */
    const asking = new Set<string>();
    /** App → the time the user clicked "Không" (No). */
    const declinedAt = new Map<string, number>();
    /** Asks the user on the app's behalf: one dialog per app; if "Không" (No) is clicked, the app is asked again only after 60 seconds. */
    const confirmFor = (grant: PluginGrant): DomainConfirm => async info => {
        const ask = deps.confirmDomain;
        if (!ask) throw new CloudError('CF_DECLINED', tr('Bản Deplao này chưa hỏi được bạn để gắn tên miền'));
        const last = declinedAt.get(grant.pluginId);
        if (last !== undefined && now() - last < DECLINE_COOLDOWN_MS) {
            throw new CloudError('CF_DECLINED', tr('Bạn vừa chọn "Không" ở hộp thoại của Deplao, chờ 1 phút rồi thử lại'));
        }
        if (asking.has(grant.pluginId)) {
            throw new CloudError('CONFLICT', tr('Deplao đang hỏi bạn ở một hộp thoại khác, trả lời hộp thoại đó trước'));
        }
        asking.add(grant.pluginId);
        try {
            const ok = await ask({ pluginId: grant.pluginId, pluginName: grant.pluginName || grant.pluginId, ...info });
            if (ok) declinedAt.delete(grant.pluginId);
            else declinedAt.set(grant.pluginId, now());
            return ok;
        } finally {
            asking.delete(grant.pluginId);
        }
    };

    const wrap =(channel: CloudflareWorkersChannel, fn: (ctx: CallCtx) => Promise<unknown>): Handler => async (e, arg) => {
        try {
            const caller = callerOf(e);
            if (deps.isEmployeeMachine()) throw new CloudError('EMPLOYEE_MACHINE', tr('Máy nhân viên không dùng tính năng Cloudflare — hãy dùng trên máy chủ'));
            if (!deps.isWorkspaceAvailable()) throw new CloudError('REMOTE_WORKSPACE', tr('Workspace từ xa không dùng Cloudflare; hãy mở workspace trên máy này'));
            const scope = deps.deployer().scoped(caller.kind === 'plugin' ? caller.grant.resourcePrefix : null);
            const progress = (message: string) => {
                if (caller.kind !== 'plugin' || typeof caller.grant.log !== 'function') return;
                try { caller.grant.log('info', message); } catch { /* error log: ignore */ }
            };
            const result = await fn({ caller, scope, arg: obj(arg), progress });
            return { success: true, result };
        } catch (err) {
            return fail(channel, err);
        }
    };

    return {
        'cloudflare:workers:status': wrap('cloudflare:workers:status', ({ scope, arg }) =>
            scope.status(typeof arg.prefix === 'string' ? arg.prefix.slice(0, 63) : undefined)),
        'cloudflare:workers:get': wrap('cloudflare:workers:get', ({ scope, arg }) => scope.workerGet(arg.name)),
        'cloudflare:workers:deploy': wrap('cloudflare:workers:deploy', async ({ caller, scope, arg, progress }) => {
            assertResourceName(arg.name, scope.prefix, 'Worker'); // check the name first, only then touch the disk
            const bundleDir = absDir(arg.bundleDir, caller, 'bundleDir');
            return scope.deployBundle(
                { name: arg.name, bindings: arg.bindings, secrets: arg.secrets, workersDev: arg.workersDev },
                bundleDir,
                progress,
            );
        }),
        'cloudflare:workers:d1Ensure': wrap('cloudflare:workers:d1Ensure', ({ scope, arg }) => scope.d1Ensure(arg.name)),
        'cloudflare:workers:d1Migrate': wrap('cloudflare:workers:d1Migrate', async ({ caller, scope, arg, progress }) => {
            assertResourceName(arg.name, scope.prefix, 'D1');
            return scope.d1Migrate(arg.name, absDir(arg.dir, caller, 'dir'), progress);
        }),
        'cloudflare:workers:d1Query': wrap('cloudflare:workers:d1Query', ({ scope, arg }) => scope.d1Query(arg.name, arg.sql, arg.params)),
        'cloudflare:workers:zones': wrap('cloudflare:workers:zones', ({ scope }) => scope.zones()),
        'cloudflare:workers:domains': wrap('cloudflare:workers:domains', ({ scope, arg }) => scope.domainList(arg.name)),
        // App call → Deplao's dialog; the machine owner's UI (the user clicks inside Deplao itself) → not asked again.
        'cloudflare:workers:domainAttach': wrap('cloudflare:workers:domainAttach', ({ caller, scope, arg }) =>
            scope.domainAttach(arg.name, arg.hostname, caller.kind === 'plugin' ? confirmFor(caller.grant) : undefined)),
        'cloudflare:workers:domainDetach': wrap('cloudflare:workers:domainDetach', ({ scope, arg }) => scope.domainDetach(arg.name, arg.hostname)),
    };
}

export function registerCloudflareWorkersIpc(deps?: WorkersIpcDeps): void {
    const handlers = createCloudflareWorkersHandlers(deps);
    for (const channel of CLOUDFLARE_WORKERS_CHANNELS) ipcMain.handle(channel, handlers[channel]);
}
