/**
 * Facebook trong khung chat: DB hết tin cũ → một trang cũ hơn qua bridge (LightSpeed FetchMessagesTask, lưu DB). Thành
 * viên nhóm / người gửi: chỉ dữ liệu đã lưu.
 */
import { useAppStore } from '@/store/app/appStore';
import ipc from '@/lib/ipc';
import type { ChatWindowChannel, OlderFromServerArgs, OlderFromServerResult } from '../types';

/** Mã lỗi "dừng tải, không báo lỗi" (mở / cuộn lại sau sẽ thử lại) */
const FACEBOOK_OLDER_STOP_CODES = ['E2EE', 'BRIDGE_OLD', 'BRIDGE_DOWN', 'NOT_CONNECTED', 'BUSY', 'COOLDOWN', 'RISK', 'CANCELLED'];

async function fetchOlderFromServer({ accountId, threadId, oldest, before }: OlderFromServerArgs): Promise<OlderFromServerResult> {
  // DB đã hết → một trang tin cũ hơn qua bridge (LightSpeed FetchMessagesTask, lưu DB) rồi đọc lại DB
  const fbRes: any = await ipc.fb?.fetchOlderMessages({
    accountId,
    threadId,
    beforeTimestampMs: before,
    beforeMessageId: String(oldest.msg_id || ''),
  });
  if (fbRes?.success) {
    return { stored: fbRes.stored || 0, hasMore: !!fbRes.hasMoreBefore };
  }
  if (FACEBOOK_OLDER_STOP_CODES.includes(fbRes?.code)) {
    // Mã hoá đầu cuối / bridge cũ / bridge đang kết nối lại / đang tải nhiều (nhịp người dùng thật) / Facebook có
    // dấu hiệu hạn chế: dừng, không báo lỗi mỗi lần mở hội thoại (mở / cuộn lại sau sẽ thử lại)
    if (fbRes?.code === 'RISK') useAppStore.getState().showNotification(fbRes.error || 'Facebook có dấu hiệu hạn chế — tạm dừng tải tin cũ', 'warning');
    return { stored: 0, hasMore: false };
  }
  // Facebook chậm trả lời → "Lỗi - Thử lại", giữ hasMore
  throw new Error(fbRes?.error || 'Facebook fetchOlderMessages failed');
}

export const facebookChatWindow: ChatWindowChannel = {
  fetchOlderFromServer,
};
