import Logger from '../utils/Logger';
import WorkspaceManager from './WorkspaceManager';

export type AppMode = 'standalone' | 'boss' | 'employee';

/**
 * AppModeManager — Tracks which mode the app is running in.
 * Singleton, runs in main process.
 *
 * - standalone: Default mode, app works as before
 * - boss: Employee feature enabled, Zalo connections + relay server
 * - employee: Connected to Boss, no direct Zalo connections
 *
 * With Multi-Workspace support, mode is resolved from the active workspace.
 * Manual setMode() still works for backward compatibility and runtime overrides.
 */
class AppModeManager {
    private static instance: AppModeManager;
    private mode: AppMode = 'standalone';
    private employeeId: string | null = null;
    private manualOverride = false; // true when setMode() was called explicitly

    public static getInstance(): AppModeManager {
        if (!AppModeManager.instance) {
            AppModeManager.instance = new AppModeManager();
        }
        return AppModeManager.instance;
    }

    public getMode(): AppMode {
        // If mode was manually set (e.g. by connectToBoss/disconnectFromBoss), respect it
        if (this.manualOverride) return this.mode;

        // Otherwise delegate to WorkspaceManager for workspace-aware mode
        try {
            const wm = WorkspaceManager.getInstance();
            return wm.getActiveModeType();
        } catch {
            return this.mode;
        }
    }

    public setMode(mode: AppMode): void {
        this.mode = mode;
        this.manualOverride = true;
        Logger.log(`[AppModeManager] Mode set to: ${mode} (manual override)`);
    }

    /** Reset manual override — mode will be derived from active workspace */
    public clearOverride(): void {
        this.manualOverride = false;
        Logger.log(`[AppModeManager] Manual override cleared — mode derived from workspace`);
    }

    public isEmployeeMode(): boolean {
        return this.getMode() === 'employee';
    }

    public isBossMode(): boolean {
        return this.getMode() === 'boss';
    }

    public isStandalone(): boolean {
        return this.getMode() === 'standalone';
    }

    public getEmployeeId(): string | null {
        return this.employeeId;
    }

    public setEmployeeId(id: string | null): void {
        this.employeeId = id;
    }
}

export default AppModeManager;

