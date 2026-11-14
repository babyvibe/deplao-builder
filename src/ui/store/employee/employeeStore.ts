import { create } from 'zustand';
import ipc from '@/lib/ipc';
import { useWorkspaceStore } from '../app/workspaceStore';
import { computeEmployeeBadgeState, type EmployeeBadgeState } from '../../../shared/employee/employeeConnection';

export type { EmployeeBadgeState };

export type AppMode = 'standalone' | 'boss' | 'employee';

export interface EmployeeInfo {
    employee_id: string;
    username: string;
    display_name: string;
    avatar_url: string;
    role: 'boss' | 'employee';
    is_active: number;
    permissions: Array<{ module: string; can_access: boolean }>;
    assigned_accounts: string[];
}

export interface ConnectedEmployee {
    employee_id: string;
    display_name: string;
    avatar_url: string;
    ip_address: string;
    connected_at: number;
    latency?: number;
}

interface EmployeeStore {
    // ─── Mode ──────────────────────────────────────────────────────
    mode: AppMode;
    setMode: (mode: AppMode) => void;

    // ─── Current employee info (when mode === 'employee') ─────────
    currentEmployee: EmployeeInfo | null;
    setCurrentEmployee: (emp: EmployeeInfo | null) => void;

    // ─── Permissions (shortcut) ───────────────────────────────────
    permissions: Record<string, boolean>;
    setPermissions: (perms: Record<string, boolean>) => void;
    hasPermission: (module: string) => boolean;

    // ─── Assigned accounts (when mode === 'employee') ─────────────
    assignedAccounts: string[];
    setAssignedAccounts: (ids: string[]) => void;

    // ─── Connection status (when mode === 'employee') ─────────────
    // Two sources: the main heartbeat ('workspace:connectionStatus') + the renderer's REST client
    // (RestQueryService status listener). Badge = combined, see computeEmployeeBadgeState.
    /** Overall online (= connectionBadge === 'online'): heartbeat OK && REST not blocked && session still valid. */
    bossConnected: boolean;
    /** TopBar badge: online | recovering (REST is recovering) | offline | expired (needs login again). */
    connectionBadge: EmployeeBadgeState;
    /** Heartbeat main → owner's machine OK (only written from the main process state). */
    heartbeatConnected: boolean;
    /** REST client is blocked / has no URL-token yet (only written by RestQueryService). */
    restBlocked: boolean;
    /** The owner's machine rejected the token → must log in again. */
    authExpired: boolean;
    setHeartbeatConnected: (v: boolean) => void;
    setRestBlocked: (v: boolean) => void;
    setAuthExpired: (v: boolean) => void;
    /** @deprecated Use setHeartbeatConnected: kept for compatibility, only writes the heartbeat part. */
    setBossConnected: (v: boolean) => void;
    bossUrl: string;
    setBossUrl: (url: string) => void;
    latency: number;
    setLatency: (ms: number) => void;

    // ─── Auth token ────────────────────────────────────────────────
    token: string;
    setToken: (token: string) => void;

    // ─── Relay server status (when mode === 'boss') ───────────────
    relayRunning: boolean;
    setRelayRunning: (v: boolean) => void;
    relayPort: number;
    setRelayPort: (port: number) => void;
    connectedEmployees: ConnectedEmployee[];
    setConnectedEmployees: (list: ConnectedEmployee[]) => void;

    // ─── Employee list (boss manages) ────────────────────────────
    employees: any[];
    setEmployees: (list: any[]) => void;
    loadEmployees: () => Promise<any[]>;

    // ─── Employee name cache (from relay events) ─────────────────
    employeeNameMap: Record<string, string>;
    employeeAvatarMap: Record<string, string>;
    cacheEmployeeName: (employeeId: string, name: string, avatarUrl?: string) => void;

    // ─── Preview mode (boss previewing as employee) ──────────────
    previewEmployeeId: string | null;
    setPreviewEmployeeId: (id: string | null) => void;

    // ─── Computed helpers for preview/simulation ─────────────────
    /** Returns true if boss is simulating employee view (previewEmployeeId set) */
    isSimulating: () => boolean;
    /** Returns assigned account zaloIds for preview employee (or null if not simulating) */
    getPreviewAssignedAccounts: () => string[] | null;
    /** Returns the previewed employee object (or null) */
    getPreviewEmployee: () => any | null;

    // ─── Reset ────────────────────────────────────────────────────
    reset: () => void;
}

type ConnectionParts = { heartbeatConnected: boolean; restBlocked: boolean; authExpired: boolean };

/** Derived fields (bossConnected, connectionBadge) computed from the 3 state sources. */
function deriveConnection(parts: ConnectionParts): { bossConnected: boolean; connectionBadge: EmployeeBadgeState } {
    const connectionBadge = computeEmployeeBadgeState({
        heartbeatOk: parts.heartbeatConnected,
        restBlocked: parts.restBlocked,
        authExpired: parts.authExpired,
    });
    return { connectionBadge, bossConnected: connectionBadge === 'online' };
}

const initialState = {
    mode: 'standalone' as AppMode,
    currentEmployee: null as EmployeeInfo | null,
    permissions: {} as Record<string, boolean>,
    assignedAccounts: [] as string[],
    bossConnected: false,
    connectionBadge: 'offline' as EmployeeBadgeState,
    heartbeatConnected: false,
    restBlocked: false,
    authExpired: false,
    bossUrl: '',
    latency: 0,
    token: '',
    relayRunning: false,
    relayPort: 9900,
    connectedEmployees: [] as ConnectedEmployee[],
    employees: [] as any[],
    employeeNameMap: {} as Record<string, string>,
    employeeAvatarMap: {} as Record<string, string>,
    previewEmployeeId: null as string | null,
};

