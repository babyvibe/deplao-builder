/**
 * Conversation and people actions that run as LightSpeed tasks in the Go bridge (bridge/deplao_actions.go):
 * people search, starting a chat, message requests, mute, delete, delete for me, group members / admins / photo and
 * poll votes. Every action checks the bridge capability first, so an older bridge build answers with a clear message
 * instead of "unknown method".
 */
import type { FacebookE2EEBridge, FacebookPersonResult, FacebookThreadRef } from '../e2ee/FacebookE2EEBridge';
import DatabaseService from '../../database/DatabaseService';
import { tr } from '../../../shared/i18n';
import Logger from '../../../utils/Logger';

export interface ThreadActionContext {
  accountId: string;
  /** The account's Facebook id (contacts.owner_zalo_id). */
  ownerId(): string;
  /** The running bridge, null when it is not up. */
  bridge(): FacebookE2EEBridge | null;
  /** The conversation is end-to-end encrypted (its tasks run in sync group 95). */
  isEncryptedThread(threadId: string): boolean;
}

export type ActionResult<T extends object = object> = ({ success: true } & T) | { success: false; error: string };

const ID = /^\d+$/;

function cleanId(value: unknown): string {
  return String(value ?? '').replace(/@.*$/, '').trim();
}

function failure(err: unknown, fallback: string): { success: false; error: string } {
  const message = err instanceof Error ? err.message : String(err || '');
  return { success: false, error: message || fallback };
}

/** The bridge when it is up and knows the method; otherwise the error to show. */
export function bridgeFor(ctx: ThreadActionContext, capability: string): FacebookE2EEBridge | { error: string } {
  const bridge = ctx.bridge();
  if (!bridge) return { error: tr('Bridge Messenger chưa kết nối. Kết nối lại tài khoản Facebook rồi thử lại.') };
  if (!bridge.supportsCapability(capability)) {
    return { error: tr('Bản bridge Messenger hiện tại chưa hỗ trợ thao tác này. Hãy cập nhật ứng dụng.') };
  }
  return bridge;
}

function threadRef(ctx: ThreadActionContext, threadId: string): FacebookThreadRef {
  const encrypted = ctx.isEncryptedThread(threadId);
  return { threadId, encrypted, threadType: encrypted ? 15 : 0 };
}

export interface PersonSearchResult extends FacebookPersonResult {
  /** Deplao already has a conversation with this person / group. */
  hasConversation: boolean;
}

/** Messenger people search; results already in the conversation list are marked. */
export async function searchPeople(ctx: ThreadActionContext, query: string): Promise<ActionResult<{ results: PersonSearchResult[] }>> {
  const text = String(query || '').trim();
  if (text.length < 2) return { success: true, results: [] };
  const bridge = bridgeFor(ctx, 'searchUsers');
  if ('error' in bridge) return { success: false, error: bridge.error };
  try {
    const answer = await bridge.searchUsers(text);
    const db = DatabaseService.getInstance();
    const ownerId = ctx.ownerId();
    const results = (answer?.results || []).filter(r => ID.test(String(r?.id || ''))).map(r => {
      let hasConversation = false;
      try {
        hasConversation = !!db.queryOne?.(
          `SELECT 1 AS found FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook' LIMIT 1`,
          [ownerId, String(r.id)]);
      } catch { /* marking only */ }
      return { ...r, id: String(r.id), hasConversation };
    });
    return { success: true, results };
  } catch (err) {
    return failure(err, tr('Không tìm được người trên Messenger'));
  }
}

/**
 * Opens a chat with a person: Messenger creates the 1:1 thread (and the encrypted chat) and Deplao adds the
 * conversation to the list with the name / picture from the search. Without a bridge that can do it, the conversation
 * is still added: the first message creates the thread.
 */
