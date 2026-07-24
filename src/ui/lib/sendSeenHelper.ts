import ipc from '@/lib/ipc'
import DataAccessor from '@/lib/data/DataAccessor';;
import { useAccountStore } from '@/store/accountStore';

/**
 * Gửi sự kiện đã đọc (sendSeenEvent) cho Zalo.
 * Nếu lastMsg được truyền vào → dùng luôn, nếu không → query DB.
 *
 * @param zaloId - owner zalo ID
 * @param threadId - contactId / groupId
 * @param threadType - 0 = User, 1 = Group
 * @param authOverride - nếu có sẵn auth thì truyền vào, không thì tự lấy
 * @param lastMsg - tin nhắn cuối cùng đã có sẵn (tránh query lại DB)
 */
export function sendSeenForThread(
  zaloId: string,
  threadId: string,
  threadType: number,
  authOverride?: { cookies: string; imei: string; userAgent: string } | null,
  lastMsg?: { msg_id: string; cli_msg_id?: string; sender_id?: string; msg_type?: string; status?: string; timestamp?: number } | null,
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

    const buildAndSend = (msg: any) => {
      if (!msg) return;
      const seenMessages = [{
        msgId: msg.msg_id || '',
        cliMsgId: msg.cli_msg_id || msg.msg_id || '',
        uidFrom: msg.sender_id || '',
        idTo: threadId,
        msgType: msg.msg_type || 'text',
        st: msg.status === 'sent' ? 1 : 0,
        at: 0,
        cmd: 0,
        ts: msg.timestamp || Date.now(),
      }];
      ipc.zalo?.sendSeenEvent({ auth: finalAuth, messages: seenMessages, type: threadType }).catch(() => {});
    };

    if (lastMsg) {
      buildAndSend(lastMsg);
    } else {
      DataAccessor.getMessages({ zaloId, threadId, limit: 1, offset: 0 }).then((res: any) => {
        const msgs = res?.messages || [];
        if (msgs.length === 0) return;
        buildAndSend(msgs[0]);
      }).catch(() => {});
    }
  } catch {
    // Silent fail - seen event is best-effort
  }
}

