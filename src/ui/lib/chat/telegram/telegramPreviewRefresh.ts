import ipc from '@/lib/ipc';
import { useChatStore } from '@/store/chat/chatStore';
import { isTelegramUser } from '@/lib/channels/channelHelper';

/**
 * Fills in the link-card info for Telegram messages saved before the page title / description was available (the preview image only had the site name), or before
 * a video link had its card (e.g. fxTikTok). When the card appears: messages of the same conversation are grouped within 400 ms → 1 call
 * `telegramUser:refreshMessageAttachments` (1 getMessages RPC, no media download) → updates the attachments in the store.
 * Each message is asked only once per session; on error (connection lost...) it may be asked again after 60 s.
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

/** Message whose link-card info needs fetching again from Telegram. */
export function needsTelegramPreviewRefresh(msg: any): boolean {
  if (!isTelegramUser(msg?.channel) || msg?.msg_type === 'recalled' || !/^\d+$/.test(String(msg?.msg_id || ''))) return false;
  const media = parseAttachments(msg.attachments).find((attachment) => PREVIEW_MEDIA_TYPES.has(String(attachment?.type || '')));
  if (!media) return false;
  // Old format: has source 'webpage' + the site name, but no title / description key yet
  if (media.source === 'webpage') return !('title' in media) && !('description' in media);
  // Link preview saved before `source` existed (the page's image / video): message content with a link
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

/** Test only. */
export function __resetTelegramPreviewRefresh(): void {
  requested.clear();
  pending.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}
