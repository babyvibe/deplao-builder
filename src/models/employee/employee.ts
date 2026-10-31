export const ALL_MODULES = ['chat', 'friends', 'crm', 'workflow', 'integration', 'analytics', 'ai_assistant', 'settings'] as const;
export type EmployeeModule = typeof ALL_MODULES[number];

export interface Employee {
    id?: number;
    employee_id: string;
    username: string;
    password_hash: string;
    display_name: string;
    avatar_url: string;
    role: 'boss' | 'employee';
    is_active: number;
    group_id: string | null;
    created_at: number;
    updated_at: number;
    last_login: number | null;
}

export interface EmployeePermission {
    module: EmployeeModule;
    can_access: boolean;
}

export interface EmployeeWithDetails extends Employee {
    permissions: EmployeePermission[];
    assigned_accounts: string[];
}

export interface EmployeeGroup {
    id?: number;
    group_id: string;
    name: string;
    color: string;
    sort_order: number;
    created_at: number;
}

export interface EmployeeSession {
    id?: number;
    employee_id: string;
    machine_name: string;
    ip_address: string;
    connected_at: number;
    disconnected_at: number | null;
}

export interface EmployeeMessageLog {
    id?: number;
    employee_id: string;
    zalo_id: string;
    thread_id: string;
    thread_type: number;
    msg_id?: string;
    action: string;
    metadata: string;
    timestamp: number;
}
