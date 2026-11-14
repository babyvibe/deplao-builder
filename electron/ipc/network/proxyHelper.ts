import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import AppModeManager from '../../../src/utils/app/AppModeManager';
import Logger from '../../../src/utils/Logger';
import * as fs from 'fs';
import * as path from 'path';
import { PROXY_FILE_PATH_FIELDS, PROXY_FILE_PATH_LIST_FIELDS } from '../../../src/services/http/proxyActionPolicy';
import {
    BOSS_ONLY_CHANNEL_CODE, BOSS_ONLY_CHANNEL_ERROR, PROXY_DEFAULT_TIMEOUT_MS, employeeChannelSpec,
} from '../../../src/services/http/employeeChannelRoutes';
import { tr } from '../../../src/shared/i18n';

/**
 * Fire-and-forget proxy: send a DB/CRM mutation to the Boss when running in Employee mode.
 * The Boss executes the same IPC handler on its own DB, then relays the resulting
 * event back to all connected employees via SSE.
 *
 * In Boss / standalone mode this is a no-op.
 */
export function proxyToBoss(channel: string, params: any): void {
    try {
        if (AppModeManager.getInstance().getMode() !== 'employee') return;

        const WsMgr = require('../../../src/utils/app/WorkspaceManager').default;
        const activeWs = WsMgr.getInstance().getActiveWorkspace();
        if (!activeWs || activeWs.type !== 'remote') return;

        const HCM = require('../../../src/services/http/HttpConnectionManager').default;
        if (!HCM.getInstance().isConnected(activeWs.id)) return;

        HCM.getInstance().proxyAction(activeWs.id, channel, params).then((result: any) => {
            // Boss rejected it (channel / account / file) or the handler failed: this used to be silent → now written to the Log as a trace
            if (result && result.success === false) {
                Logger.warn(`[proxyToBoss] ${channel} bị Boss từ chối: ${result.code || ''} ${result.error || ''}`.trim());
            }
        }).catch((err: any) => {
            Logger.warn(`[proxyToBoss] ${channel} failed: ${err.message}`);
        });
    } catch {}
}

/**
 * Wait-for-result proxy: used for actions the user sees (bank cards, notes, AI assistant, integrations…): the UI receives
 * the exact `{ success, error, code, … }` the handler returns on Boss, instead of a fake `{ success: true }` followed by a silent failure.
 * Not employee mode / not connected to Boss / network error → `{ success: false, error, code }` (does not throw).
 */
export async function proxyToBossWithResult(channel: string, params: any, opts: { timeoutMs?: number } = {}): Promise<any> {
    try {
        const WsMgr = require('../../../src/utils/app/WorkspaceManager').default;
        const activeWs = WsMgr.getInstance().getActiveWorkspace();
        if (!activeWs || activeWs.type !== 'remote') {
            return { success: false, error: tr('Không kết nối tới Boss'), code: 'NOT_CONNECTED' };
        }
        const HCM = require('../../../src/services/http/HttpConnectionManager').default;
        if (!HCM.getInstance().isConnected(activeWs.id)) {
            return { success: false, error: tr('Chưa kết nối tới Boss'), code: 'NOT_CONNECTED' };
        }
        const result = await HCM.getInstance().proxyAction(activeWs.id, channel, params, opts.timeoutMs);
        if (!result || typeof result !== 'object') {
            return { success: false, error: tr('Boss không trả kết quả'), code: 'BAD_RESPONSE' };
        }
        if (result.success === false) {
            Logger.warn(`[proxyToBossWithResult] ${channel} bị Boss từ chối: ${result.code || ''} ${result.error || ''}`.trim());
        }
        return result;
    } catch (err: any) {
        Logger.warn(`[proxyToBossWithResult] ${channel} failed: ${err?.message || err}`);
        return { success: false, error: err?.message || tr('Không gửi được yêu cầu tới Boss'), code: 'NETWORK_ERROR' };
    }
}

/**
 * Upload media files from Employee machine to Boss machine.
 * Used when Employee's local file path is not valid on Boss (cross-platform paths).
 * Each file is read on Employee, sent as base64 via HTTP, saved on Boss,
 * and the Boss-resolved absolute path is returned.
 *
 * @param filePaths  - Local file paths on Employee machine
 * @param zaloId     - Zalo account ID for organizing media storage on Boss
 * @returns Boss-resolved absolute file paths (preserves order)
 */
export async function uploadEmployeeMedia(filePaths: string[], zaloId?: string): Promise<string[]> {
    // Same criteria as "chế độ nhân viên" (employee mode) in the handlers (the open workspace is a remote one). Before, it followed
    // AppModeManager: a Boss machine that opens another Boss's employee workspace does not upload, and that other Boss rejects the path.
    const WsMgr = require('../../../src/utils/app/WorkspaceManager').default;
    const activeWs = WsMgr.getInstance().getActiveWorkspace();
    if (!activeWs || activeWs.type !== 'remote') return filePaths;

    const HCM = require('../../../src/services/http/HttpConnectionManager').default;
    const client = HCM.getInstance().getServiceForWorkspace(activeWs.id);
    if (!client) throw new Error(tr('Không kết nối tới Boss'));

    const bossPaths: string[] = new Array(filePaths.length);

    // Upload all files in parallel to cut the wait time (especially when sending many images)
    const uploadTasks = filePaths.map(async (fp, index) => {
        if (!fp) { bossPaths[index] = fp; return; }
        if (!fs.existsSync(fp)) {
            Logger.warn(`[uploadEmployeeMedia] File not found on Employee: ${fp}`);
            bossPaths[index] = fp;
            return;
        }
        const filename = path.basename(fp);
        try {
            // Read without blocking the main process (files up to 1 GB: readFileSync froze the whole app while reading)
            const buffer = await fs.promises.readFile(fp);
            const result = await client.uploadMedia(buffer, filename, zaloId);
            if (result.success && result.bossPath) {
                bossPaths[index] = result.bossPath;
                Logger.log(`[uploadEmployeeMedia] ✅ ${fp} → ${result.bossPath}`);
            } else {
                throw new Error(result.error || tr('Upload thất bại'));
            }
        } catch (err: any) {
            throw new Error(tr('Không thể upload file {{fp}}: {{message}}', { fp, message: err.message }));
        }
    });

    await Promise.all(uploadTasks);
    return bossPaths;
}

