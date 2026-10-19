import { isErpPermissionDeniedResponse, reportErpPermissionDenied } from '@/lib/ipc';
import { useEmployeeStore } from '@/store/employeeStore';

/**
 * Lệnh ghi ERP qua DataAccessor bị từ chối quyền (`code: 'permission_denied'` — handler IPC, hoặc Boss khi nhân viên
 * đi REST) → cùng hộp thoại "không có quyền ERP" như bộ bọc ipc.erp. Chế độ nhân viên không qua bộ bọc đó nên trước
 * đây bị từ chối là im lặng. Trả lại nguyên kết quả để người gọi đọc `success` / `error`.
 */
export function withErpDeniedNotice<T>(res: T): T {
  if (isErpPermissionDeniedResponse(res)) reportErpPermissionDenied(res);
  return res;
}

/**
 * Nhân viên chắc chắn không được bật module ERP: không gọi Boss (Boss trả 403 MODULE_FORBIDDEN cho mọi /erp/*) — dùng
 * cho phần tải nền ngoài trang ERP (chuông thông báo, chấm công hôm nay trên thanh trên cùng). Quyền module chưa nạp
 * (vừa mở app) → vẫn gọi: Boss tự từ chối nếu không có quyền, người gọi giữ giá trị đang hiện.
 */
export function isErpModuleOff(): boolean {
  try {
    const state = useEmployeeStore.getState();
    if (state.mode !== 'employee') return false;
    const loaded = state.permissions && Object.keys(state.permissions).length > 0;
    return !!loaded && !state.hasPermission('erp');
  } catch {
    return false;
  }
}
