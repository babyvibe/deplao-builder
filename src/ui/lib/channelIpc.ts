/**
 * channelIpc.ts — Channel-aware IPC facade
 * Routes API calls to the correct backend (Zalo or Facebook) based on channel.
 * UI components call this instead of ipc.zalo / ipc.fb directly.
 */

import ipc from './ipc';
import { Channel } from '../../configs/channelConfig';

// ─── Send Message ─────────────────────────────────────────────────────────────

export async function sendMessage(channel: Channel, params: {
  accountId: string;
  threadId: string;
  body: string;
  threadType?: number;  // Zalo: 0=user, 1=group
  options?: any;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (channel === 'facebook') {
    // Map threadType (0=user, 1=group) → typeChat for FB API
    const typeChat = params.threadType === 0 ? 'user' : undefined;
    return ipc.fb?.sendMessage({
      accountId: params.accountId,
      threadId: params.threadId,
      body: params.body,
      options: { ...params.options, typeChat },
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  // Zalo
  return ipc.zalo?.sendMessage({
    zaloId: params.accountId,
    threadId: params.threadId,
    threadType: params.threadType ?? 0,
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
}): Promise<{ success: boolean; error?: string }> {
  if (channel === 'facebook') {
    const typeChat = params.threadType === 0 ? 'user' : undefined;
    return ipc.fb?.sendAttachment({
      accountId: params.accountId,
      threadId: params.threadId,
      filePath: params.filePath,
      body: params.body,
      typeChat,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
  // Zalo — route to sendImage or sendFile depending on extension
  return ipc.zalo?.sendFile({
    zaloId: params.accountId,
    threadId: params.threadId,
    threadType: params.threadType ?? 0,
    filePath: params.filePath,
  }) ?? { success: false, error: 'Zalo IPC not available' };
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
  // Zalo doesn't have a getThreads — contacts are synced via events
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
  return ipc.db?.getMessages?.({
    ownerZaloId: params.accountId,
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

