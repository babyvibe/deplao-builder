/**
 * Avatar of the employee who sent the message (employee mode, messages with handled_by_employee) next to your own message.
 */
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { EmployeeAvatar } from '../../messages/ChatWindowBubbles';
import type { RowLocals } from './rowContext';

type HandledByEmployeeAvatarProps = Pick<RowLocals, 'msg'>;

export function HandledByEmployeeAvatar({ msg }: HandledByEmployeeAvatarProps) {
  const empId = msg.handled_by_employee;
  if (!empId) return null;
  const empStore = useEmployeeStore.getState();
  const emp = empStore.employees.find((e: any) => e.employee_id === empId);
  const empName = emp?.display_name || empStore.employeeNameMap[empId] || 'NV';
  const rawAvatar = emp?.avatar_url || empStore.employeeAvatarMap[empId] || '';
  // Convert local path → Boss REST URL if needed (employee mode)
  const empAvatar = rawAvatar && !rawAvatar.startsWith('http')
    ? toLocalMediaUrl(rawAvatar)
    : rawAvatar;
  return <EmployeeAvatar key={empId} name={empName} avatarUrl={empAvatar} />;
}
