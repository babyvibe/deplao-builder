import { useAccountStore } from '@/store/accounts/accountStore';
import { CHANNEL } from '@/lib/channels/channelHelper';
import { liveReadSync, type ReadRow } from '@/lib/chat/read/liveReadSync';

/**
 * Sends the seen event (sendSeenEvent) for a Zalo conversation: kept for old code. The new path is liveReadSync (all channels, the mark is the
 * newest RECEIVED message; before, the newest message was used even if it was the user's own / a system message, so Zalo did not receive it).
 *
 * @param zaloId - owner zalo ID
 * @param threadId - contactId / groupId
 * @param threadType - 0 = User, 1 = Group
 * @param _authOverride - no longer used (auth comes from the account)
 * @param lastMsg - message already available (avoids querying the DB again); if it is not a received message, the DB is read
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
