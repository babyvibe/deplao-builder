/**
 * Telegram channel posts (like Telegram): post stats (views / shares / comments) refreshed with
 * messages.getMessagesViews, and comments, which live in the DISCUSSION GROUP attached to the channel, not in the channel.
 *
 * Previously comments were fetched with messages.getReplies and saved as messages of the CHANNEL (topic_id = post id): the comment ids (the group's id range)
 * collided with channel post ids → the INSERT was skipped (comments missing), the UPDATE overwrote the topic / reply of the channel post with the same id (770 posts
 * damaged), comments were normalized as channel messages so they showed as a "BÀI ĐĂNG KÊNH" (CHANNEL POST) card, in reversed order, and a sender that was the group showed as "U".
 */

import { tr } from '../../../shared/i18n';

export interface TelegramPostStats {
  views?: number | null;
  forwards?: number | null;
  replies?: {
    replies?: number | null;
    recentRepliers?: unknown[] | null;
    channelId?: unknown;
    /** Latest comment / last one read (the "chưa đọc" (unread) dot on the comment bar, like Telegram) */
    maxId?: number | null;
    readMaxId?: number | null;
  } | null;
}

const POST_STAT_KEYS = ['views', 'forwards', 'comments', 'discussion_channel_id', 'comments_max_id', 'comments_read_max_id'];

/**
 * Merges new stats into the `telegram_post` attachment (the JSON of the attachments column). Returns the new JSON, or null when there is no
 * post attachment or nothing changed. `peerId` turns the Peer of the most recent commenter into the standard id.
 */
