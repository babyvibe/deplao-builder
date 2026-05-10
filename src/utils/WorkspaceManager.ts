import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import Logger from './Logger';

// ── Types ───────────────────────────────────────────────────────────────────

export interface Workspace {
    id: string;
    name: string;
    type: 'local' | 'remote';
    icon?: string;           // emoji or avatar URL
    createdAt: number;

    // Local workspace (boss/standalone)
    dbPath?: string;          // relative to userData, e.g. "workspace-ws001.db"
    relayEnabled?: boolean;
    relayPort?: number;
    relayAutoStart?: boolean;   // auto-start relay server on app launch

    // Remote workspace (employee)
    bossUrl?: string;         // http://192.168.1.100:9900
    token?: string;           // JWT token from boss
    employeeId?: string;
    employeeName?: string;
    employeeUsername?: string; // login username (for auto re-login)
    autoConnect?: boolean;    // auto-connect on app start

    // Cached employee data (so UI works while offline / before boss sends initialState)
    cachedPermissions?: Array<{ module: string; can_access: boolean }>;
    cachedAssignedAccounts?: string[];
    cachedErpRole?: string;
    cachedErpExtraJson?: string;
    cachedEmployeesData?: Array<{
        employee_id: string;
        username: string;
        display_name: string;
        avatar_url?: string;
        role?: string;
        is_active?: number;
        permissions?: Array<{ module: string; can_access: boolean }>;
        assigned_accounts?: string[];
    }>;
    cachedAccountsData?: Array<{
        zalo_id: string;
        full_name: string;
        avatar_url: string;
        phone?: string;
        is_business?: number;
        is_active?: number;
        listener_active?: number;
    }>;
}

