/**
 * cloudflareWorkersIpc — kênh cloudflare:workers:* : Worker + D1 trên tài khoản Cloudflare đã kết nối, cho ứng dụng
 * (plugin) có quyền "cloudflare:workers" (fintrack-deplao-plugin/docs/CONTRACTS.md §1). registerCloudflareIpc() đăng ký
 * các kênh này cùng lúc với cloudflare:* (electron/ipc/cloud/cloudflareIpc.ts). Logic ở src/services/cloudflare/workers.
 *
 * Ai được gọi (kiểm lại ở đây dù lớp trên đã kiểm):
 *  - Giao diện của chủ máy: event thật của Electron (không có fromApi), máy chủ + workspace local. Tên chỉ cần đúng định
 *    dạng của Cloudflare; bundleDir / dir là đường dẫn tuyệt đối. (Preload chưa mở các kênh này — chưa có màn hình dùng.)
 *  - Ứng dụng (plugin): CHỈ khi PluginApiBridge đã kiểm quyền manifest + tiền tố tài nguyên và IpcInvoker gắn giấy uỷ
 *    quyền (event.pluginGrant — xem PLUGIN_DELEGATED_CHANNEL_PREFIXES trong src/services/api/IpcInvoker.ts). Tiền tố lấy
 *    từ giấy (không tin payload); thư mục phải nằm trong thư mục ứng dụng đã cài (realpath).
 *  - API key / plugin không có giấy: IpcInvoker chặn từ trước (kênh quản trị 'cloudflare:'); event fromApi không giấy
 *    (vd principal 'system') tới được đây vẫn bị từ chối (APP_ONLY).
 *  - Gắn tên miền (domainAttach) từ ứng dụng: Deplao hỏi người dùng bằng hộp thoại của chính Deplao (sau khi đã kiểm tên,
 *    trước khi ghi DNS). Mỗi ứng dụng một hộp thoại tại một lúc; bấm "Không" thì 60 giây sau mới hỏi lại (chống hỏi dồn).
 * Trả { success: true, result } | { success: false, error, code[, retryAfterMs] }. Không log token, JWT, secret, SQL.
 */
import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import Logger, { sanitizeLogText } from '../../../src/utils/Logger';
import { CloudError } from '../../../src/services/cloudflare/contracts';
import type { PluginGrant } from '../../../src/services/api/IpcInvoker';
import type { DomainConfirm, WorkersDeployer, WorkersScope } from '../../../src/services/cloudflare/workers/WorkersDeployer';
import { assertResourceName, WORKERS_PERMISSION } from '../../../src/services/cloudflare/workers/validate';

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

/** Câu hỏi gắn tên miền cho người dùng: ứng dụng nào, Worker nào, tên nào trên tên miền nào. */
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
    /** Hỏi người dùng trước khi ứng dụng gắn tên miền (mặc định: hộp thoại của Deplao). true = đồng ý. */
    confirmDomain?: (req: DomainConfirmRequest) => Promise<boolean>;
    now?: () => number;
}

