/**
 * accountContacts.ts — nạp lại danh sách hội thoại của MỘT tài khoản sau một sự kiện (listener kết nối lại, đồng bộ
 * xong…), dùng chung cho useZaloEvents / useChatEvents / App.
 *
 * Chủ / standalone: DB qua IPC (mọi hội thoại — như trước). Nhân viên: `ipc.db.getContacts` chỉ là stub
 * `{ success: true }` (DB máy nhân viên không có hội thoại) → đọc từ BOSS qua DataAccessor.getConversations
 * (EMPLOYEE_CONTACT_RELOAD_LIMIT hội thoại mới nhất). Lỗi đọc → giữ danh sách đang có; không thay danh sách đã tải
 * nhiều hơn (người dùng đã cuộn quá giới hạn) — vẫn trả danh sách vừa đọc để người gọi dùng (vd nạp bí danh).
 */
import ipc from '@/lib/ipc';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import { useChatStore, type ContactItem } from '@/store/chatStore';
import { useEmployeeStore } from '@/store/employeeStore';

export const EMPLOYEE_CONTACT_RELOAD_LIMIT = 500;

/** Danh sách vừa đọc (đã đặt vào store, trừ khi làm hụt danh sách nhân viên đang có); null = lỗi đọc / không có gì. */
export async function reloadAccountContacts(zaloId: string): Promise<ContactItem[] | null> {
  if (!zaloId) return null;
  if (useEmployeeStore.getState().mode === 'employee') {
    const res = await DataAccessor.getConversations(zaloId, EMPLOYEE_CONTACT_RELOAD_LIMIT, 0);
    if (isReadFailure(res) || !Array.isArray(res?.items) || res.items.length === 0) return null;
    const contacts = res.items as ContactItem[];
    const current = useChatStore.getState().contacts[zaloId] || [];
    if (contacts.length >= current.length) useChatStore.getState().setContacts(zaloId, contacts);
    return contacts;
  }
  // Chủ / standalone: DB đọc đủ mọi hội thoại → thay như trước
  const res: any = await ipc.db?.getContacts(zaloId);
  const contacts: ContactItem[] = Array.isArray(res?.contacts) ? res.contacts : [];
  if (contacts.length === 0) return null;
  useChatStore.getState().setContacts(zaloId, contacts);
  return contacts;
}
