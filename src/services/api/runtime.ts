/**
 * runtime.ts — thông tin môi trường cho lớp API (lazy require để module chạy được trong test).
 */

let cachedVersion: string | null = null;

/**
 * Phiên bản app (so minDeplaoVersion của plugin, /health, siêu dữ liệu bản sao lưu…).
 * Bản đóng gói: app.getVersion() = package.json lúc build. Chạy dev (`electron dist-electron/electron/bootstrap.js`):
 * Electron nhận đường dẫn file nên không đọc package.json → getVersion() trả version đóng dấu trong electron.exe của
 * node_modules (postinstall patch-electron-icon.js, chỉ cập nhật khi npm install → thường cũ) → đọc package.json của repo.
 */
export function appVersion(): string {
    if (cachedVersion) return cachedVersion;
    let app: any = null;
    try { app = require('electron').app; } catch { /* test */ }
    if (!app?.isPackaged) cachedVersion = repoPackageVersion();
    if (!cachedVersion && typeof app?.getVersion === 'function') cachedVersion = app.getVersion();
    return cachedVersion || 'dev';
}

/** version trong package.json gần nhất phía trên file này (src/… khi test, dist-electron/src/… khi chạy dev). */
function repoPackageVersion(): string {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
        } catch { /* chưa tới thư mục repo */ }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return '';
}

/** Chỉ cho test: xoá version đã nhớ. */
export function resetAppVersionCacheForTests(): void {
    cachedVersion = null;
}

export function appMode(): 'standalone' | 'boss' | 'employee' | 'unknown' {
    try {
        const AppModeManager = require('../../utils/AppModeManager').default;
        return AppModeManager.getInstance().getMode();
    } catch {
        return 'unknown';
    }
}

export function activeWorkspace(): { id: string; name: string; type: string } | null {
    try {
        const WorkspaceManager = require('../../utils/WorkspaceManager').default;
        const ws = WorkspaceManager.getInstance().getActiveWorkspace();
        return ws ? { id: String(ws.id), name: String(ws.name || ''), type: String(ws.type || 'local') } : null;
    } catch {
        return null;
    }
}

/** API chỉ phục vụ workspace local (workspace nhân viên không có dữ liệu trên máy). */
export function isWorkspaceAvailable(): boolean {
    const ws = activeWorkspace();
    return !ws || ws.type !== 'remote';
}

export function mediaBaseDir(): string {
    try {
        const FileStorageService = require('../file/FileStorageService').default;
        return FileStorageService.getBaseDir();
    } catch {
        return require('os').tmpdir();
    }
}

export const startedAt = Date.now();