/** Hộp thoại của Deplao (cửa sổ chính đang hiện làm cửa sổ cha); nút an toàn ("Không") là mặc định. */
async function nativeConfirmDomain(req: DomainConfirmRequest): Promise<boolean> {
    const { BrowserWindow, dialog } = require('electron') as typeof import('electron');
    const options: import('electron').MessageBoxOptions = {
        type: 'question',
        buttons: ['Gắn tên miền', 'Không'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Gắn tên miền cho ứng dụng',
        message: `Ứng dụng “${req.pluginName}” muốn gắn ${req.hostname} cho Worker “${req.worker}”.`,
        detail: `Cloudflare sẽ tạo bản ghi DNS và chứng chỉ cho ${req.hostname} trên tên miền ${req.zoneName} của bạn. `
            + 'Mọi truy cập tới địa chỉ này do Worker của ứng dụng trả lời. Gỡ được bất cứ lúc nào trong ứng dụng.',
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

/** Bấm "Không" → ứng dụng đó chờ chừng này mới được hỏi lại. */
const DECLINE_COOLDOWN_MS = 60_000;

type Caller = { kind: 'app' } | { kind: 'plugin'; grant: PluginGrant };

/** Người gọi: giao diện chủ máy (event thật) hoặc ứng dụng có giấy uỷ quyền hợp lệ cho quyền cloudflare:workers. */
function callerOf(e: any): Caller {
    if (!e?.fromApi) return { kind: 'app' };
    const g = e.pluginGrant as PluginGrant | undefined;
    const valid = !!g
        && g.permission === WORKERS_PERMISSION
        && typeof g.pluginId === 'string' && !!g.pluginId
        && typeof g.resourcePrefix === 'string' && !!g.resourcePrefix
        && typeof g.pluginDir === 'string' && !!g.pluginDir;
    if (!valid) {
        throw new CloudError('APP_ONLY', 'Worker / D1 chỉ dùng được từ app trên máy chủ hoặc từ ứng dụng đã được cấp quyền cloudflare:workers');
    }
    return { kind: 'plugin', grant: g as PluginGrant };
}

function obj(v: unknown): Record<string, any> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

/** Thư mục tuyệt đối (realpath). Ứng dụng: phải nằm trong thư mục ứng dụng của giấy uỷ quyền. */
function absDir(v: unknown, caller: Caller, label: string): string {
    if (typeof v !== 'string' || !v || v.length > 1000 || !path.isAbsolute(v)) {
        throw new CloudError('VALIDATION_ERROR', `${label} phải là đường dẫn tuyệt đối tới thư mục`);
    }
    let real: string;
    try {
        real = fs.realpathSync(v);
    } catch {
        throw new CloudError('CF_BUNDLE_INVALID', `Không thấy thư mục ${label}`);
    }
    if (caller.kind === 'plugin') {
        let root: string;
        try {
            root = fs.realpathSync(caller.grant.pluginDir);
        } catch {
            throw new CloudError('CF_BUNDLE_INVALID', 'Không thấy thư mục của ứng dụng trên máy');
        }
        if (real !== root && !real.startsWith(root + path.sep)) {
            throw new CloudError('CF_BUNDLE_INVALID', `${label} phải nằm trong thư mục của ứng dụng`);
        }
    }
    if (!fs.statSync(real).isDirectory()) throw new CloudError('CF_BUNDLE_INVALID', `${label} không phải thư mục`);
    return real;
}

/** Lỗi bình thường (sai tên, thiếu quyền, chưa kết nối, người dùng bấm "Không"…) — không ghi log. */
const QUIET_CODES = new Set([
    'APP_ONLY', 'EMPLOYEE_MACHINE', 'REMOTE_WORKSPACE', 'CF_NOT_CONNECTED', 'CF_PERMISSION', 'CF_NAME_FORBIDDEN',
    'CF_DECLINED', 'VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT',
]);

function fail(channel: string, err: unknown): { success: false; error: string; code: string; retryAfterMs?: number } {
    if (err instanceof CloudError) {
        if (!QUIET_CODES.has(err.code)) {
            // d1Query: chỉ ghi mã — câu lỗi của D1 có thể trích một đoạn SQL / dữ liệu.
            const detail = channel === 'cloudflare:workers:d1Query' ? '' : ` — ${sanitizeLogText(err.message, 300)}`;
            Logger.warn(`[cloudflareWorkersIpc] ${channel}: ${err.code}${detail}`);
        }
        const out: { success: false; error: string; code: string; retryAfterMs?: number } = { success: false, error: err.message, code: err.code };
        if (err.retryAfterMs) out.retryAfterMs = err.retryAfterMs;
        return out;
    }
    const message = sanitizeLogText(String((err as any)?.message || err || 'Lỗi không xác định'), 500);
    Logger.error(`[cloudflareWorkersIpc] ${channel}: ${message}`);
    return { success: false, error: message, code: 'INTERNAL_ERROR' };
}

type Handler = (e: any, arg: any) => Promise<Record<string, unknown>>;

interface CallCtx {
    caller: Caller;
    scope: WorkersScope;
    arg: Record<string, any>;
    /** Tiến độ → nhật ký của ứng dụng (WorkersDeployer tự ghi nhật ký app). */
    progress: (message: string) => void;
}

/** Handler theo kênh (tách khỏi ipcMain để test gọi thẳng). */
export function createCloudflareWorkersHandlers(deps: WorkersIpcDeps = defaultDeps): Record<CloudflareWorkersChannel, Handler> {
    const now = deps.now ?? Date.now;
    /** Ứng dụng đang có hộp thoại gắn tên miền chờ trả lời. */
    const asking = new Set<string>();
    /** Ứng dụng → lúc người dùng bấm "Không". */
    const declinedAt = new Map<string, number>();
    /** Hỏi người dùng thay cho ứng dụng: một hộp thoại mỗi ứng dụng, bấm "Không" thì 60 giây sau mới hỏi lại. */
    const confirmFor = (grant: PluginGrant): DomainConfirm => async info => {
        const ask = deps.confirmDomain;
        if (!ask) throw new CloudError('CF_DECLINED', 'Bản Deplao này chưa hỏi được bạn để gắn tên miền');
        const last = declinedAt.get(grant.pluginId);
        if (last !== undefined && now() - last < DECLINE_COOLDOWN_MS) {
            throw new CloudError('CF_DECLINED', 'Bạn vừa chọn "Không" ở hộp thoại của Deplao, chờ 1 phút rồi thử lại');
        }
        if (asking.has(grant.pluginId)) {
            throw new CloudError('CONFLICT', 'Deplao đang hỏi bạn ở một hộp thoại khác, trả lời hộp thoại đó trước');
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
            if (deps.isEmployeeMachine()) throw new CloudError('EMPLOYEE_MACHINE', 'Máy nhân viên không dùng tính năng Cloudflare — hãy dùng trên máy chủ');
            if (!deps.isWorkspaceAvailable()) throw new CloudError('REMOTE_WORKSPACE', 'Workspace từ xa không dùng Cloudflare; hãy mở workspace trên máy này');
            const scope = deps.deployer().scoped(caller.kind === 'plugin' ? caller.grant.resourcePrefix : null);
            const progress = (message: string) => {
                if (caller.kind !== 'plugin' || typeof caller.grant.log !== 'function') return;
                try { caller.grant.log('info', message); } catch { /* nhật ký lỗi: bỏ qua */ }
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
            assertResourceName(arg.name, scope.prefix, 'Worker'); // tên trước, rồi mới đụng tới đĩa
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
        // Ứng dụng gọi → hộp thoại của Deplao; giao diện chủ máy (người dùng tự bấm trong Deplao) → không hỏi lại.
        'cloudflare:workers:domainAttach': wrap('cloudflare:workers:domainAttach', ({ caller, scope, arg }) =>
            scope.domainAttach(arg.name, arg.hostname, caller.kind === 'plugin' ? confirmFor(caller.grant) : undefined)),
        'cloudflare:workers:domainDetach': wrap('cloudflare:workers:domainDetach', ({ scope, arg }) => scope.domainDetach(arg.name, arg.hostname)),
    };
}

export function registerCloudflareWorkersIpc(deps?: WorkersIpcDeps): void {
    const handlers = createCloudflareWorkersHandlers(deps);
    for (const channel of CLOUDFLARE_WORKERS_CHANNELS) ipcMain.handle(channel, handlers[channel]);
}
