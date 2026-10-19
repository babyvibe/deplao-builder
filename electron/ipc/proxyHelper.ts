import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import AppModeManager from '../../src/utils/AppModeManager';
import Logger from '../../src/utils/Logger';
import * as fs from 'fs';
import * as path from 'path';
import { PROXY_FILE_PATH_FIELDS, PROXY_FILE_PATH_LIST_FIELDS } from '../../src/services/http/proxyActionPolicy';
import {
    BOSS_ONLY_CHANNEL_CODE, BOSS_ONLY_CHANNEL_ERROR, PROXY_DEFAULT_TIMEOUT_MS, employeeChannelSpec,
} from '../../src/services/http/employeeChannelRoutes';

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

        const WsMgr = require('../../src/utils/WorkspaceManager').default;
        const activeWs = WsMgr.getInstance().getActiveWorkspace();
        if (!activeWs || activeWs.type !== 'remote') return;

        const HCM = require('../../src/services/http/HttpConnectionManager').default;
        if (!HCM.getInstance().isConnected(activeWs.id)) return;

        HCM.getInstance().proxyAction(activeWs.id, channel, params).then((result: any) => {
            // Boss từ chối (kênh / tài khoản / file) hoặc handler lỗi: trước đây im lặng — ghi Nhật ký để còn dấu vết
            if (result && result.success === false) {
                Logger.warn(`[proxyToBoss] ${channel} bị Boss từ chối: ${result.code || ''} ${result.error || ''}`.trim());
            }
        }).catch((err: any) => {
            Logger.warn(`[proxyToBoss] ${channel} failed: ${err.message}`);
        });
    } catch {}
}

/**
 * Proxy chờ kết quả: dùng cho thao tác người dùng thấy được (thẻ ngân hàng, ghi chú, trợ lý AI, tích hợp…) — UI nhận
 * đúng `{ success, error, code, … }` của handler trên Boss thay vì `{ success: true }` giả rồi lỗi im lặng.
 * Không phải chế độ nhân viên / chưa nối Boss / lỗi mạng → `{ success: false, error, code }` (không ném lỗi).
 */
