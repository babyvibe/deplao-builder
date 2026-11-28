/**
 * Facebook in the chat window: when the DB has no older messages → fetch one older page through the bridge (LightSpeed FetchMessagesTask, saved to the DB). Group
 * members / senders: saved data only.
 */
import { useAppStore } from '@/store/app/appStore';
import ipc from '@/lib/ipc';
import type { ChatWindowChannel, OlderFromServerArgs, OlderFromServerResult } from '../types';
import { tr } from '../../../../../../shared/i18n';
import { markEncryptedHistoryLocked } from '@/lib/chat/facebook/encryptedHistoryLock';

/** Error code "dừng tải, không báo lỗi" (stop loading, show no error) (opening / scrolling again later will retry) */
const FACEBOOK_OLDER_STOP_CODES = ['E2EE', 'BRIDGE_OLD', 'BRIDGE_DOWN', 'NOT_CONNECTED', 'BUSY', 'COOLDOWN', 'RISK', 'CANCELLED'];

async function fetchOlderFromServer({ accountId, threadId, oldest, before }: OlderFromServerArgs): Promise<OlderFromServerResult> {
  // DB has no more → fetch one older page through the bridge (LightSpeed FetchMessagesTask, saved to the DB), then read the DB again
  const fbRes: any = await ipc.fb?.fetchOlderMessages({
    accountId,
    threadId,
    beforeTimestampMs: before,
    beforeMessageId: String(oldest.msg_id || ''),
  });
  if (fbRes?.success) {
    return { stored: fbRes.stored || 0, hasMore: !!fbRes.hasMoreBefore };
  }
  if (fbRes?.code === 'E2EE') {
    // Encrypted chat: the chat window offers to unlock the old messages with the Messenger PIN
    markEncryptedHistoryLocked(accountId, threadId);
  }
  if (FACEBOOK_OLDER_STOP_CODES.includes(fbRes?.code)) {
    // End-to-end encryption / old bridge / bridge reconnecting / loading many pages (at a real user's pace) / Facebook shows
    // signs of restriction: stop, show no error on each conversation open (opening / scrolling again later will retry)
    if (fbRes?.code === 'RISK') useAppStore.getState().showNotification(fbRes.error || tr('Facebook có dấu hiệu hạn chế — tạm dừng tải tin cũ'), 'warning');
    return { stored: 0, hasMore: false };
  }
  // Facebook is slow to respond → "Lỗi - Thử lại" (Error - Retry), keep hasMore
  throw new Error(fbRes?.error || 'Facebook fetchOlderMessages failed');
}

export const facebookChatWindow: ChatWindowChannel = {
  fetchOlderFromServer,
};