interface WorkspaceConfig {
    activeWorkspaceId: string;
    workspaces: Workspace[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const CONFIG_FILENAME = 'workspaces.json';
const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_DB_NAME = 'deplao-tool.db';           // existing DB
const MAX_WORKSPACES = 5;

// ── WorkspaceManager ────────────────────────────────────────────────────────

class WorkspaceManager {
    private static instance: WorkspaceManager;
    private config: WorkspaceConfig = { activeWorkspaceId: DEFAULT_WORKSPACE_ID, workspaces: [] };
    private configPath: string = '';
    private userDataPath: string = '';
    private initialized = false;

    /** Listeners notified when active workspace changes */
    private switchListeners: Array<(workspace: Workspace) => void> = [];

    public static getInstance(): WorkspaceManager {
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
    public initialize(): void {
        if (this.initialized) return;

        this.userDataPath = app.getPath('userData');
        this.configPath = path.join(this.userDataPath, CONFIG_FILENAME);

        if (fs.existsSync(this.configPath)) {
            this.loadConfig();
        } else {
            this.migrateFromLegacy();
        }

        // Validate: ensure active workspace exists
        const activeWs = this.config.workspaces.find(w => w.id === this.config.activeWorkspaceId);
        if (!activeWs && this.config.workspaces.length > 0) {
            this.config.activeWorkspaceId = this.config.workspaces[0].id;
            this.saveConfig();
        }

        this.initialized = true;
        Logger.log(`[WorkspaceManager] Initialized. ${this.config.workspaces.length} workspace(s), active: "${this.config.activeWorkspaceId}"`);
    }

    /**
     * First-time migration: create default workspace from existing DB.
     * Existing deplao-tool.db stays in place — the default workspace simply points to it.
     */
    private migrateFromLegacy(): void {
        Logger.log('[WorkspaceManager] No workspaces.json found — creating default workspace from legacy DB');

        // Check for custom dbFolder config
        let dbFolder = this.userDataPath;
        const deplaoConfigPath = path.join(this.userDataPath, 'deplao-config.json');
        if (fs.existsSync(deplaoConfigPath)) {
            try {
                const cfg = JSON.parse(fs.readFileSync(deplaoConfigPath, 'utf-8'));
                if (cfg.dbFolder && fs.existsSync(cfg.dbFolder)) {
                    dbFolder = cfg.dbFolder;
                }
            } catch { /* ignore */ }
        }

        const legacyDbPath = path.join(dbFolder, DEFAULT_DB_NAME);
        const hasLegacyDb = fs.existsSync(legacyDbPath);

        const defaultWorkspace: Workspace = {
            id: DEFAULT_WORKSPACE_ID,
            name: 'Mặc định',
            type: 'local',
            icon: '🏠',
            createdAt: Date.now(),
            dbPath: DEFAULT_DB_NAME,       // relative — DatabaseService resolves it
            relayEnabled: false,
            relayPort: 9900,
        };

        this.config = {
            activeWorkspaceId: DEFAULT_WORKSPACE_ID,
            workspaces: [defaultWorkspace],
        };

        this.saveConfig();
        Logger.log(`[WorkspaceManager] Default workspace created. Legacy DB ${hasLegacyDb ? 'found' : 'not found'} at ${legacyDbPath}`);
    }

    // ─── Config persistence ──────────────────────────────────────────

    private loadConfig(): void {
        try {
            const raw = fs.readFileSync(this.configPath, 'utf-8');
            const parsed = JSON.parse(raw) as WorkspaceConfig;
            if (parsed.workspaces && Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) {
                this.config = parsed;
            } else {
                Logger.warn('[WorkspaceManager] Invalid config, running migration');
                this.migrateFromLegacy();
            }
        } catch (err: any) {
            Logger.error(`[WorkspaceManager] Failed to load config: ${err.message}`);
            this.migrateFromLegacy();
        }
    }

    private saveConfig(): void {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
        } catch (err: any) {
            Logger.error(`[WorkspaceManager] Failed to save config: ${err.message}`);
        }
    }

    // ─── CRUD ────────────────────────────────────────────────────────

    public listWorkspaces(): Workspace[] {
        return [...this.config.workspaces];
    }

    public getWorkspaceById(id: string): Workspace | undefined {
        return this.config.workspaces.find(w => w.id === id);
    }

    public createWorkspace(params: {
        name: string;
        type: 'local' | 'remote';
        icon?: string;
        bossUrl?: string;
        token?: string;
        employeeId?: string;
        employeeName?: string;
        employeeUsername?: string;
        autoConnect?: boolean;
        relayPort?: number;
    }): { success: boolean; workspace?: Workspace; error?: string } {
        if (this.config.workspaces.length >= MAX_WORKSPACES) {
            return { success: false, error: `Tối đa ${MAX_WORKSPACES} workspace` };
        }

        // Check duplicate name
        if (this.config.workspaces.some(w => w.name === params.name)) {
            return { success: false, error: `Tên "${params.name}" đã tồn tại` };
        }

        const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const workspace: Workspace = {
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
        } else {
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

        Logger.log(`[WorkspaceManager] Created workspace "${params.name}" (${params.type}) → ${id}`);
        return { success: true, workspace };
    }

    public updateWorkspace(id: string, updates: Partial<Omit<Workspace, 'id' | 'createdAt'>>): { success: boolean; error?: string } {
        const idx = this.config.workspaces.findIndex(w => w.id === id);
        if (idx < 0) return { success: false, error: 'Workspace không tồn tại' };

        // Check duplicate name
        if (updates.name && this.config.workspaces.some(w => w.id !== id && w.name === updates.name)) {
            return { success: false, error: `Tên "${updates.name}" đã tồn tại` };
        }

        Object.assign(this.config.workspaces[idx], updates);
        this.saveConfig();
        return { success: true };
    }

    public deleteWorkspace(id: string): { success: boolean; error?: string } {
        if (id === DEFAULT_WORKSPACE_ID) {
            return { success: false, error: 'Không thể xóa workspace mặc định' };
        }
        if (this.config.workspaces.length <= 1) {
            return { success: false, error: 'Phải có ít nhất 1 workspace' };
        }

        const ws = this.config.workspaces.find(w => w.id === id);
        if (!ws) return { success: false, error: 'Workspace không tồn tại' };

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

        Logger.log(`[WorkspaceManager] Delete: fullDbPath=${fullDbPath}, wsFolder=${wsFolder}, rootDbFolder=${rootDbFolder}`);

        // SAFETY: Never delete the root deplao-tool.db (belongs to default workspace)
        if (fullDbPath === rootDbPath) {
            Logger.warn(`[WorkspaceManager] SAFETY: Refusing to delete root DB file: ${fullDbPath}`);
        } else {
            try {
                // Only delete if it's a workspace subfolder (not the root dbFolder)
                if (wsFolder !== rootDbFolder && fs.existsSync(wsFolder)) {
                    fs.rmSync(wsFolder, { recursive: true, force: true });
                    Logger.log(`[WorkspaceManager] Deleted workspace folder: ${wsFolder}`);
                } else if (fs.existsSync(fullDbPath)) {
                    fs.unlinkSync(fullDbPath);
                    Logger.log(`[WorkspaceManager] Deleted DB file: ${fullDbPath}`);
                }
            } catch (err: any) {
                Logger.warn(`[WorkspaceManager] Failed to delete workspace data: ${err.message}`);
            }
        }

        Logger.log(`[WorkspaceManager] Deleted workspace "${ws.name}" (${id})`);
        return { success: true };
    }

    // ─── Active workspace ────────────────────────────────────────────

    public getActiveWorkspace(): Workspace {
        const ws = this.config.workspaces.find(w => w.id === this.config.activeWorkspaceId);
        if (!ws) {
            // Fallback: return first workspace
            return this.config.workspaces[0];
        }
        return ws;
    }

    public getActiveWorkspaceId(): string {
        return this.config.activeWorkspaceId;
    }

    public switchWorkspace(id: string): { success: boolean; workspace?: Workspace; error?: string } {
        const ws = this.config.workspaces.find(w => w.id === id);
        if (!ws) return { success: false, error: 'Workspace không tồn tại' };

        if (this.config.activeWorkspaceId === id) {
            return { success: true, workspace: ws }; // already active
        }

        const prevId = this.config.activeWorkspaceId;
        this.config.activeWorkspaceId = id;
        this.saveConfig();

        Logger.log(`[WorkspaceManager] Switched workspace: ${prevId} → ${id} ("${ws.name}")`);

        // Notify listeners
        for (const listener of this.switchListeners) {
            try { listener(ws); } catch (e: any) {
                Logger.error(`[WorkspaceManager] Switch listener error: ${e.message}`);
            }
        }

        return { success: true, workspace: ws };
    }

    public restoreActiveWorkspace(id: string): { success: boolean; workspace?: Workspace; error?: string } {
        const ws = this.config.workspaces.find(w => w.id === id);
        if (!ws) return { success: false, error: 'Workspace không tồn tại' };

        this.config.activeWorkspaceId = id;
        this.saveConfig();
        Logger.warn(`[WorkspaceManager] Restored active workspace to: ${id} ("${ws.name}")`);
        return { success: true, workspace: ws };
    }

    // ─── Listeners ───────────────────────────────────────────────────

    public onWorkspaceSwitch(listener: (workspace: Workspace) => void): () => void {
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
    public resolveDbPath(relativeDbPath: string): string {
        let dbFolder = this.userDataPath;
        const deplaoConfigPath = path.join(this.userDataPath, 'deplao-config.json');
        if (fs.existsSync(deplaoConfigPath)) {
            try {
                const cfg = JSON.parse(fs.readFileSync(deplaoConfigPath, 'utf-8'));
                if (cfg.dbFolder && fs.existsSync(cfg.dbFolder)) {
                    dbFolder = cfg.dbFolder;
                }
            } catch { /* ignore */ }
        }
        return path.join(dbFolder, relativeDbPath);
    }

    /** Resolve the active workspace's DB path */
    public getActiveDbPath(): string {
        const ws = this.getActiveWorkspace();
        return this.resolveDbPath(ws.dbPath || DEFAULT_DB_NAME);
    }

    /**
     * Resolve the media folder for a workspace.
     * Default workspace: dbFolder/media/
     * Additional workspaces: dbFolder/workspace-{id}/media/
     */
    public resolveMediaPath(ws?: Workspace): string {
        const target = ws || this.getActiveWorkspace();
        const dbFullPath = this.resolveDbPath(target.dbPath || DEFAULT_DB_NAME);
        const wsDir = path.dirname(dbFullPath);
        return path.join(wsDir, 'media');
    }

    /** Get the active workspace's media folder */
    public getActiveMediaPath(): string {
        return this.resolveMediaPath();
    }

    /** Get the workspace type → app mode mapping */
    public getActiveModeType(): 'standalone' | 'boss' | 'employee' {
        const ws = this.getActiveWorkspace();
        if (ws.type === 'remote') return 'employee';
        if (ws.relayEnabled) return 'boss';
        return 'standalone';
    }

    /** Check if the active workspace is a remote (employee) workspace */
    public isActiveRemote(): boolean {
        return this.getActiveWorkspace().type === 'remote';
    }

    /** Check if multi-workspace mode is active (more than 1 workspace) */
    public isMultiWorkspace(): boolean {
        return this.config.workspaces.length > 1;
    }

    /** Get list of remote workspaces that should auto-connect */
    public getAutoConnectRemotes(): Workspace[] {
        return this.config.workspaces.filter(w => w.type === 'remote' && w.autoConnect);
    }

    public getUserDataPath(): string {
        return this.userDataPath;
    }
}

export default WorkspaceManager;