export async function proxyToBossWithResult(channel: string, params: any, opts: { timeoutMs?: number } = {}): Promise<any> {
    try {
        const WsMgr = require('../../src/utils/WorkspaceManager').default;
        const activeWs = WsMgr.getInstance().getActiveWorkspace();
        if (!activeWs || activeWs.type !== 'remote') {
            return { success: false, error: 'Không kết nối tới Boss', code: 'NOT_CONNECTED' };
        }
        const HCM = require('../../src/services/http/HttpConnectionManager').default;
        if (!HCM.getInstance().isConnected(activeWs.id)) {
            return { success: false, error: 'Chưa kết nối tới Boss', code: 'NOT_CONNECTED' };
        }
        const result = await HCM.getInstance().proxyAction(activeWs.id, channel, params, opts.timeoutMs);
        if (!result || typeof result !== 'object') {
            return { success: false, error: 'Boss không trả kết quả', code: 'BAD_RESPONSE' };
        }
        if (result.success === false) {
            Logger.warn(`[proxyToBossWithResult] ${channel} bị Boss từ chối: ${result.code || ''} ${result.error || ''}`.trim());
        }
        return result;
    } catch (err: any) {
        Logger.warn(`[proxyToBossWithResult] ${channel} failed: ${err?.message || err}`);
        return { success: false, error: err?.message || 'Không gửi được yêu cầu tới Boss', code: 'NETWORK_ERROR' };
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
    // Cùng tiêu chí "chế độ nhân viên" với các handler (workspace đang mở là workspace từ xa) — trước đây theo
    // AppModeManager: máy Boss mở workspace nhân viên của Boss khác thì không upload, Boss kia từ chối đường dẫn.
    const WsMgr = require('../../src/utils/WorkspaceManager').default;
    const activeWs = WsMgr.getInstance().getActiveWorkspace();
    if (!activeWs || activeWs.type !== 'remote') return filePaths;

    const HCM = require('../../src/services/http/HttpConnectionManager').default;
    const client = HCM.getInstance().getServiceForWorkspace(activeWs.id);
    if (!client) throw new Error('Không kết nối tới Boss');

    const bossPaths: string[] = new Array(filePaths.length);

    // Upload parallel all files để giảm thời gian chờ (nhất là khi gửi nhiều ảnh)
    const uploadTasks = filePaths.map(async (fp, index) => {
        if (!fp) { bossPaths[index] = fp; return; }
        if (!fs.existsSync(fp)) {
            Logger.warn(`[uploadEmployeeMedia] File not found on Employee: ${fp}`);
            bossPaths[index] = fp;
            return;
        }
        const filename = path.basename(fp);
        try {
            // Đọc không chặn tiến trình main (file tới 1 GB — readFileSync làm đơ cả app trong lúc đọc)
            const buffer = await fs.promises.readFile(fp);
            const result = await client.uploadMedia(buffer, filename, zaloId);
            if (result.success && result.bossPath) {
                bossPaths[index] = result.bossPath;
                Logger.log(`[uploadEmployeeMedia] ✅ ${fp} → ${result.bossPath}`);
            } else {
                throw new Error(result.error || 'Upload thất bại');
            }
        } catch (err: any) {
            throw new Error(`Không thể upload file ${fp}: ${err.message}`);
        }
    });

    await Promise.all(uploadTasks);
    return bossPaths;
}

// ─── File trong tham số + handler Facebook / Telegram ở chế độ nhân viên ─────────────────────────────

/** Id tài khoản trong auth (buildZaloAuth: accountId; markConversationRead: zaloId) — object hoặc chuỗi JSON. */
function authAccountId(auth: any): string {
    try {
        const authObj = typeof auth === 'string' ? JSON.parse(auth) : auth;
        return String(authObj?.zaloId || authObj?.zalo_id || authObj?.accountId || '');
    } catch {
        return '';
    }
}

/**
 * Upload file cục bộ của máy nhân viên lên Boss trước khi proxy (đường dẫn máy nhân viên không có trên máy Boss), thay
 * bằng đường dẫn Boss trả về. Đúng các trường Boss kiểm tra (PROXY_FILE_PATH_FIELDS / PROXY_FILE_PATH_LIST_FIELDS của
 * proxyActionPolicy) — dùng chung zaloIpc.wrap (Zalo) và routeEmployeeChannel (Facebook / Telegram).
 * File lưu vào thư mục media của tài khoản thực hiện: `accountId` (Facebook / Telegram: params.accountId), không có thì
 * zaloId / auth (Zalo). Workspace đang mở không phải từ xa → giữ nguyên (uploadEmployeeMedia không upload).
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

/** Workspace đang mở là workspace từ xa (máy nhân viên) — cùng tiêu chí zaloIpc.wrap / uploadEmployeeMedia. */
function isRemoteWorkspaceActive(): boolean {
    try {
        const WsMgr = require('../../src/utils/WorkspaceManager').default;
        return WsMgr.getInstance().getActiveWorkspace()?.type === 'remote';
    } catch {
        return false;
    }
}

/**
 * Bọc một handler Facebook / Telegram cá nhân theo bảng employeeChannelRoutes. Máy Boss / standalone, lệnh Boss chạy hộ
 * nhân viên (`_fromRelay`) hoặc kênh "local" → handler chạy như cũ. Máy nhân viên (workspace từ xa):
 *   - proxy: upload file trong tham số lên Boss → /api/proxy/action → trả kết quả THẬT của handler trên Boss (Boss từ chối
 *     / lỗi mạng → `{ success: false, error, code }`, không ném);
 *   - boss_only: `{ success: false, error, code: 'BOSS_ONLY' }` — không chạy cục bộ (máy nhân viên không có phiên).
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
            return { success: false, error: 'Tham số không hợp lệ', code: 'BAD_REQUEST' };
        }
        let prepared: any;
        try {
            prepared = await prepareLocalFilesForProxy(params, String(params.accountId || '') || undefined);
        } catch (err: any) {
            Logger.warn(`[proxyHelper] ${channel}: upload file lên Boss lỗi: ${err?.message || err}`);
            return { success: false, error: err?.message || 'Không tải được file lên Boss', code: 'UPLOAD_FAILED' };
        }
        return proxyToBossWithResult(channel, prepared, { timeoutMs: spec.timeoutMs ?? PROXY_DEFAULT_TIMEOUT_MS });
    };
}

/**
 * `ipcMain` của facebookIpc.ts / telegramUserIpc.ts: `handle(channel, fn)` đăng ký handler đã bọc routeEmployeeChannel —
 * handler mới tự theo bảng employeeChannelRoutes (chưa phân loại → chạy như cũ; test proxyActionPolicy báo đỏ).
 */
export function employeeRoutedIpcMain(target: Pick<IpcMain, 'handle'>): Pick<IpcMain, 'handle'> {
    return {
        handle: (channel: string, listener: InvokeListener) => target.handle(channel, routeEmployeeChannel(channel, listener)),
    };
}
