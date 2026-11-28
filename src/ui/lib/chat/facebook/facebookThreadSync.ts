/**
 * Facebook conversation settings synced to Messenger: mute (from the conversation list, group info and conversation info)
 * and deleting a conversation. Deplao saves its own state first; Messenger sync is best effort and its error is returned
 * for a notification.
 */
import { ipc } from '@/lib/ipc';
import { tr } from '../../../../shared/i18n';

/**
 * Mute on Messenger. `until` uses Deplao's mute format: 0 = until turned back on, Unix ms = until then.
 * Returns an error text, or null when Messenger accepted it.
 */
export async function syncFacebookMute(accountId: string, threadId: string, muted: boolean, until = 0): Promise<string | null> {
  const muteUntilMs = !muted ? 0 : until > 0 ? until : -1;
  try {
    const res = await ipc.fb?.setThreadMute({ accountId, threadId, muteUntilMs });
    if (res?.success) return null;
    return res?.error || (muted ? tr('Không thể đồng bộ tắt thông báo với Messenger') : tr('Không thể đồng bộ bật thông báo với Messenger'));
  } catch {
    return muted ? tr('Không thể đồng bộ tắt thông báo với Messenger') : tr('Không thể đồng bộ bật thông báo với Messenger');
  }
}

/** Delete the conversation from the Messenger inbox too (before Deplao deletes its copy). Error text or null. */
export async function deleteFacebookThread(accountId: string, threadId: string): Promise<string | null> {
  try {
    const res = await ipc.fb?.deleteThread({ accountId, threadId });
    return res?.success ? null : (res?.error || tr('Không xóa được cuộc trò chuyện trên Messenger'));
  } catch {
    return tr('Không xóa được cuộc trò chuyện trên Messenger');
  }
}
