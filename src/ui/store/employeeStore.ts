import { create } from 'zustand';
import ipc from '@/lib/ipc';
import { useWorkspaceStore } from './workspaceStore';

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
    bossConnected: boolean;
    setBossConnected: (v: boolean) => void;
    bossUrl: string;
    setBossUrl: (url: string) => void;
    latency: number;
    setLatency: (ms: number) => void;

    // ─── Relay server status (when mode === 'boss') ───────────────
    relayRunning: boolean;
    setRelayRunning: (v: boolean) => void;
    relayPort: number;
    setRelayPort: (port: number) => void;
    connectedEmployees: ConnectedEmployee[];
    setConnectedEmployees: (list: ConnectedEmployee[]) => void;

    // ─── Sync ─────────────────────────────────────────────────────
    syncProgress: { phase: string; percent: number } | null;
    setSyncProgress: (p: { phase: string; percent: number } | null) => void;
    lastSyncTime: number | null;
    setLastSyncTime: (ts: number | null) => void;

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

const initialState = {
    mode: 'standalone' as AppMode,
    currentEmployee: null as EmployeeInfo | null,
    permissions: {} as Record<string, boolean>,
    assignedAccounts: [] as string[],
    bossConnected: false,
    bossUrl: '',
    latency: 0,
    relayRunning: false,
    relayPort: 9900,
    connectedEmployees: [] as ConnectedEmployee[],
    syncProgress: null as { phase: string; percent: number } | null,
    lastSyncTime: null as number | null,
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
    setBossConnected: (v) => set({ bossConnected: v }),
    setBossUrl: (url) => set({ bossUrl: url }),
    setLatency: (ms) => set({ latency: ms }),
    setRelayRunning: (v) => set({ relayRunning: v }),
    setRelayPort: (port) => set({ relayPort: port }),
    setConnectedEmployees: (list) => set({ connectedEmployees: list }),
    setSyncProgress: (p) => set({ syncProgress: p }),
    setLastSyncTime: (ts) => set({ lastSyncTime: ts }),
    setEmployees: (list) => set({ employees: list }),
    loadEmployees: async () => {
        if (get().mode === 'employee') {
            const activeWorkspace = useWorkspaceStore.getState().activeWorkspace();
            const cachedEmployees = activeWorkspace?.cachedEmployeesData || [];
            if (cachedEmployees.length > 0) {
                set({ employees: cachedEmployees });
                return cachedEmployees;
            }

            const profileRes = await ipc.erp?.employeeListByDepartment?.({});
            const currentEmployee = get().currentEmployee;
            const fallbackEmployees = profileRes?.success
                ? (profileRes.profiles || []).map((profile: any) => ({
                    employee_id: profile.employee_id,
                    username: profile.employee_id === currentEmployee?.employee_id ? currentEmployee?.username || '' : '',
                    display_name: profile.employee_id === currentEmployee?.employee_id
                        ? currentEmployee?.display_name || profile.employee_id
                        : profile.employee_id,
                    avatar_url: profile.employee_id === currentEmployee?.employee_id ? currentEmployee?.avatar_url || '' : '',
                    role: profile.employee_id === currentEmployee?.employee_id ? currentEmployee?.role || 'employee' : 'employee',
                    is_active: 1,
                    permissions: [],
                    assigned_accounts: [],
                  }))
                : [];
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
    reset: () => set(initialState),

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

