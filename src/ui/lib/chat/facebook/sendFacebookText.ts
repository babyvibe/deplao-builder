/**
 * Sends a text message to a Facebook conversation from outside the composer (postback / quick-reply button of a Page template message), through the same path as the composer: a temporary "đang gửi" (sending) message + the send queue (retry, the echo replaces the temporary message).
 *
 * The LightSpeed library has no postback command: the Page receives the button's name as a message (as it shows in the Messenger chat window), not the button's hidden payload.
 */
import * as channelIpc from '@/lib/channels/channelIpc';
import { generateTempId, messageQueue } from '@/lib/chat/send/MessageQueue';
import { useChatStore } from '@/store/chat/chatStore';
import { tr } from '../../../../shared/i18n';

export function sendFacebookText(input: { accountId: string; threadId: string; threadType?: number; text: string }): boolean {
  const text = String(input.text || '').trim();
  const { accountId, threadId } = input;
  if (!text || !accountId || !threadId) return false;
  const threadType = Number(input.threadType) === 1 ? 1 : 0;
  const tempId = generateTempId();
  useChatStore.getState().addMessage(accountId, threadId, {
    msg_id: tempId, owner_zalo_id: accountId, thread_id: threadId,
    thread_type: threadType, sender_id: accountId, content: text,
    msg_type: 'text', timestamp: Date.now(), is_sent: 1, status: 'sending', channel: 'facebook',
    send_status: 'pending', temp_id: tempId, media_type: 'text',
  } as any);
  messageQueue.enqueue({
    tempId,
    zaloId: accountId,
    threadId,
    threadType,
    channel: 'facebook' as any,
    sendFn: async () => {
      try {
        const res: any = await channelIpc.sendMessage('facebook' as any, { accountId, threadId, body: text, threadType });
        if (!res?.success) {
          return { success: false, uncertain: !!res?.uncertain, msgId: res?.messageId, error: res?.error || tr('Gửi tin nhắn Facebook thất bại') };
        }
        return { success: true, msgId: res?.messageId };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    },
    onSuccess: () => useChatStore.getState().markReplied(accountId, threadId),
  });
  return true;
}
