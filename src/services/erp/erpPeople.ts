import DatabaseService from '../database/DatabaseService';

/**
 * Tên người trong chữ thông báo ERP ("Giao bởi …", "Lan xin nghỉ…"): 'boss' → "Boss" (như trang Nhân sự), nhân viên →
 * tên hiển thị; không tìm thấy / lỗi DB → id. Trước đây thông báo in thẳng id nhân viên.
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