export const useEmployeeStore = create<EmployeeStore>((set, get) => ({
    ...initialState,

    setMode: (mode) => set({ mode }),
    setCurrentEmployee: (emp) => set({ currentEmployee: emp }),
    setPermissions: (perms) => set({ permissions: perms }),
    hasPermission: (module) => {
        const { mode, permissions, previewEmployeeId, employees } = get();
        if (module === 'dashboard') return true; // dashboard always accessible
        // Boss preview mode: use previewed employee's permissions
        if (mode !== 'employee' && previewEmployeeId) {
            const emp = employees.find((e: any) => e.employee_id === previewEmployeeId);
            if (emp?.permissions) {
                const perm = emp.permissions.find((p: any) => p.module === module);
                return perm ? !!perm.can_access : false;
            }
            return false;
        }
        if (mode !== 'employee') return true; // boss/standalone = full access
        return !!permissions[module];
    },
    setAssignedAccounts: (ids) => set({ assignedAccounts: ids }),
    setHeartbeatConnected: (v) => set((s) => (
        s.heartbeatConnected === v ? s : { heartbeatConnected: v, ...deriveConnection({ ...s, heartbeatConnected: v }) }
    )),
    setRestBlocked: (v) => set((s) => (
        s.restBlocked === v ? s : { restBlocked: v, ...deriveConnection({ ...s, restBlocked: v }) }
    )),
    setAuthExpired: (v) => set((s) => (
        s.authExpired === v ? s : { authExpired: v, ...deriveConnection({ ...s, authExpired: v }) }
    )),
    setBossConnected: (v) => get().setHeartbeatConnected(v),
    setBossUrl: (url) => set({ bossUrl: url }),
    setLatency: (ms) => set({ latency: ms }),
    setToken: (token) => set({ token }),
    setRelayRunning: (v) => set({ relayRunning: v }),
    setRelayPort: (port) => set({ relayPort: port }),
    setConnectedEmployees: (list) => set({ connectedEmployees: list }),
    setEmployees: (list) => set({ employees: list }),
    loadEmployees: async () => {
        if (get().mode === 'employee') {
            const activeWorkspace = useWorkspaceStore.getState().activeWorkspace();
            const cachedEmployees = activeWorkspace?.cachedEmployeesData || [];
            if (cachedEmployees.length > 0) {
                set({ employees: cachedEmployees });
                return cachedEmployees;
            }

            // ERP profiles on the owner's machine (REST via DataAccessor): previously an IPC on the employee machine (local DB, usually empty).
            // Dynamic import: DataAccessor imports this store. Read error → keep the current list
            const { default: DataAccessor } = await import('@/lib/data/DataAccessor');
            const profileRes: any = await DataAccessor.erpProfiles();
            if (!profileRes?.success) return get().employees;
            const currentEmployee = get().currentEmployee;
            const fallbackEmployees = (profileRes.profiles || []).map((profile: any) => {
                const isMe = profile.employee_id === currentEmployee?.employee_id;
                return {
                    employee_id: profile.employee_id,
                    username: isMe ? currentEmployee?.username || '' : profile.username || '',
                    display_name: isMe
                        ? currentEmployee?.display_name || profile.employee_id
                        : profile.display_name || profile.employee_id,
                    avatar_url: isMe ? currentEmployee?.avatar_url || '' : profile.avatar_url || '',
                    role: isMe ? currentEmployee?.role || 'employee' : 'employee',
                    is_active: 1,
                    permissions: [],
                    assigned_accounts: [],
                };
            });
            set({ employees: fallbackEmployees });
            return fallbackEmployees;
        }

        const res = await ipc.employee?.list?.();
        const employees = res?.success ? (res.employees || []) : [];
        set({ employees });
        return employees;
    },
    cacheEmployeeName: (employeeId, name, avatarUrl) => set((s) => ({
        employeeNameMap: { ...s.employeeNameMap, [employeeId]: name },
        ...(avatarUrl ? { employeeAvatarMap: { ...s.employeeAvatarMap, [employeeId]: avatarUrl } } : {}),
    })),
    setPreviewEmployeeId: (id) => set({ previewEmployeeId: id }),
    // restBlocked reflects RestQueryService (a singleton shared by all workspaces) → reset does not clear it,
    // it is only written by the REST status listener.
    reset: () => set((s) => {
        const parts: ConnectionParts = {
            heartbeatConnected: initialState.heartbeatConnected,
            restBlocked: s.restBlocked,
            authExpired: initialState.authExpired,
        };
        return { ...initialState, ...parts, ...deriveConnection(parts) };
    }),

    // ─── Computed helpers for preview/simulation ─────────────────
    isSimulating: () => {
        const { mode, previewEmployeeId } = get();
        return mode !== 'employee' && !!previewEmployeeId;
    },
    getPreviewAssignedAccounts: () => {
        const { previewEmployeeId, employees } = get();
        if (!previewEmployeeId) return null;
        const emp = employees.find((e: any) => e.employee_id === previewEmployeeId);
        return emp ? emp.assigned_accounts : null;
    },
    getPreviewEmployee: () => {
        const { previewEmployeeId, employees } = get();
        if (!previewEmployeeId) return null;
        return employees.find((e: any) => e.employee_id === previewEmployeeId) || null;
    },
}));

