import { useAccountStore } from '@/store/accountStore';
import { CHANNEL } from '@/lib/channelHelper';
import { liveReadSync, type ReadRow } from '@/lib/chat/liveReadSync';

/**
 * Gửi sự kiện đã xem (sendSeenEvent) cho một hội thoại Zalo — giữ cho code cũ. Đường mới: liveReadSync (mọi kênh, mốc là
 * tin NHẬN mới nhất; trước đây lấy tin mới nhất kể cả tin của mình / tin hệ thống nên Zalo không nhận).
 *
 * @param zaloId - owner zalo ID
 * @param threadId - contactId / groupId
 * @param threadType - 0 = User, 1 = Group
 * @param _authOverride - không dùng nữa (auth lấy theo tài khoản)
 * @param lastMsg - tin vừa có sẵn (tránh query lại DB); không phải tin nhận thì đọc DB
 */
export function sendSeenForThread(
  zaloId: string,
  threadId: string,
  threadType: number,
  _authOverride?: { cookies: string; imei: string; userAgent: string } | null,
  lastMsg?: ReadRow | null,
): void {
  const account = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
  if (!account || (account.channel || CHANNEL.ZALO) !== CHANNEL.ZALO) return;
  void liveReadSync.syncOpenedThread({ accountId: zaloId, threadId, threadType }, lastMsg ? [lastMsg] : undefined);
}
