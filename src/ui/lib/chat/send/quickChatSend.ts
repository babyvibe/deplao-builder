/**
 * Sends a message from "Nhắn tin nhanh" (Quick message) (Ctrl+Shift+N, the "Nhắn tin" button of the profile) for every channel. Before, the popup only called ipc.zalo:
 * picking a Telegram / Facebook account was allowed, but text, 👍, photos and files all failed silently.
 *
 * Each function returns a SendResult for MessageQueue (the temp message `temp_…` shows at once, is sent again on error, and is replaced when the real message comes back),
 * the same as the composer in the chat window.
 */
import ipc from '@/lib/ipc';
import { getAdapter } from '@/lib/channels/adapters/registry';
import { extractMsgIdFromResponse, type SendResult } from '@/lib/chat/send/MessageQueue';
import { isFacebook, isTelegramUser, isZalo } from '@/lib/channels/channelHelper';
import DataAccessor from '@/lib/data/DataAccessor';
import { tr } from '../../../../shared/i18n';

export interface QuickSendTarget {
  accountId: string;
  channel: string;
  threadId: string;
  threadType: number;
  /** Zalo: cookie / imei of the sending account */
  auth?: any;
}

const failed = (res: any, fallback: string): SendResult => ({
  success: false,
  uncertain: !!res?.uncertain,
  msgId: res?.messageId ? String(res.messageId) : undefined,
  error: res?.error || fallback,
});

export async function sendQuickText(target: QuickSendTarget, text: string): Promise<SendResult> {
  try {
    if (isZalo(target.channel)) {
      const res = await ipc.zalo?.sendMessage({ auth: target.auth, threadId: target.threadId, type: target.threadType, message: text });
      return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
    }
    const res: any = await getAdapter(target.channel as any).sendMessage({
      accountId: target.accountId, threadId: target.threadId, body: text, threadType: target.threadType,
    });
    if (!res?.success) return failed(res, tr('Gửi tin thất bại'));
    return { success: true, msgId: res.messageId || res.msgId ? String(res.messageId || res.msgId) : undefined };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Several photos: Zalo / Facebook send them in one go (album), Telegram sends each photo one by one, as in the chat window. */
export async function sendQuickImages(target: QuickSendTarget, filePaths: string[]): Promise<SendResult> {
  try {
    if (isZalo(target.channel)) {
      const res = await ipc.zalo?.sendImages({ auth: target.auth, threadId: target.threadId, type: target.threadType, filePaths });
      return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
    }
    if (isFacebook(target.channel)) {
      const res: any = await ipc.fb?.sendAttachments({
        accountId: target.accountId, threadId: target.threadId, filePaths,
        typeChat: target.threadType === 0 ? 'user' : null,
      });
      if (!res?.success) return failed(res, tr('Gửi ảnh Facebook thất bại'));
      return { success: true, msgId: res.messageId ? String(res.messageId) : undefined };
    }
    const msgIds: string[] = [];
    for (const filePath of filePaths) {
      const res: any = await getAdapter(target.channel as any).sendAttachment({
        accountId: target.accountId, threadId: target.threadId, threadType: target.threadType, filePath, fileType: 'image',
      });
      if (!res?.success) return failed(res, tr('Gửi ảnh thất bại'));
      if (res.messageId) msgIds.push(String(res.messageId));
    }
    return { success: true, msgId: msgIds[msgIds.length - 1], msgIds };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

export async function sendQuickFile(target: QuickSendTarget, filePath: string): Promise<SendResult> {
  try {
    if (isZalo(target.channel)) {
      const res = await ipc.zalo?.sendFile({ auth: target.auth, threadId: target.threadId, type: target.threadType, filePath });
      return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
    }
    const res: any = await getAdapter(target.channel as any).sendAttachment({
      accountId: target.accountId, threadId: target.threadId, threadType: target.threadType, filePath, fileType: 'file',
    });
    if (!res?.success) return failed(res, tr('Gửi tệp thất bại'));
    return { success: true, msgId: res.messageId ? String(res.messageId) : undefined };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Video (media of a quick message): Zalo uploads the cover photo + the video and then sends, other channels send the video file. */
export async function sendQuickVideo(target: QuickSendTarget, filePath: string): Promise<SendResult> {
  try {
    const meta: any = await ipc.file?.getVideoMeta?.({ filePath }).catch(() => null);
    const res: any = await getAdapter(target.channel as any).sendVideo({
      accountId: target.accountId, threadId: target.threadId, threadType: target.threadType, filePath,
      thumbPath: meta?.thumbPath || undefined, duration: meta?.duration || undefined,
      width: meta?.width || undefined, height: meta?.height || undefined,
      ...(isZalo(target.channel) ? { auth: target.auth } : {}),
    });
    if (!res?.success) return failed(res, tr('Gửi video thất bại'));
    return { success: true, msgId: res.messageId || res.msgId ? String(res.messageId || res.msgId) : undefined };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * History when the machine has no messages of the conversation yet (the person was just opened from a profile / found by @username): Telegram fetches it from the server, Facebook
 * through the bridge and then reads the DB again, as when a conversation is tapped in the list. Returns messages new → old.
 */
export async function fetchQuickChatHistory(accountId: string, threadId: string, channel: string, limit: number): Promise<any[]> {
  try {
    if (isTelegramUser(channel)) {
      const res: any = await ipc.telegramUser?.getMessages({ accountId, chatId: threadId, limit });
      return res?.success && Array.isArray(res.messages) ? res.messages : [];
    }
    if (isFacebook(channel)) {
      const bridgeRes: any = await ipc.fb?.fetchOlderMessages({ accountId, threadId });
      const fbRes: any = bridgeRes?.success || bridgeRes?.code === 'E2EE' || bridgeRes?.source === 'graphql'
        ? bridgeRes
        : await ipc.fb?.fetchThreadMessages({ accountId, threadId, limit });
      if (!fbRes?.success) return [];
      const again: any = await DataAccessor.getMessages({ zaloId: accountId, threadId, limit });
      return again?.messages || again?.items || [];
    }
  } catch {
    // If it cannot be fetched, leave it empty: sending the first message still works
  }
  return [];
}

/** The "Đến:" (To:) box searches the platform further: Zalo by phone number, Telegram by @username. */
export function recipientLookupKind(channel: string, query: string): 'zalo_phone' | 'telegram_username' | null {
  const value = query.trim().replace(/\s/g, '');
  if (isZalo(channel) && /^(\+84|0)\d{8,10}$/.test(value)) return 'zalo_phone';
  if (isTelegramUser(channel) && /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value)) return 'telegram_username';
  return null;
}
