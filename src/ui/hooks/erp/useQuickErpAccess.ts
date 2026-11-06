/**
 * Được tạo lịch hẹn / ghi chú / task nhanh của Quản lý công việc không: giống điều kiện hiện mục "Quản lý công việc" ở
 * Sidebar + quyền tương ứng. Dùng cho nút "+" cạnh ô tìm kiếm (QuickActionsButton), "Tạo task" / "Thêm vào lịch" / "Lưu
 * vào ghi chú" từ tin nhắn (ChatWindow) và tab "Lịch sắp tới" trong chuông thông báo (`calendar` = được xem lịch).
 */
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { useFeatureVisibilityStore } from '@/store/app/featureVisibilityStore';
import { useErpPermissions } from './useErpContext';

export function useQuickErpAccess(): { event: boolean; note: boolean; task: boolean; calendar: boolean } {
  const erpVisible = useFeatureVisibilityStore(s => s.enabled.erp);
  const erpModule = useEmployeeStore(s => s.hasPermission('erp'));
  const { can } = useErpPermissions();
  const base = erpVisible && erpModule && can('erp.access');
  return {
    event: base && can('calendar.create_personal'),
    note: base && can('note.create'),
    task: base && can('task.create'),
    calendar: base && can('calendar.view'),
  };
}
