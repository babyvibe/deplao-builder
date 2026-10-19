/**
 * runtime.ts — thông tin môi trường cho lớp API (lazy require để module chạy được trong test).
 */

let cachedVersion: string | null = null;

export function appVersion(): string {
    if (cachedVersion) return cachedVersion;
    try {
        const { app } = require('electron');
        if (app?.getVersion) cachedVersion = app.getVersion();
    } catch { /* test */ }
    if (!cachedVersion) {
        try { cachedVersion = require('../../../package.json').version; } catch { /* ignore */ }
    }
    return cachedVersion || 'dev';
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
