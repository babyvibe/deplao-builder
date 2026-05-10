import { useMemo } from 'react';
import { useAccountStore, AccountInfo } from '../store/accountStore';
import { useEmployeeStore } from '../store/employeeStore';

/**
 * Returns accounts filtered by employee simulation mode.
 * - If boss is simulating an employee, only returns accounts assigned to that employee.
 * - If in real employee mode, only returns assignedAccounts.
 * - Otherwise returns all accounts.
 */
export function useVisibleAccounts(): AccountInfo[] {
    const accounts = useAccountStore(s => s.accounts);
    const mode = useEmployeeStore(s => s.mode);
    const previewEmployeeId = useEmployeeStore(s => s.previewEmployeeId);
    const employees = useEmployeeStore(s => s.employees);
    const assignedAccounts = useEmployeeStore(s => s.assignedAccounts);

    return useMemo(() => {
        // Boss simulation mode — filter to previewed employee's assigned accounts
        if (mode !== 'employee' && previewEmployeeId) {
            const emp = employees.find((e: any) => e.employee_id === previewEmployeeId);
            const assigned = emp?.assigned_accounts as string[] | undefined;
            if (assigned && assigned.length > 0) {
                return accounts.filter(a => assigned.includes(a.zalo_id));
            }
            return []; // employee has no accounts assigned
        }

        // Real employee mode — always restrict to assigned accounts only
        if (mode === 'employee') {
            if (assignedAccounts.length === 0) return [];
            return accounts.filter(a => assignedAccounts.includes(a.zalo_id));
        }

        // Standalone / boss (no simulation) — show all
        return accounts;
    }, [accounts, mode, previewEmployeeId, employees, assignedAccounts]);
}