export function mergeTelegramPostStats(
  attachmentsJson: string | null | undefined,
  stats: TelegramPostStats,
  peerId: (peer: unknown) => string,
): string | null {
  let attachments: any[];
  try {
    attachments = JSON.parse(attachmentsJson || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(attachments)) return null;
  const index = attachments.findIndex(item => item?.type === 'telegram_post' || item?.is_channel_post === true);
  if (index < 0) return null;
  const current = attachments[index] || {};
  const next = { ...current };
  if (stats.views != null && Number.isFinite(Number(stats.views))) next.views = Math.max(0, Number(stats.views));
  if (stats.forwards != null && Number.isFinite(Number(stats.forwards))) next.forwards = Math.max(0, Number(stats.forwards));
  if (stats.replies) {
    if (stats.replies.replies != null) next.comments = Math.max(0, Number(stats.replies.replies) || 0);
    if (Array.isArray(stats.replies.recentRepliers)) {
      next.recent_repliers = stats.replies.recentRepliers.map(peer => peerId(peer)).filter(Boolean);
    }
    if (stats.replies.channelId != null && String(stats.replies.channelId)) {
      next.discussion_channel_id = String(stats.replies.channelId);
    }
    if (stats.replies.maxId != null) next.comments_max_id = Math.max(0, Number(stats.replies.maxId) || 0);
    // Telegram only sends read_max_id once I have read the comment thread → without it, keep the stored mark
    if (stats.replies.readMaxId != null) {
      next.comments_read_max_id = Math.max(Number(current.comments_read_max_id) || 0, Number(stats.replies.readMaxId) || 0);
    }
  }
  const changed = POST_STAT_KEYS.some(key => next[key] !== current[key])
    || JSON.stringify(next.recent_repliers || []) !== JSON.stringify(current.recent_repliers || []);
  if (!changed) return null;
  attachments[index] = next;
  return JSON.stringify(attachments);
}

/**
 * Read comments up to `readMaxId` (messages.readDiscussion) → new attachments of the channel post (null = no post card / no change).
 * The mark only moves forward: a late report that arrives old does not make the "chưa đọc" (unread) dot come back.
 */
export function withCommentsRead(attachmentsJson: string | null | undefined, readMaxId: number): string | null {
  let attachments: any[];
  try {
    attachments = JSON.parse(attachmentsJson || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(attachments)) return null;
  const index = attachments.findIndex(item => item?.type === 'telegram_post' || item?.is_channel_post === true);
  const read = Math.max(0, Math.floor(Number(readMaxId) || 0));
  if (index < 0 || !read || read <= (Number(attachments[index]?.comments_read_max_id) || 0)) return null;
  attachments[index] = { ...attachments[index], comments_read_max_id: read };
  return JSON.stringify(attachments);
}

export type DiscussionAnchor = 'top' | 'unread' | 'bottom';

export interface DiscussionWindow {
  /** messages.getReplies offset_id (0 = newest) */
  offsetId: number;
  /** messages.getReplies add_offset (negative = also fetch comments newer than offset_id) */
  addOffset: number;
  /** Where to open: the start of the thread (root post), the first unread comment, or the end (newest). */
  anchor: DiscussionAnchor;
}

/**
 * The opening page of the comments section, like Telegram Desktop (RepliesList::loadAround around the unread mark):
 *  - no comment read yet (read_inbox_max_id ≤ root message) → from the FIRST comment, root post at the top;
 *  - unread comments remain → around the first unread comment (half read above, half unread below);
 *  - everything read → the newest comments.
 * Comment ids (in the discussion group) are always larger than the root message id.
 */
export function discussionOpenWindow(rootId: number, readInboxMaxId: number, maxId: number, limit: number): DiscussionWindow {
  const root = Math.max(0, Math.floor(Number(rootId) || 0));
  const read = Math.max(Math.floor(Number(readInboxMaxId) || 0), root);
  const newest = Math.max(0, Math.floor(Number(maxId) || 0));
  const size = Math.max(1, Math.floor(Number(limit) || 1));
  if (newest > 0 && read >= newest) return { offsetId: 0, addOffset: 0, anchor: 'bottom' };
  if (read <= root) return { offsetId: root + 1, addOffset: -size, anchor: 'top' };
  return { offsetId: read + 1, addOffset: -Math.ceil(size / 2), anchor: 'unread' };
}

/**
 * Are there older / newer comments beyond the page just loaded? `ids` = the ids of the messages messages.getReplies returned for (offsetId,
 * addOffset, limit). null = this page does not check that side (e.g. loading more on the older side tells nothing about the newer side).
 */
export function discussionPageFlags(
  ids: number[],
  offsetId: number,
  addOffset: number,
  limit: number,
): { hasOlder: boolean | null; hasNewer: boolean | null } {
  const size = Math.max(1, Math.floor(Number(limit) || 1));
  if (!offsetId) return { hasOlder: ids.length >= size, hasNewer: false };
  const newerWanted = Math.min(size, Math.max(0, -Math.floor(Number(addOffset) || 0)));
  const olderWanted = size - newerWanted;
  const newer = ids.filter(id => id >= offsetId).length;
  const older = ids.length - newer;
  return {
    hasOlder: olderWanted > 0 ? older >= olderWanted : null,
    hasNewer: newerWanted > 0 ? newer >= newerWanted : null,
  };
}

export type DiscussionJoinMode = 'none' | 'join' | 'request';

export interface DiscussionAccess {
  isMember: boolean;
  /** Can send a comment right away (member, or a group that allows commenting without joining). */
  canWrite: boolean;
  /** Not a member: join directly / must send a request for an admin to approve. */
  joinMode: DiscussionJoinMode;
  /** Text shown in place of the compose box when a message cannot be sent. */
  reason: string;
}

/**
 * Who can comment in the discussion group (a Channel megagroup in `chats` of messages.getDiscussionMessage):
 * `left` = not joined, `join_to_send` = must join before sending, `join_request` = joining needs approval,
 * default permissions / sending banned.
 */
export function discussionAccess(chat: any): DiscussionAccess {
  if (!chat || chat.className === 'ChannelForbidden' || chat.className === 'ChatForbidden') {
    return { isMember: false, canWrite: false, joinMode: 'none', reason: tr('Nhóm thảo luận không còn khả dụng với tài khoản này') };
  }
  const isMember = !chat.left;
  const sendBanned = !!(chat.bannedRights?.sendMessages || chat.defaultBannedRights?.sendMessages);
  if (sendBanned && !chat.creator && !chat.adminRights) {
    return { isMember, canWrite: false, joinMode: 'none', reason: tr('Bạn không được gửi bình luận trong nhóm này') };
  }
  if (isMember) return { isMember, canWrite: true, joinMode: 'none', reason: '' };
  const joinMode: DiscussionJoinMode = chat.joinRequest ? 'request' : 'join';
  if (!chat.joinToSend) return { isMember, canWrite: true, joinMode, reason: '' };
  return {
    isMember,
    canWrite: false,
    joinMode,
    reason: joinMode === 'request'
      ? tr('Cần được quản trị viên duyệt vào nhóm thảo luận để bình luận')
      : tr('Tham gia nhóm thảo luận để bình luận'),
  };
}

/**
 * The root message of the comment thread in the discussion group: messages.getDiscussionMessage returns the opening messages (album = several messages)
 * in decreasing id order → the root = the message with the smallest id.
 */
export function discussionRoot<T extends { id?: unknown }>(messages: T[] | null | undefined): T | null {
  let root: T | null = null;
  for (const message of messages || []) {
    const id = Number(message?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (!root || id < Number(root.id)) root = message;
  }
  return root;
}
