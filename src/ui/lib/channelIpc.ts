/**
 * channelIpc.ts - Channel-aware IPC facade
 * Routes API calls to the correct backend (Zalo or Facebook) based on channel.
 * UI components call this instead of ipc.zalo / ipc.fb directly.
 */

import ipc from './ipc'
import DataAccessor from '../lib/data/DataAccessor';;
import { Channel } from '../../configs/channelConfig';

// ─── Send Message ─────────────────────────────────────────────────────────────

export async function sendMessage(channel: Channel, params: {
  accountId: string;
  threadId: string;
  body: string;
  threadType?: number;  // Zalo: 0=user, 1=group
  options?: any;
  /** Facebook only: quote payload JSON string (from buildQuotePayload).
   *  If provided, replyToMessageId is extracted and passed to FB API. */
  quote?: string | null;
  /** Zalo only: auth credentials. If omitted, fetched from account store. */
  auth?: any;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (channel === 'facebook') {
    // Map threadType (0=user, 1=group) → typeChat for FB API
    const typeChat = params.threadType === 0 ? 'user' : undefined;

    // Extract replyToMessageId from quote payload if provided
    let replyToMessageId: string | undefined;
    if (params.quote) {
      try {
        const parsed = JSON.parse(params.quote);
        replyToMessageId = parsed.msgId || undefined;
      } catch {}
    }

    return ipc.fb?.sendMessage({
      accountId: params.accountId,
      threadId: params.threadId,
      body: params.body,
      options: {
        ...params.options,
        typeChat,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      },
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  // Zalo
  // Try to resolve auth from account store if not provided
  let auth = params.auth;
  if (!auth) {
    try {
      const { useAccountStore } = require('../store/accountStore');
      const account = useAccountStore.getState().accounts?.find((a: any) => a.zalo_id === params.accountId);
      if (account?.cookies) {
        auth = { cookies: account.cookies, imei: account.imei || '', userAgent: account.user_agent || '' };
      }
    } catch {}
  }
  return ipc.zalo?.sendMessage({
    auth,
    threadId: params.threadId,
    type: params.threadType ?? 0,
    message: params.body,
    ...params.options,
  }) ?? { success: false, error: 'Zalo IPC not available' };
}

// ─── Send Image ───────────────────────────────────────────────────────────────

export async function sendAttachment(channel: Channel, params: {
  accountId: string;
  threadId: string;
  filePath: string;
  threadType?: number;
  body?: string;
  fileType?: 'image' | 'video' | 'audio' | 'file';
  /** Facebook only: quote payload JSON string */
  quote?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    const typeChat = params.threadType === 0 ? 'user' : undefined;

    // Extract replyToMessageId from quote payload
    let replyToMessageId: string | undefined;
    if (params.quote) {
      try {
        const parsed = JSON.parse(params.quote);
        replyToMessageId = parsed.msgId || undefined;
      } catch {}
    }

    return ipc.fb?.sendAttachment({
      accountId: params.accountId,
      threadId: params.threadId,
      filePath: params.filePath,
      body: params.body,
      typeChat,
      fileType: params.fileType,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  // Zalo - route to sendImage or sendFile depending on extension
  return ipc.zalo?.sendFile({
    zaloId: params.accountId,
    threadId: params.threadId,
    threadType: params.threadType ?? 0,
    filePath: params.filePath,
  }) ?? { success: false, error: 'Zalo IPC not available' };
}

// ─── Send Video ───────────────────────────────────────────────────────────────

export async function sendVideo(channel: Channel, params: {
  accountId: string;
  threadId: string;
  threadType?: number;
  filePath: string;
  thumbPath?: string;
  duration?: number;
  width?: number;
  height?: number;
  body?: string;
  quote?: any;
  /** Zalo only: auth credentials (cookies, imei, userAgent). Must be provided for Zalo channel. */
  auth?: any;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    const typeChat = params.threadType === 0 ? 'user' : undefined;

    // Extract replyToMessageId from quote payload
    let replyToMessageId: string | undefined;
    if (params.quote) {
      try {
        const parsed = JSON.parse(params.quote);
        replyToMessageId = parsed.msgId || undefined;
      } catch {}
    }

    return ipc.fb?.sendAttachment({
      accountId: params.accountId,
      threadId: params.threadId,
      filePath: params.filePath,
      body: params.body,
      typeChat,
      fileType: 'video',
      ...(replyToMessageId ? { replyToMessageId } : {}),
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  // Zalo: upload thumbnail → upload video file → send
  if (!params.auth) return { success: false, error: 'Missing auth for Zalo video' };

  // Upload thumbnail
  let thumbUrl = '';
  if (params.thumbPath) {
    const uploadRes = await ipc.zalo?.uploadVideoThumb?.({
      auth: params.auth,
      thumbPath: params.thumbPath,
      threadId: params.threadId,
      type: params.threadType,
    });
    const resp = uploadRes?.response;
    thumbUrl = resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.thumbUrl || resp?.fileUrl || resp?.href || '';
  }

  // Upload video file
  const uploadVideoRes = await ipc.zalo?.uploadVideoFile?.({
    auth: params.auth,
    videoPath: params.filePath,
    threadId: params.threadId,
    type: params.threadType,
  });
  const videoUrl: string = uploadVideoRes?.response?.fileUrl || '';
  if (!videoUrl) return { success: false, error: 'Upload video thất bại' };

  // Send video message
  await ipc.zalo?.sendVideo({
    auth: params.auth,
    options: {
      videoUrl,
      thumbnailUrl: thumbUrl || videoUrl,
      duration: params.duration ? params.duration * 1000 : undefined,
      width: params.width || undefined,
      height: params.height || undefined,
    },
    threadId: params.threadId,
    type: params.threadType,
    ...(params.quote ? { quote: params.quote } : {}),
  });

  return { success: true };
}

// ─── Unsend / Recall ──────────────────────────────────────────────────────────

export async function unsendMessage(channel: Channel, params: {
  accountId: string;
  messageId: string;
  threadId?: string;
  threadType?: number;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.unsendMessage({
      accountId: params.accountId,
      messageId: params.messageId,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  return ipc.zalo?.undoMessage({
    zaloId: params.accountId,
    threadId: params.threadId,
    threadType: params.threadType ?? 0,
    msgId: params.messageId,
  }) ?? { success: false, error: 'Zalo IPC not available' };
}

// ─── Reaction ─────────────────────────────────────────────────────────────────

export async function addReaction(channel: Channel, params: {
  accountId: string;
  messageId: string;
  emoji: string;
  threadId?: string;
  threadType?: number;
  action?: 'add' | 'remove';
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.addReaction({
      accountId: params.accountId,
      messageId: params.messageId,
      emoji: params.emoji,
      action: params.action || 'add',
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  return ipc.zalo?.addReaction({
    zaloId: params.accountId,
    threadId: params.threadId,
    threadType: params.threadType ?? 0,
    msgId: params.messageId,
    icon: params.emoji,
  }) ?? { success: false, error: 'Zalo IPC not available' };
}

// ─── Get Threads ──────────────────────────────────────────────────────────────

export async function getThreads(channel: Channel, params: {
  accountId: string;
  forceRefresh?: boolean;
}): Promise<{ success: boolean; threads?: any[]; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.getThreads({
      accountId: params.accountId,
      forceRefresh: params.forceRefresh,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  // Zalo doesn't have a getThreads - contacts are synced via events
  return { success: true, threads: [] };
}

// ─── Get Messages ─────────────────────────────────────────────────────────────

export async function getMessages(channel: Channel, params: {
  accountId: string;
  threadId: string;
  limit?: number;
  offset?: number;
}): Promise<{ success: boolean; messages?: any[]; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.getMessages({
      accountId: params.accountId,
      threadId: params.threadId,
      limit: params.limit,
      offset: params.offset,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  // Zalo messages are loaded from local DB via ipc.db
  return DataAccessor.getMessages?.({
    zaloId: params.accountId,
    threadId: params.threadId,
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  }) ?? { success: false, error: 'DB IPC not available' };
}

// ─── Mark as Read ─────────────────────────────────────────────────────────────

export async function markAsRead(channel: Channel, params: {
  accountId: string;
  threadId: string;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.markAsRead({
      accountId: params.accountId,
      threadId: params.threadId,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  // Zalo mark-as-read is handled differently (via db.markAsRead)
  return { success: true };
}

// ─── Send Typing ───────────────────────────────────────────────────────────────

export async function sendTyping(channel: Channel, params: {
  accountId: string;
  threadId: string;
  isTyping: boolean;
  isGroup?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.sendTyping({
      accountId: params.accountId,
      threadId: params.threadId,
      isTyping: params.isTyping,
      isGroup: params.isGroup,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  // Zalo typing is handled inline in MessageInput.tsx
  return { success: true };
}

// ─── Connect / Disconnect ─────────────────────────────────────────────────────

export async function connectAccount(channel: Channel, params: {
  accountId: string;
  auth?: any;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.connect({ accountId: params.accountId })
      ?? { success: false, error: 'FB IPC not available' };
  }
  return ipc.login?.connectAccount?.(params.auth)
    ?? { success: false, error: 'Login IPC not available' };
}

export async function disconnectAccount(channel: Channel, params: {
  accountId: string;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.disconnect({ accountId: params.accountId })
      ?? { success: false, error: 'FB IPC not available' };
  }
  return ipc.login?.disconnectAccount?.(params.accountId)
    ?? { success: false, error: 'Login IPC not available' };
}

// ─── Health Check ─────────────────────────────────────────────────────────────

export async function checkHealth(channel: Channel, params: {
  accountId: string;
}): Promise<{ success: boolean; alive: boolean; error?: string }> {
  if (channel === 'facebook') {
    const res = await ipc.fb?.checkHealth({ accountId: params.accountId });
    return { success: res?.success ?? false, alive: res?.alive ?? false, error: res?.reason };
  }
  const res = await ipc.login?.checkHealth?.(params.accountId);
  const result = res?.results?.[0];
  return { success: res?.success ?? false, alive: result?.healthy ?? false, error: result?.reason };
}

// ─── Group Management ─────────────────────────────────────────────────────────

export async function changeGroupName(channel: Channel, params: {
  accountId: string;
  threadId: string;
  name: string;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.changeThreadName({
      accountId: params.accountId,
      threadId: params.threadId,
      name: params.name,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  // Zalo group rename via zalo IPC
  return ipc.zalo?.changeGroupName?.({
    zaloId: params.accountId,
    groupId: params.threadId,
    name: params.name,
  }) ?? { success: false, error: 'Zalo IPC not available' };
}

// ─── Block / Unblock ────────────────────────────────────────────────────

export async function blockUser(channel: Channel, params: {
  accountId: string;
  userId: string;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.blockUser({
      accountId: params.accountId,
      userId: params.userId,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  return ipc.zalo?.blockUser?.({
    auth: { zaloId: params.accountId },
    userId: params.userId,
  }) ?? { success: false, error: 'Zalo IPC not available' };
}

export async function unblockUser(channel: Channel, params: {
  accountId: string;
  userId: string;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.unblockUser({
      accountId: params.accountId,
      userId: params.userId,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  return ipc.zalo?.unblockUser?.({
    auth: { zaloId: params.accountId },
    userId: params.userId,
  }) ?? { success: false, error: 'Zalo IPC not available' };
}

// ─── Forward Message ────────────────────────────────────────────────────

export async function forwardMessage(channel: Channel, params: {
  accountId: string;
  messageId: string;
  targetThreadId: string;
  threadType?: number;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.forwardMessage({
      accountId: params.accountId,
      messageId: params.messageId,
      targetThreadId: params.targetThreadId,
      isGroup: params.threadType === 1,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  return ipc.zalo?.forwardMessage?.({
    auth: { zaloId: params.accountId },
    msgId: params.messageId,
    threadId: params.targetThreadId,
    type: params.threadType ?? 0,
  }) ?? { success: false, error: 'Zalo IPC not available' };
}

// ─── Edit Message ───────────────────────────────────────────────────────

export async function editMessage(channel: Channel, params: {
  accountId: string;
  messageId: string;
  text: string;
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.editMessage({
      accountId: params.accountId,
      messageId: params.messageId,
      text: params.text,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  return { success: false, error: 'Zalo does not support editMessage' };
}

// ─── Polls ──────────────────────────────────────────────────────────────

export async function createPoll(channel: Channel, params: {
  accountId: string;
  threadId: string;
  question: string;
  options: string[];
}): Promise<{ success: boolean; pollId?: string; error?: string }> {
  if (channel === 'facebook') {
    return ipc.fb?.createPoll({
      accountId: params.accountId,
      threadId: params.threadId,
      question: params.question,
      options: params.options,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  // Zalo poll creation (params differ but map universally)
  return ipc.zalo?.createPoll?.({
    auth: { zaloId: params.accountId },
    groupId: params.threadId,
    question: params.question,
    options: params.options,
  }) ?? { success: false, error: 'Zalo IPC not available' };
}