export async function startChat(
  ctx: ThreadActionContext,
  person: { id: string; name?: string; avatarUrl?: string; isGroup?: boolean },
): Promise<ActionResult<{ threadId: string; encrypted: boolean }>> {
  const id = cleanId(person?.id);
  if (!ID.test(id)) return { success: false, error: tr('Người này không hợp lệ') };
  if (id === ctx.ownerId()) return { success: false, error: tr('Không thể nhắn tin cho chính tài khoản này') };
  let encrypted = false;
  if (!person.isGroup) {
    const bridge = bridgeFor(ctx, 'startChat');
    if (!('error' in bridge)) {
      try {
        encrypted = (await bridge.startChat(id))?.encrypted === true;
      } catch (err: any) {
        Logger.warn(`[FacebookThreadActions:${ctx.accountId}] startChat ${id}: ${err?.message || err}`);
      }
    }
  }
  try {
    const db = DatabaseService.getInstance();
    const kind = person.isGroup ? 'group' : 'user';
    const name = String(person.name || '').trim();
    db.run(
      `INSERT OR IGNORE INTO fb_threads (id, account_id, name, type, last_message_at, unread_count, is_e2ee) VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [id, ctx.accountId, name, kind, Date.now(), encrypted ? 1 : 0]);
    db.run(`
      INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
      VALUES (?, ?, ?, ?, 0, ?, 0, '', ?, 'facebook')
      ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
        display_name = CASE WHEN COALESCE(contacts.display_name, '') IN ('', contacts.contact_id) AND excluded.display_name != '' THEN excluded.display_name ELSE contacts.display_name END,
        avatar_url = CASE WHEN COALESCE(contacts.avatar_url, '') = '' AND excluded.avatar_url != '' THEN excluded.avatar_url ELSE contacts.avatar_url END
    `, [ctx.ownerId(), id, name, String(person.avatarUrl || ''), kind, Date.now()]);
  } catch (err) {
    return failure(err, tr('Không mở được cuộc trò chuyện'));
  }
  return { success: true, threadId: id, encrypted };
}

/** Mute until muteUntilMs (Unix ms); -1 = until turned back on, 0 = unmute. Synced to Messenger. */
export async function setThreadMute(ctx: ThreadActionContext, threadId: string, muteUntilMs: number): Promise<ActionResult> {
  const id = cleanId(threadId);
  if (!ID.test(id)) return { success: false, error: tr('Hội thoại không hợp lệ') };
  const bridge = bridgeFor(ctx, 'muteThread');
  if ('error' in bridge) return { success: false, error: bridge.error };
  const value = muteUntilMs === -1 ? -1 : Math.max(0, Math.round(Number(muteUntilMs) || 0));
  try {
    await bridge.muteThread({ ...threadRef(ctx, id), muteUntilMs: value });
    DatabaseService.getInstance().applyFBThreadMute(ctx.accountId, id, value);
    return { success: true };
  } catch (err) {
    return failure(err, tr('Không đổi được thông báo trên Messenger'));
  }
}

/** Delete the conversation from the account's Messenger inbox (the other people keep it). */
export async function deleteThread(ctx: ThreadActionContext, threadId: string): Promise<ActionResult> {
  const id = cleanId(threadId);
  if (!ID.test(id)) return { success: false, error: tr('Hội thoại không hợp lệ') };
  const bridge = bridgeFor(ctx, 'deleteThread');
  if ('error' in bridge) return { success: false, error: bridge.error };
  try {
    await bridge.deleteThread(threadRef(ctx, id));
    return { success: true };
  } catch (err) {
    return failure(err, tr('Không xóa được cuộc trò chuyện trên Messenger'));
  }
}

/** Accept a message request: Messenger moves it to the inbox, Deplao out of "Khác". */
export async function acceptMessageRequest(ctx: ThreadActionContext, threadId: string): Promise<ActionResult> {
  const id = cleanId(threadId);
  if (!ID.test(id)) return { success: false, error: tr('Hội thoại không hợp lệ') };
  const bridge = bridgeFor(ctx, 'acceptMessageRequest');
  if ('error' in bridge) return { success: false, error: bridge.error };
  try {
    await bridge.acceptMessageRequest(threadRef(ctx, id));
    DatabaseService.getInstance().run(
      `UPDATE contacts SET fb_request = 0, is_in_others = 0 WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
      [ctx.ownerId(), id]);
    return { success: true };
  } catch (err) {
    return failure(err, tr('Không chấp nhận được tin nhắn chờ'));
  }
}

/**
 * "Xóa (chỉ mình tôi)" synced to Messenger for ordinary messages. Encrypted messages have no such task: they are only
 * hidden in Deplao (synced: false).
 */
export async function deleteMessageForMe(ctx: ThreadActionContext, threadId: string, messageId: string): Promise<ActionResult<{ synced: boolean }>> {
  const id = cleanId(threadId);
  const mid = String(messageId || '').trim();
  if (!ID.test(id) || !mid) return { success: false, error: tr('Tin nhắn không hợp lệ') };
  // Ordinary Messenger message ids look like "mid.$…"; encrypted ones are WhatsApp-style ids.
  if (!mid.startsWith('mid.')) return { success: true, synced: false };
  const bridge = bridgeFor(ctx, 'deleteMessageForMe');
  if ('error' in bridge) return { success: true, synced: false };
  try {
    await bridge.deleteMessageForMe({ threadId: id, messageId: mid });
    return { success: true, synced: true };
  } catch (err) {
    return failure(err, tr('Không xóa được tin nhắn trên Messenger'));
  }
}

