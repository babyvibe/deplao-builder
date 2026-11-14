/**
 * runtime.ts: environment info for the API layer (lazy require so the module can run in tests).
 */

let cachedVersion: string | null = null;

/**
 * App version (compared with the plugin's minDeplaoVersion, /health, backup metadata…).
 * Packaged build: app.getVersion() = package.json at build time. Dev run (`electron dist-electron/electron/bootstrap.js`):
 * Electron receives the file path, so it does not read package.json → getVersion() returns the version stamped in the electron.exe of
 * node_modules (postinstall patch-electron-icon.js, only updated on npm install → usually old) → read the repo's package.json instead.
 */
export function appVersion(): string {
    if (cachedVersion) return cachedVersion;
    let app: any = null;
    try { app = require('electron').app; } catch { /* test */ }
    if (!app?.isPackaged) cachedVersion = repoPackageVersion();
    if (!cachedVersion && typeof app?.getVersion === 'function') cachedVersion = app.getVersion();
    return cachedVersion || 'dev';
}

/** The version in the nearest package.json above this file (src/… in tests, dist-electron/src/… in dev runs). */
function repoPackageVersion(): string {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
        } catch { /* not at the repo folder yet */ }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return '';
}

/** Tests only: clears the remembered version. */
export function resetAppVersionCacheForTests(): void {
    cachedVersion = null;
}

export function appMode(): 'standalone' | 'boss' | 'employee' | 'unknown' {
    try {
        const AppModeManager = require('../../utils/app/AppModeManager').default;
        return AppModeManager.getInstance().getMode();
    } catch {
        return 'unknown';
    }
}

export function activeWorkspace(): { id: string; name: string; type: string } | null {
    try {
        const WorkspaceManager = require('../../utils/app/WorkspaceManager').default;
        const ws = WorkspaceManager.getInstance().getActiveWorkspace();
        return ws ? { id: String(ws.id), name: String(ws.name || ''), type: String(ws.type || 'local') } : null;
    } catch {
        return null;
    }
}

/** The API only serves the local workspace (employee workspaces have no data on the machine). */
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
