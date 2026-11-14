/**
 * Can the user create a quick appointment / note / task from Task management: same condition as the "Quản lý công việc" (Task management) item in the
 * Sidebar + the matching permission. Used for the "+" button next to the search box (QuickActionsButton), "Tạo task" (Create task) / "Thêm vào lịch" (Add to calendar) / "Lưu vào ghi chú" (Save to note) from messages (ChatWindow), and the "Lịch sắp tới" (Upcoming) tab in the bell (`calendar` = can view the calendar).
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
