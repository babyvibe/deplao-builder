import DatabaseService from '../database/DatabaseService';

/**
 * Person names in ERP notification text ("Giao bởi …" (Assigned by …), "Lan xin nghỉ…" (Lan asks for leave…)): 'boss' → "Boss" (as on the HR page), an employee →
 * their display name; not found / DB error → the id. Before, notifications printed the employee id directly.
 */
export function erpPersonName(employeeId: string | null | undefined): string {
  const id = String(employeeId ?? '').trim();
  if (!id) return '';
  if (id === 'boss') return 'Boss';
  try {
    const row = DatabaseService.getInstance().queryOne<{ display_name?: string | null }>(
      `SELECT display_name FROM employees WHERE employee_id = ?`, [id],
    );
    return String(row?.display_name ?? '').trim() || id;
  } catch {
    return id;
  }
}
