"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const electron_1 = require("electron");
const Logger_1 = __importDefault(require("./Logger"));
// ── Constants ───────────────────────────────────────────────────────────────
const CONFIG_FILENAME = 'workspaces.json';
const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_DB_NAME = 'deplao-tool.db'; // existing DB
const MAX_WORKSPACES = 5;
// ── WorkspaceManager ────────────────────────────────────────────────────────
class WorkspaceManager {
    constructor() {
        this.config = { activeWorkspaceId: DEFAULT_WORKSPACE_ID, workspaces: [] };
        this.configPath = '';
        this.userDataPath = '';
        this.initialized = false;
        /** Listeners notified when active workspace changes */
        this.switchListeners = [];
    }
    static getInstance() {
        if (!WorkspaceManager.instance) {
            WorkspaceManager.instance = new WorkspaceManager();
        }
        return WorkspaceManager.instance;
    }
    // ─── Initialization ──────────────────────────────────────────────
    /**
     * Initialize WorkspaceManager. Must be called BEFORE DatabaseService.initialize().
     * Handles first-time migration from legacy single-DB setup.
     */
    initialize() {
        if (this.initialized)
            return;
        this.userDataPath = electron_1.app.getPath('userData');
        this.configPath = path.join(this.userDataPath, CONFIG_FILENAME);
        if (fs.existsSync(this.configPath)) {
            this.loadConfig();
        }
        else {
            this.migrateFromLegacy();
        }
        // Validate: ensure active workspace exists
        const activeWs = this.config.workspaces.find(w => w.id === this.config.activeWorkspaceId);
        if (!activeWs && this.config.workspaces.length > 0) {
            this.config.activeWorkspaceId = this.config.workspaces[0].id;
            this.saveConfig();
        }
        this.initialized = true;
        Logger_1.default.log(`[WorkspaceManager] Initialized. ${this.config.workspaces.length} workspace(s), active: "${this.config.activeWorkspaceId}"`);
    }
    /**
     * First-time migration: create default workspace from existing DB.
     * Existing deplao-tool.db stays in place — the default workspace simply points to it.
     */
    migrateFromLegacy() {
        Logger_1.default.log('[WorkspaceManager] No workspaces.json found — creating default workspace from legacy DB');
        // Check for custom dbFolder config
        let dbFolder = this.userDataPath;
        const deplaoConfigPath = path.join(this.userDataPath, 'deplao-config.json');
        if (fs.existsSync(deplaoConfigPath)) {
            try {
                const cfg = JSON.parse(fs.readFileSync(deplaoConfigPath, 'utf-8'));
                if (cfg.dbFolder && fs.existsSync(cfg.dbFolder)) {
                    dbFolder = cfg.dbFolder;
                }
            }
            catch { /* ignore */ }
        }
        const legacyDbPath = path.join(dbFolder, DEFAULT_DB_NAME);
        const hasLegacyDb = fs.existsSync(legacyDbPath);
        const defaultWorkspace = {
            id: DEFAULT_WORKSPACE_ID,
            name: 'Mặc định',
            type: 'local',
            icon: '🏠',
            createdAt: Date.now(),
            dbPath: DEFAULT_DB_NAME, // relative — DatabaseService resolves it
            relayEnabled: false,
            relayPort: 9900,
        };
        this.config = {
            activeWorkspaceId: DEFAULT_WORKSPACE_ID,
            workspaces: [defaultWorkspace],
        };
        this.saveConfig();
        Logger_1.default.log(`[WorkspaceManager] Default workspace created. Legacy DB ${hasLegacyDb ? 'found' : 'not found'} at ${legacyDbPath}`);
    }
    // ─── Config persistence ──────────────────────────────────────────
    loadConfig() {
        try {
            const raw = fs.readFileSync(this.configPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed.workspaces && Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) {
                this.config = parsed;
            }
            else {
                Logger_1.default.warn('[WorkspaceManager] Invalid config, running migration');
                this.migrateFromLegacy();
            }
        }
        catch (err) {
            Logger_1.default.error(`[WorkspaceManager] Failed to load config: ${err.message}`);
            this.migrateFromLegacy();
        }
    }
    saveConfig() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
        }
        catch (err) {
            Logger_1.default.error(`[WorkspaceManager] Failed to save config: ${err.message}`);
        }
    }
    // ─── CRUD ────────────────────────────────────────────────────────
    listWorkspaces() {
        return [...this.config.workspaces];
    }
    getWorkspaceById(id) {
        return this.config.workspaces.find(w => w.id === id);
    }
    createWorkspace(params) {
        if (this.config.workspaces.length >= MAX_WORKSPACES) {
            return { success: false, error: `Tối đa ${MAX_WORKSPACES} workspace` };
        }
        // Check duplicate name
        if (this.config.workspaces.some(w => w.name === params.name)) {
            return { success: false, error: `Tên "${params.name}" đã tồn tại` };
        }
        const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const workspace = {
            id,
            name: params.name,
            type: params.type,
            icon: params.icon || (params.type === 'local' ? '🏠' : '👤'),
            createdAt: Date.now(),
        };
        // Each additional workspace lives in its own folder:
        //   workspace-{id}/deplao-tool.db + workspace-{id}/media/
        const wsFolder = `workspace-${id}`;
        const wsDbRelative = `${wsFolder}/deplao-tool.db`;
        if (params.type === 'local') {
            workspace.dbPath = wsDbRelative;
            workspace.relayEnabled = false;
            workspace.relayPort = params.relayPort || 9900;
        }
        else {
            workspace.bossUrl = params.bossUrl || '';
            workspace.token = params.token || '';
            workspace.employeeId = params.employeeId || '';
            workspace.employeeName = params.employeeName || '';
            workspace.employeeUsername = params.employeeUsername || '';
            workspace.autoConnect = params.autoConnect ?? true;
            workspace.dbPath = wsDbRelative; // Local DB for synced data
        }
        // Ensure the workspace folder exists
        const wsFolderAbs = path.join(path.dirname(this.resolveDbPath(wsDbRelative)), '');
        if (!fs.existsSync(wsFolderAbs)) {
            fs.mkdirSync(wsFolderAbs, { recursive: true });
        }
        this.config.workspaces.push(workspace);
        this.saveConfig();
        Logger_1.default.log(`[WorkspaceManager] Created workspace "${params.name}" (${params.type}) → ${id}`);
        return { success: true, workspace };
    }
    updateWorkspace(id, updates) {
        const idx = this.config.workspaces.findIndex(w => w.id === id);
        if (idx < 0)
            return { success: false, error: 'Workspace không tồn tại' };
        // Check duplicate name
        if (updates.name && this.config.workspaces.some(w => w.id !== id && w.name === updates.name)) {
            return { success: false, error: `Tên "${updates.name}" đã tồn tại` };
        }
        Object.assign(this.config.workspaces[idx], updates);
        this.saveConfig();
        return { success: true };
    }
    deleteWorkspace(id) {
        if (id === DEFAULT_WORKSPACE_ID) {
            return { success: false, error: 'Không thể xóa workspace mặc định' };
        }
        if (this.config.workspaces.length <= 1) {
            return { success: false, error: 'Phải có ít nhất 1 workspace' };
        }
        const ws = this.config.workspaces.find(w => w.id === id);
        if (!ws)
            return { success: false, error: 'Workspace không tồn tại' };
        this.config.workspaces = this.config.workspaces.filter(w => w.id !== id);
        // If deleted was active, switch to first remaining
        if (this.config.activeWorkspaceId === id) {
            this.config.activeWorkspaceId = this.config.workspaces[0].id;
        }
        this.saveConfig();
        // Delete the workspace folder (contains DB + media)
        const wsDbPath = ws.dbPath || `workspace-${id}/deplao-tool.db`;
        const fullDbPath = this.resolveDbPath(wsDbPath);
        const wsFolder = path.dirname(fullDbPath);
        const rootDbFolder = path.dirname(this.resolveDbPath(DEFAULT_DB_NAME));
        const rootDbPath = this.resolveDbPath(DEFAULT_DB_NAME);
        Logger_1.default.log(`[WorkspaceManager] Delete: fullDbPath=${fullDbPath}, wsFolder=${wsFolder}, rootDbFolder=${rootDbFolder}`);
        // SAFETY: Never delete the root deplao-tool.db (belongs to default workspace)
        if (fullDbPath === rootDbPath) {
            Logger_1.default.warn(`[WorkspaceManager] SAFETY: Refusing to delete root DB file: ${fullDbPath}`);
        }
        else {
            try {
                // Only delete if it's a workspace subfolder (not the root dbFolder)
                if (wsFolder !== rootDbFolder && fs.existsSync(wsFolder)) {
                    fs.rmSync(wsFolder, { recursive: true, force: true });
                    Logger_1.default.log(`[WorkspaceManager] Deleted workspace folder: ${wsFolder}`);
                }
                else if (fs.existsSync(fullDbPath)) {
                    fs.unlinkSync(fullDbPath);
                    Logger_1.default.log(`[WorkspaceManager] Deleted DB file: ${fullDbPath}`);
                }
            }
            catch (err) {
                Logger_1.default.warn(`[WorkspaceManager] Failed to delete workspace data: ${err.message}`);
            }
        }
        Logger_1.default.log(`[WorkspaceManager] Deleted workspace "${ws.name}" (${id})`);
        return { success: true };
    }
    // ─── Active workspace ────────────────────────────────────────────
    getActiveWorkspace() {
        const ws = this.config.workspaces.find(w => w.id === this.config.activeWorkspaceId);
        if (!ws) {
            // Fallback: return first workspace
            return this.config.workspaces[0];
        }
        return ws;
    }
    getActiveWorkspaceId() {
        return this.config.activeWorkspaceId;
    }
    switchWorkspace(id) {
        const ws = this.config.workspaces.find(w => w.id === id);
        if (!ws)
            return { success: false, error: 'Workspace không tồn tại' };
        if (this.config.activeWorkspaceId === id) {
            return { success: true, workspace: ws }; // already active
        }
        const prevId = this.config.activeWorkspaceId;
        this.config.activeWorkspaceId = id;
        this.saveConfig();
        Logger_1.default.log(`[WorkspaceManager] Switched workspace: ${prevId} → ${id} ("${ws.name}")`);
        // Notify listeners
        for (const listener of this.switchListeners) {
            try {
                listener(ws);
            }
            catch (e) {
                Logger_1.default.error(`[WorkspaceManager] Switch listener error: ${e.message}`);
            }
        }
        return { success: true, workspace: ws };
    }
    restoreActiveWorkspace(id) {
        const ws = this.config.workspaces.find(w => w.id === id);
        if (!ws)
            return { success: false, error: 'Workspace không tồn tại' };
        this.config.activeWorkspaceId = id;
        this.saveConfig();
        Logger_1.default.warn(`[WorkspaceManager] Restored active workspace to: ${id} ("${ws.name}")`);
        return { success: true, workspace: ws };
    }
    // ─── Listeners ───────────────────────────────────────────────────
    onWorkspaceSwitch(listener) {
        this.switchListeners.push(listener);
        return () => {
            this.switchListeners = this.switchListeners.filter(l => l !== listener);
        };
    }
    // ─── Helpers ─────────────────────────────────────────────────────
    /**
     * Resolve a workspace's dbPath to an absolute filesystem path.
     * Respects custom dbFolder from deplao-config.json.
     */
    resolveDbPath(relativeDbPath) {
        let dbFolder = this.userDataPath;
        const deplaoConfigPath = path.join(this.userDataPath, 'deplao-config.json');
        if (fs.existsSync(deplaoConfigPath)) {
            try {
                const cfg = JSON.parse(fs.readFileSync(deplaoConfigPath, 'utf-8'));
                if (cfg.dbFolder && fs.existsSync(cfg.dbFolder)) {
                    dbFolder = cfg.dbFolder;
                }
            }
            catch { /* ignore */ }
        }
        return path.join(dbFolder, relativeDbPath);
    }
    /** Resolve the active workspace's DB path */
    getActiveDbPath() {
        const ws = this.getActiveWorkspace();
        return this.resolveDbPath(ws.dbPath || DEFAULT_DB_NAME);
    }
    /**
     * Resolve the media folder for a workspace.
     * Default workspace: dbFolder/media/
     * Additional workspaces: dbFolder/workspace-{id}/media/
     */
    resolveMediaPath(ws) {
        const target = ws || this.getActiveWorkspace();
        const dbFullPath = this.resolveDbPath(target.dbPath || DEFAULT_DB_NAME);
        const wsDir = path.dirname(dbFullPath);
        return path.join(wsDir, 'media');
    }
    /** Get the active workspace's media folder */
    getActiveMediaPath() {
        return this.resolveMediaPath();
    }
    /** Get the workspace type → app mode mapping */
    getActiveModeType() {
        const ws = this.getActiveWorkspace();
        if (ws.type === 'remote')
            return 'employee';
        if (ws.relayEnabled)
            return 'boss';
        return 'standalone';
    }
    /** Check if the active workspace is a remote (employee) workspace */
    isActiveRemote() {
        return this.getActiveWorkspace().type === 'remote';
    }
    /** Check if multi-workspace mode is active (more than 1 workspace) */
    isMultiWorkspace() {
        return this.config.workspaces.length > 1;
    }
    /** Get list of remote workspaces that should auto-connect */
    getAutoConnectRemotes() {
        return this.config.workspaces.filter(w => w.type === 'remote' && w.autoConnect);
    }
    getUserDataPath() {
        return this.userDataPath;
    }
}
exports.default = WorkspaceManager;
//# sourceMappingURL=WorkspaceManager.js.map