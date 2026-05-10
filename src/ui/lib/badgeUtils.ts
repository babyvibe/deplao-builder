import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';

/**
 * Tính tổng unread cho badge taskbar.
 * Chỉ tính hội thoại:
 *   - KHÔNG nằm trong thư mục "Khác" (Others)
 *   - KHÔNG bị tắt thông báo (muted)
 */
export function getFilteredUnreadCount(): number {
  const allContacts = useChatStore.getState().contacts;
  const { isMuted, isInOthers } = useAppStore.getState();

  let total = 0;
  for (const [zaloId, contacts] of Object.entries(allContacts)) {
    for (const c of contacts) {
      if ((c.unread_count || 0) <= 0) continue;
      if (isInOthers(zaloId, c.contact_id)) continue;
      if (isMuted(zaloId, c.contact_id)) continue;
      total += c.unread_count;
    }
  }
  return total;
}

