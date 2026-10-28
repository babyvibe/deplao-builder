/**
 * Được tạo lịch hẹn / ghi chú nhanh của Quản lý công việc không: giống điều kiện hiện mục "Quản lý công việc" ở Sidebar
 * + quyền tạo tương ứng. Dùng cho nút "+" cạnh ô tìm kiếm (QuickActionsButton) và "Thêm vào lịch" / "Lưu vào ghi chú"
 * từ tin nhắn (ChatWindow).
 */
import { useEmployeeStore } from '@/store/employeeStore';
import { useFeatureVisibilityStore } from '@/store/featureVisibilityStore';
import { useErpPermissions } from './useErpContext';

export function useQuickErpAccess(): { event: boolean; note: boolean } {
  const erpVisible = useFeatureVisibilityStore(s => s.enabled.erp);
  const erpModule = useEmployeeStore(s => s.hasPermission('erp'));
  const { can } = useErpPermissions();
  const base = erpVisible && erpModule && can('erp.access');
  return { event: base && can('calendar.create_personal'), note: base && can('note.create') };
}
