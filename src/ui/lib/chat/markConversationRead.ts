/**
 * markConversationRead - "Đánh dấu đã đọc" for one conversation: the app (DB + store: unread count
 * and the @ flag), then the platform when it has an API:
 *  - Zalo: removeUnreadMark (manual "unread" mark) + sendSeenEvent for the newest message
 *  - Telegram: ReadHistory + unread @-mentions / reactions (telegramUser:readChatHistory)
 *  - Facebook: read receipt (fb:markAsRead)
 *  - Telegram Bot: no read state on the platform → app only
 * Shared by the conversation context menu and "Tự động đánh dấu đã đọc".
 */
import ipc, { buildZaloAuth } from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { getAdapter } from '@/lib/adapters/registry';
import { CHANNEL } from '@/lib/channelHelper';
import { useAccountStore } from '@/store/accountStore';
import { useChatStore } from '@/store/chatStore';
import { useEmployeeStore } from '@/store/employeeStore';

/** synced = sent to the platform; unsupported = platform has no API / nothing to send; failed = API error. */
export type ReadSyncResult = 'synced' | 'unsupported' | 'failed';

export interface MarkConversationReadOptions {
  accountId: string;
  threadId: string;
  threadType: number;
  /** Also mark it read on Zalo / Telegram / Facebook (default true). */
  syncPlatform?: boolean;
}

const isEmployeeMode = () => useEmployeeStore.getState().mode === 'employee';

/** Zalo API call; employee mode goes through Boss (it holds the session). */
function zaloCall(method: string, accountId: string, params: any): Promise<any> {
  if (isEmployeeMode()) return ipc.employee?.proxyAction(`zalo:${method}`, { ...params, auth: { zaloId: accountId } }) ?? Promise.resolve(null);
  const fn = (ipc.zalo as any)?.[method];
  return fn ? fn(params) : Promise.resolve(null);
}

async function syncZaloRead(account: any, threadId: string, threadType: number): Promise<{ sync: ReadSyncResult; error?: string }> {
  const auth = buildZaloAuth(account);
  await zaloCall('removeUnreadMark', account.zalo_id, { auth, threadId, type: threadType }).catch(() => null);
  const res: any = await DataAccessor.getMessages({ zaloId: account.zalo_id, threadId, limit: 1, offset: 0 }).catch(() => null);
  const last = res?.messages?.[0];
  if (!last?.msg_id) return { sync: 'unsupported' };
  const seen = [{
    msgId: String(last.msg_id),
    cliMsgId: String(last.cli_msg_id || last.msg_id),
    uidFrom: String(last.sender_id || ''),
    idTo: threadId,
    msgType: last.msg_type || 'text',
    st: last.status === 'sent' ? 1 : 0,
    at: 0,
    cmd: 0,
    ts: last.timestamp || Date.now(),
  }];
  const result: any = await zaloCall('sendSeenEvent', account.zalo_id, { auth, messages: seen, type: threadType });
  return result && result.success === false ? { sync: 'failed', error: result.error } : { sync: 'synced' };
}

export async function markConversationRead(opts: MarkConversationReadOptions): Promise<{ sync: ReadSyncResult; error?: string }> {
  const { accountId, threadId, threadType } = opts;

  // 1) App: unread count + "@" flag (store first so the list reacts immediately)
  const store = useChatStore.getState();
  store.clearUnread(accountId, threadId);
  if ((store.contacts[accountId] || []).some(contact => contact.contact_id === threadId)) {
    store.updateContact(accountId, { contact_id: threadId, has_mention: 0 } as any);
  }
  await DataAccessor.markAsRead({ zaloId: accountId, contactId: threadId });
  DataAccessor.setContactFlags({ zaloId: accountId, contactId: threadId, flags: { has_mention: 0 } }).catch(() => {});
  if (opts.syncPlatform === false) return { sync: 'unsupported' };

  // 2) Platform
  const account = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
  const channel = account?.channel || CHANNEL.ZALO;
  try {
    if (channel === CHANNEL.ZALO) {
      return account ? await syncZaloRead(account, threadId, threadType) : { sync: 'failed', error: 'Không tìm thấy tài khoản' };
    }
    if (channel === CHANNEL.TELEGRAM_USER || channel === CHANNEL.FACEBOOK) {
      const res = await getAdapter(channel).markAsRead({ accountId, threadId });
      return res?.success === false ? { sync: 'failed', error: res.error } : { sync: 'synced' };
    }
    return { sync: 'unsupported' };
  } catch (err: any) {
    return { sync: 'failed', error: err?.message || String(err) };
  }
}