// ─── Files in params + Facebook / Telegram handlers in employee mode ─────────────────────────────

/** Account id in auth (buildZaloAuth: accountId; markConversationRead: zaloId): an object or a JSON string. */
function authAccountId(auth: any): string {
    try {
        const authObj = typeof auth === 'string' ? JSON.parse(auth) : auth;
        return String(authObj?.zaloId || authObj?.zalo_id || authObj?.accountId || '');
    } catch {
        return '';
    }
}

/**
 * Upload the employee machine's local files to Boss before proxying (the employee machine's path does not exist on the Boss machine), replacing them with
 * the Boss path returned. Exactly the fields Boss checks (PROXY_FILE_PATH_FIELDS / PROXY_FILE_PATH_LIST_FIELDS of
 * proxyActionPolicy): shared by zaloIpc.wrap (Zalo) and routeEmployeeChannel (Facebook / Telegram).
 * Files are saved to the media folder of the account performing the action: `accountId` (Facebook / Telegram: params.accountId), otherwise
 * zaloId / auth (Zalo). If the open workspace is not remote → left unchanged (uploadEmployeeMedia does not upload).
 */
export async function prepareLocalFilesForProxy(params: any, accountId?: string): Promise<any> {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
    const result: any = { ...params };
    const uploadAccount = String(accountId || params.zaloId || authAccountId(params.auth) || '') || undefined;

    for (const field of PROXY_FILE_PATH_FIELDS) {
        if (result[field] && typeof result[field] === 'string' && result[field].length > 0) {
            const bossPaths = await uploadEmployeeMedia([result[field]], uploadAccount);
            if (bossPaths && bossPaths[0]) result[field] = bossPaths[0];
        }
    }
    for (const field of PROXY_FILE_PATH_LIST_FIELDS) {
        if (Array.isArray(result[field]) && result[field].length > 0) {
            const bossPaths = await uploadEmployeeMedia(result[field], uploadAccount);
            if (bossPaths && bossPaths.length > 0) result[field] = bossPaths;
        }
    }
    return result;
}

type InvokeListener = (event: IpcMainInvokeEvent, ...args: any[]) => any;

/** The open workspace is a remote one (employee machine): same criteria as zaloIpc.wrap / uploadEmployeeMedia. */
function isRemoteWorkspaceActive(): boolean {
    try {
        const WsMgr = require('../../../src/utils/app/WorkspaceManager').default;
        return WsMgr.getInstance().getActiveWorkspace()?.type === 'remote';
    } catch {
        return false;
    }
}

/**
 * Wraps a personal Facebook / Telegram handler according to the employeeChannelRoutes table. On Boss / standalone machines, or for Boss commands running on behalf of an
 * employee (`_fromRelay`) or the "local" channel → the handler runs as before. Employee machines (remote workspace):
 *   - proxy: uploads the files in the params to Boss → /api/proxy/action → returns the REAL result of the handler on Boss (if Boss rejects it
 *     / network error → `{ success: false, error, code }`, does not throw);
 *   - boss_only: `{ success: false, error, code: 'BOSS_ONLY' }` - does not run locally (the employee machine has no session).
 */
export function routeEmployeeChannel(channel: string, listener: InvokeListener): InvokeListener {
    const spec = employeeChannelSpec(channel);
    if (!spec || spec.route === 'local') return listener;
    return async (event, ...args) => {
        const params = args[0];
        const fromRelay = !!(params && typeof params === 'object' && params._fromRelay);
        if (fromRelay || !isRemoteWorkspaceActive()) return listener(event, ...args);
        if (spec.route === 'boss_only') {
            return { success: false, error: BOSS_ONLY_CHANNEL_ERROR, code: BOSS_ONLY_CHANNEL_CODE };
        }
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
            return { success: false, error: tr('Tham số không hợp lệ'), code: 'BAD_REQUEST' };
        }
        let prepared: any;
        try {
            prepared = await prepareLocalFilesForProxy(params, String(params.accountId || '') || undefined);
        } catch (err: any) {
            Logger.warn(`[proxyHelper] ${channel}: upload file lên Boss lỗi: ${err?.message || err}`);
            return { success: false, error: err?.message || tr('Không tải được file lên Boss'), code: 'UPLOAD_FAILED' };
        }
        return proxyToBossWithResult(channel, prepared, { timeoutMs: spec.timeoutMs ?? PROXY_DEFAULT_TIMEOUT_MS });
    };
}

/**
 * The `ipcMain` of facebookIpc.ts / telegramUserIpc.ts: `handle(channel, fn)` registers a handler wrapped by routeEmployeeChannel:
 * a new handler follows the employeeChannelRoutes table by itself (not yet classified → runs as before; the proxyActionPolicy test turns red).
 */
export function employeeRoutedIpcMain(target: Pick<IpcMain, 'handle'>): Pick<IpcMain, 'handle'> {
    return {
        handle: (channel: string, listener: InvokeListener) => target.handle(channel, routeEmployeeChannel(channel, listener)),
    };
}
