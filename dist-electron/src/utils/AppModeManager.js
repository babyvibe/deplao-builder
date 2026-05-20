"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Logger_1 = __importDefault(require("../utils/Logger"));
const WorkspaceManager_1 = __importDefault(require("./WorkspaceManager"));
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
    constructor() {
        this.mode = 'standalone';
        this.employeeId = null;
        this.manualOverride = false; // true when setMode() was called explicitly
    }
    static getInstance() {
        if (!AppModeManager.instance) {
            AppModeManager.instance = new AppModeManager();
        }
        return AppModeManager.instance;
    }
    getMode() {
        // If mode was manually set (e.g. by connectToBoss/disconnectFromBoss), respect it
        if (this.manualOverride)
            return this.mode;
        // Otherwise delegate to WorkspaceManager for workspace-aware mode
        try {
            const wm = WorkspaceManager_1.default.getInstance();
            return wm.getActiveModeType();
        }
        catch {
            return this.mode;
        }
    }
    setMode(mode) {
        this.mode = mode;
        this.manualOverride = true;
        Logger_1.default.log(`[AppModeManager] Mode set to: ${mode} (manual override)`);
    }
    /** Reset manual override — mode will be derived from active workspace */
    clearOverride() {
        this.manualOverride = false;
        Logger_1.default.log(`[AppModeManager] Manual override cleared — mode derived from workspace`);
    }
    isEmployeeMode() {
        return this.getMode() === 'employee';
    }
    isBossMode() {
        return this.getMode() === 'boss';
    }
    isStandalone() {
        return this.getMode() === 'standalone';
    }
    getEmployeeId() {
        return this.employeeId;
    }
    setEmployeeId(id) {
        this.employeeId = id;
    }
}
exports.default = AppModeManager;
//# sourceMappingURL=AppModeManager.js.map