import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';

/**
 * Gửi sự kiện đã đọc (sendSeenEvent) cho Zalo.
 * Lấy tin nhắn cuối cùng trong thread từ DB rồi gọi API.
 *
 * @param zaloId - owner zalo ID
 * @param threadId - contactId / groupId
 * @param threadType - 0 = User, 1 = Group
 * @param authOverride - nếu có sẵn auth thì truyền vào, không thì tự lấy
 */
export function sendSeenForThread(
  zaloId: string,
  threadId: string,
  threadType: number,
  authOverride?: { cookies: string; imei: string; userAgent: string } | null,
): void {
  try {
    // Skip for non-Zalo channels
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
    if (!accObj || (accObj.channel || 'zalo') !== 'zalo') return;

    // Resolve auth
    let auth = authOverride;
    if (!auth) {
      auth = { cookies: accObj.cookies, imei: accObj.imei, userAgent: accObj.user_agent };
    }
    if (!auth) return;

    const finalAuth = auth;

    // Lấy tin nhắn cuối cùng từ DB để build params cho sendSeenEvent
    ipc.db?.getMessages({ zaloId, threadId, limit: 1, offset: 0 }).then((res: any) => {
      const msgs = res?.messages || [];
      if (msgs.length === 0) return;
      const lastMsg = msgs[0];
      const seenMessages = [{
        msgId: lastMsg.msg_id || '',
        cliMsgId: lastMsg.cli_msg_id || lastMsg.msg_id || '',
        uidFrom: lastMsg.sender_id || '',
        idTo: threadId,
        msgType: lastMsg.msg_type || 'text',
        st: lastMsg.status === 'sent' ? 1 : 0,
        at: 0,
        cmd: 0,
        ts: lastMsg.timestamp || Date.now(),
      }];
      ipc.zalo?.sendSeenEvent({ auth: finalAuth, messages: seenMessages, type: threadType }).catch(() => {});
    }).catch(() => {});
  } catch {
    // Silent fail — seen event is best-effort
  }
}