export async function addGroupMembers(ctx: ThreadActionContext, threadId: string, userIds: string[]): Promise<ActionResult> {
  const id = cleanId(threadId);
  const ids = Array.from(new Set((userIds || []).map(cleanId).filter(u => ID.test(u) && u !== ctx.ownerId())));
  if (!ID.test(id) || !ids.length) return { success: false, error: tr('Chọn ít nhất một người để thêm') };
  // An encrypted group changes its members through the encrypted socket (like Messenger)
  const encrypted = ctx.isEncryptedThread(id);
  const bridge = bridgeFor(ctx, encrypted ? 'e2eeGroups' : 'groupMembers');
  if ('error' in bridge) return { success: false, error: bridge.error };
  try {
    await bridge.addGroupMembers({ threadId: id, userIds: ids, ...(encrypted ? { encrypted: true } : {}) });
    return { success: true };
  } catch (err) {
    return failure(err, tr('Không thêm được thành viên'));
  }
}

/** Remove a member; the account's own id leaves the group. */
export async function removeGroupMember(ctx: ThreadActionContext, threadId: string, userId: string): Promise<ActionResult> {
  const id = cleanId(threadId);
  const uid = cleanId(userId);
  if (!ID.test(id) || !ID.test(uid)) return { success: false, error: tr('Thành viên không hợp lệ') };
  const encrypted = ctx.isEncryptedThread(id);
  const bridge = bridgeFor(ctx, encrypted ? 'e2eeGroups' : 'groupMembers');
  if ('error' in bridge) return { success: false, error: bridge.error };
  try {
    await bridge.removeGroupMember({ threadId: id, userId: uid, ...(encrypted ? { encrypted: true } : {}) });
    return { success: true };
  } catch (err) {
    return failure(err, uid === ctx.ownerId() ? tr('Không rời được nhóm') : tr('Không xóa được thành viên'));
  }
}

export async function setGroupAdmin(ctx: ThreadActionContext, threadId: string, userId: string, isAdmin: boolean): Promise<ActionResult> {
  const id = cleanId(threadId);
  const uid = cleanId(userId);
  if (!ID.test(id) || !ID.test(uid)) return { success: false, error: tr('Thành viên không hợp lệ') };
  if (ctx.isEncryptedThread(id)) return { success: false, error: tr('Messenger chưa cho đổi quản trị viên của nhóm mã hóa') };
  const bridge = bridgeFor(ctx, 'groupMembers');
  if ('error' in bridge) return { success: false, error: bridge.error };
  try {
    await bridge.setGroupAdmin({ threadId: id, userId: uid, isAdmin });
    return { success: true };
  } catch (err) {
    return failure(err, tr('Không đổi được quyền quản trị viên'));
  }
}

export async function setGroupPhoto(ctx: ThreadActionContext, threadId: string, localPath: string, mimeType?: string): Promise<ActionResult> {
  const id = cleanId(threadId);
  if (!ID.test(id) || !localPath) return { success: false, error: tr('Chọn ảnh nhóm') };
  if (ctx.isEncryptedThread(id)) return { success: false, error: tr('Messenger chưa cho đổi ảnh của nhóm mã hóa') };
  const bridge = bridgeFor(ctx, 'setGroupPhoto');
  if ('error' in bridge) return { success: false, error: bridge.error };
  try {
    await bridge.setGroupPhoto({ threadId: id, localPath, mimeType });
    return { success: true };
  } catch (err) {
    return failure(err, tr('Không đổi được ảnh nhóm'));
  }
}

/** Replace the account's choices in a poll (empty list = remove the vote). */
export async function votePoll(ctx: ThreadActionContext, threadId: string, pollId: string, optionIds: string[]): Promise<ActionResult> {
  const id = cleanId(threadId);
  const options = (optionIds || []).map(String).filter(o => ID.test(o));
  if (!ID.test(id) || !ID.test(String(pollId || ''))) return { success: false, error: tr('Bình chọn không hợp lệ') };
  const bridge = bridgeFor(ctx, 'polls');
  if ('error' in bridge) return { success: false, error: bridge.error };
  try {
    await bridge.votePollLS({ threadId: id, pollId: String(pollId), optionIds: options });
    return { success: true };
  } catch (err) {
    return failure(err, tr('Không gửi được bình chọn'));
  }
}
