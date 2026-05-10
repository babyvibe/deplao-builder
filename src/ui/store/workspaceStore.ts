import { create } from 'zustand';

// ── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceInfo {
    id: string;
    name: string;
    type: 'local' | 'remote';
    icon?: string;
    createdAt: number;

    // Local workspace
    dbPath?: string;
    relayEnabled?: boolean;
    relayPort?: number;

    // Remote workspace
    bossUrl?: string;
    token?: string;
    employeeId?: string;
    employeeName?: string;
    employeeUsername?: string;
    autoConnect?: boolean;

    // Cached employee data (populated when boss sends relay:initialState)
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

export interface WorkspaceConnectionStatus {
    connected: boolean;
    latency: number;
}

// ── Store ───────────────────────────────────────────────────────────────────

interface WorkspaceStore {
    // ─── Workspace list ─────────────────────────────────────────────
    workspaces: WorkspaceInfo[];
    activeWorkspaceId: string;
    setWorkspaces: (list: WorkspaceInfo[]) => void;
    setActiveWorkspaceId: (id: string) => void;

    // ─── Connection statuses for remote workspaces (background) ─────
    connectionStatuses: Record<string, WorkspaceConnectionStatus>;
    setConnectionStatus: (wsId: string, status: WorkspaceConnectionStatus) => void;

    // ─── Switching state ────────────────────────────────────────────
    isSwitching: boolean;
    setIsSwitching: (v: boolean) => void;

    // ─── Computed helpers ───────────────────────────────────────────
    activeWorkspace: () => WorkspaceInfo | undefined;
    isMultiWorkspace: () => boolean;
    getRemoteWorkspaces: () => WorkspaceInfo[];
    getLocalWorkspaces: () => WorkspaceInfo[];

    // ─── Unread counts per workspace (for badges) ───────────────────
    unreadCounts: Record<string, number>;
    setUnreadCount: (wsId: string, count: number) => void;
    incrementUnreadCount: (wsId: string) => void;
    clearUnreadCount: (wsId: string) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
    workspaces: [],
    activeWorkspaceId: '',
    connectionStatuses: {},
    isSwitching: false,
    unreadCounts: {},

    setWorkspaces: (list) => set({ workspaces: list }),
    setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),

    setConnectionStatus: (wsId, status) => set(state => ({
        connectionStatuses: { ...state.connectionStatuses, [wsId]: status },
    })),

    setIsSwitching: (v) => set({ isSwitching: v }),

    activeWorkspace: () => {
        const { workspaces, activeWorkspaceId } = get();
        return workspaces.find(w => w.id === activeWorkspaceId);
    },

    isMultiWorkspace: () => get().workspaces.length > 1,

    getRemoteWorkspaces: () => get().workspaces.filter(w => w.type === 'remote'),

    getLocalWorkspaces: () => get().workspaces.filter(w => w.type === 'local'),

    setUnreadCount: (wsId, count) => set(state => ({
        unreadCounts: { ...state.unreadCounts, [wsId]: count },
    })),

    incrementUnreadCount: (wsId) => set(state => ({
        unreadCounts: {
            ...state.unreadCounts,
            [wsId]: (state.unreadCounts[wsId] || 0) + 1,
        },
    })),

    clearUnreadCount: (wsId) => set(state => ({
        unreadCounts: { ...state.unreadCounts, [wsId]: 0 },
    })),
}));

