/**
 * Phạm vi CSDL / workspace theo luồng chạy (AsyncLocalStorage).
 *
 * Một máy có workspace local (của chủ) và mở thêm workspace nhân viên (remote, vd thử tính năng nhân viên trên cùng
 * máy): mọi thứ chạy nền của workspace local (Zalo, Telegram, Facebook, workflow, API, ERP, Cloudflare, plugin…) phải
 * tiếp tục đọc / ghi CSDL + thư mục media của workspace local dù giao diện đang mở workspace nào. Trước đây đổi workspace
 * là đổi luôn CSDL dùng chung của main process: tin Telegram, sự kiện API, file tải về của chủ bị ghi vào workspace
 * nhân viên, và mở app khi đang ở workspace nhân viên thì Telegram / Facebook / workflow của chủ không chạy.
 *
 *  - CSDL chính (DatabaseService) = workspace local đang chạy ("runtime"), không bao giờ là workspace remote.
 *  - Lệnh từ giao diện (IPC, local-media://) khi giao diện đang mở workspace remote chạy trong phạm vi 'ui': dùng CSDL
 *    đệm + media của workspace remote đó như trước, và "workspace đang mở" / chế độ app = nhân viên.
 *  - withDbPath() = phạm vi 'path': một CSDL cụ thể cho đoạn code bên trong (kể cả phần async).
 */
import { AsyncLocalStorage } from 'async_hooks';

export type DbScope = { kind: 'ui' } | { kind: 'path'; dbPath: string };

/** Workspace remote đang mở trên giao diện. */
export interface UiRemoteWorkspace {
    workspaceId: string;
    dbPath: string;
    mediaDir: string;
}

const storage = new AsyncLocalStorage<DbScope>();
const UI_SCOPE: DbScope = Object.freeze({ kind: 'ui' as const });
let uiRemote: UiRemoteWorkspace | null = null;

export function currentDbScope(): DbScope | undefined {
    return storage.getStore();
}

/** Chạy `fn` (kể cả phần async bên trong) trên CSDL `dbPath`. */
export function runWithDbPath<T>(dbPath: string, fn: () => T): T {
    return storage.run({ kind: 'path', dbPath }, fn);
}

/** Chạy `fn` ngoài mọi phạm vi: CSDL / media / workspace local đang chạy. */
export function runInRuntimeScope<T>(fn: () => T): T {
    return storage.exit(fn);
}

/**
 * Lệnh từ giao diện. Giao diện đang mở workspace remote → phạm vi 'ui' (CSDL + media của workspace remote đang mở lúc
 * dùng). Giao diện đang mở workspace local → chạy thẳng, không gắn phạm vi: việc chạy nền mà lệnh khởi động (kết nối
 * tài khoản, bật bot, lưu workflow…) luôn thuộc workspace local.
 */
export function runInUiScope<T>(fn: () => T): T {
    return uiRemote ? storage.run(UI_SCOPE, fn) : fn();
}

export function setUiRemoteWorkspace(ws: UiRemoteWorkspace | null): void {
    uiRemote = ws;
}

export function getUiRemoteWorkspace(): UiRemoteWorkspace | null {
    return uiRemote;
}

/** Đoạn code đang chạy là lệnh của giao diện workspace remote đang mở. */
export function inUiRemoteScope(): boolean {
    return !!uiRemote && storage.getStore()?.kind === 'ui';
}
