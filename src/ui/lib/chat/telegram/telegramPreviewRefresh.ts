import ipc from '@/lib/ipc';
import { useChatStore } from '@/store/chat/chatStore';
import { isTelegramUser } from '@/lib/channels/channelHelper';

/**
 * Bù thông tin thẻ link cho tin Telegram lưu trước khi có tiêu đề / mô tả trang (ảnh preview chỉ có tên trang) hoặc trước
 * khi video link có thẻ (vd. fxTikTok). Khi thẻ hiện ra: gom các tin cùng hội thoại trong 400 ms → 1 lần
 * `telegramUser:refreshMessageAttachments` (1 RPC getMessages, không tải media) → cập nhật attachments trong store.
 * Mỗi tin chỉ hỏi 1 lần mỗi phiên; lỗi (mất kết nối…) thì 60 s sau mới cho hỏi lại.
 */
const FLUSH_DELAY_MS = 400;
const RETRY_AFTER_FAILURE_MS = 60_000;
const BATCH_SIZE = 50;
const PREVIEW_MEDIA_TYPES = new Set(['photo', 'video', 'gif']);
const URL_PATTERN = /https?:\/\/\S/i;

const requested = new Set<string>();
const pending = new Map<string, { accountId: string; chatId: string; ids: Set<string> }>();
let timer: ReturnType<typeof setTimeout> | null = null;

function parseAttachments(value: unknown): any[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : (value || []);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Tin cần lấy lại thông tin thẻ link từ Telegram. */
export function needsTelegramPreviewRefresh(msg: any): boolean {
  if (!isTelegramUser(msg?.channel) || msg?.msg_type === 'recalled' || !/^\d+$/.test(String(msg?.msg_id || ''))) return false;
  const media = parseAttachments(msg.attachments).find((attachment) => PREVIEW_MEDIA_TYPES.has(String(attachment?.type || '')));
  if (!media) return false;
  // Định dạng cũ: có source 'webpage' + tên trang nhưng chưa có khoá tiêu đề / mô tả
  if (media.source === 'webpage') return !('title' in media) && !('description' in media);
  // Link preview lưu trước khi có `source` (ảnh / video của trang): nội dung tin có link
  return URL_PATTERN.test(String(msg.content || ''));
}

async function flush(): Promise<void> {
  timer = null;
  const batches = [...pending.values()];
  pending.clear();
  for (const batch of batches) {
    const ids = [...batch.ids];
    for (let index = 0; index < ids.length; index += BATCH_SIZE) {
      const chunk = ids.slice(index, index + BATCH_SIZE);
      const keys = chunk.map((id) => `${batch.accountId}:${batch.chatId}:${id}`);
      const allowRetryLater = () => setTimeout(() => keys.forEach((key) => requested.delete(key)), RETRY_AFTER_FAILURE_MS);
      try {
        const result = await ipc.telegramUser?.refreshMessageAttachments?.({
          accountId: batch.accountId, chatId: batch.chatId, messageIds: chunk,
        });
        if (!result?.success) { allowRetryLater(); continue; }
        for (const item of result.messages || []) {
          if (!item?.messageId || !Array.isArray(item.attachments)) continue;
          useChatStore.getState().patchMessage(batch.accountId, batch.chatId, String(item.messageId), {
            attachments: JSON.stringify(item.attachments),
          });
        }
      } catch {
        allowRetryLater();
      }
    }
  }
}

export function requestTelegramPreviewRefresh(msg: any): void {
  if (!needsTelegramPreviewRefresh(msg)) return;
  const accountId = String(msg.owner_zalo_id || '');
  const chatId = String(msg.thread_id || '');
  const messageId = String(msg.msg_id || '');
  if (!accountId || !chatId) return;
  const key = `${accountId}:${chatId}:${messageId}`;
  if (requested.has(key)) return;
  requested.add(key);
  const batchKey = `${accountId}:${chatId}`;
  const batch = pending.get(batchKey) || { accountId, chatId, ids: new Set<string>() };
  batch.ids.add(messageId);
  pending.set(batchKey, batch);
  if (!timer) timer = setTimeout(() => { void flush(); }, FLUSH_DELAY_MS);
}

/** Chỉ dùng trong test. */
export function __resetTelegramPreviewRefresh(): void {
  requested.clear();
  pending.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}
