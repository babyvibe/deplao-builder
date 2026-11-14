import { useChatStore } from '@/store/chat/chatStore';
import { useAppStore } from '@/store/app/appStore';

/**
 * Total unread count for the taskbar badge.
 * Counts only conversations that:
 *   - are NOT in the "Khác" folder (Others)
 *   - do NOT have notifications turned off (muted)
 */
export function getFilteredUnreadCount(): number {
  const allContacts = useChatStore.getState().contacts;
  const { isMuted, isInOthers, isZaloHidden } = useAppStore.getState();

  let total = 0;
  for (const [zaloId, contacts] of Object.entries(allContacts)) {
    for (const c of contacts) {
      if ((c.unread_count || 0) <= 0) continue;
      if (isInOthers(zaloId, c.contact_id)) continue;
      if (isZaloHidden(zaloId, c.contact_id)) continue;
      if (isMuted(zaloId, c.contact_id)) continue;
      total += c.unread_count;
    }
  }
  return total;
}

let badgeRefreshQueued = false;
/**
 * Taskbar badge for a batch of messages handled in one task (catch-up messages after going offline): recounts once at the end of the task instead of
 * every message recounting all conversations + one IPC.
 */
export function queueBadgeRefresh(apply: (count: number) => void): void {
  if (badgeRefreshQueued) return;
  badgeRefreshQueued = true;
  queueMicrotask(() => {
    badgeRefreshQueued = false;
    apply(getFilteredUnreadCount());
  });
}
