/**
 * Bài đăng kênh Telegram (như Telegram): số liệu bài (lượt xem / chia sẻ / bình luận) làm mới bằng
 * messages.getMessagesViews, và bình luận — nằm trong NHÓM THẢO LUẬN gắn với kênh, không phải trong kênh.
 *
 * Trước đây bình luận lấy bằng messages.getReplies rồi lưu như tin của KÊNH (topic_id = id bài): id bình luận (dãy id của
 * nhóm) trùng id bài kênh → INSERT bị bỏ (thiếu bình luận), UPDATE ghi đè topic / trả lời của bài kênh trùng id (770 bài
 * bị hỏng), bình luận chuẩn hoá theo kiểu kênh nên hiện thành thẻ "BÀI ĐĂNG KÊNH", thứ tự ngược, người gửi là nhóm thì "U".
 */

export interface TelegramPostStats {
  views?: number | null;
  forwards?: number | null;
  replies?: {
    replies?: number | null;
    recentRepliers?: unknown[] | null;
    channelId?: unknown;
    /** Bình luận mới nhất / đã đọc tới (chấm "chưa đọc" trên thanh bình luận, như Telegram) */
    maxId?: number | null;
    readMaxId?: number | null;
  } | null;
}

const POST_STAT_KEYS = ['views', 'forwards', 'comments', 'discussion_channel_id', 'comments_max_id', 'comments_read_max_id'];

/**
 * Gộp số liệu mới vào attachment `telegram_post` (JSON của cột attachments). Trả về JSON mới, hoặc null khi không có
 * attachment bài đăng hay không có gì đổi. `peerId` chuyển Peer của người bình luận gần đây thành id chuẩn.
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
    // Telegram chỉ gửi read_max_id khi mình đã từng đọc chuỗi bình luận → không có thì giữ mốc đang lưu
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
 * Đã đọc bình luận tới `readMaxId` (messages.readDiscussion) → attachments mới của bài kênh (null = không có thẻ bài /
 * không đổi). Mốc chỉ tăng — lượt báo cũ về muộn không làm chấm "chưa đọc" hiện lại.
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
  /** messages.getReplies offset_id (0 = mới nhất) */
  offsetId: number;
  /** messages.getReplies add_offset (âm = lấy cả bình luận mới hơn offset_id) */
  addOffset: number;
  /** Mở ở đâu: đầu chuỗi (bài gốc), bình luận chưa đọc đầu tiên, hay cuối (mới nhất). */
  anchor: DiscussionAnchor;
}

/**
 * Trang mở đầu của phần bình luận, như Telegram Desktop (RepliesList::loadAround quanh mốc chưa đọc):
 *  - chưa đọc bình luận nào (read_inbox_max_id ≤ tin gốc) → từ bình luận ĐẦU TIÊN, bài gốc ở trên cùng;
 *  - còn bình luận chưa đọc → quanh bình luận chưa đọc đầu tiên (nửa trang đã đọc ở trên, nửa chưa đọc ở dưới);
 *  - đã đọc hết → các bình luận mới nhất.
 * Id bình luận (trong nhóm thảo luận) luôn lớn hơn id tin gốc.
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
 * Còn bình luận cũ hơn / mới hơn ngoài trang vừa tải? `ids` = id các tin messages.getReplies trả về cho (offsetId,
 * addOffset, limit). null = trang này không xét phía đó (vd tải thêm phía cũ thì không biết gì thêm về phía mới).
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
  /** Gửi bình luận được ngay (thành viên, hoặc nhóm cho bình luận không cần tham gia). */
  canWrite: boolean;
  /** Chưa là thành viên: tham gia thẳng / phải gửi yêu cầu cho quản trị viên duyệt. */
  joinMode: DiscussionJoinMode;
  /** Câu hiện thay ô soạn tin khi không gửi được. */
  reason: string;
}

/**
 * Ai được bình luận trong nhóm thảo luận (Channel megagroup trong `chats` của messages.getDiscussionMessage):
 * `left` = chưa tham gia, `join_to_send` = phải tham gia mới gửi được, `join_request` = tham gia cần duyệt,
 * quyền mặc định / bị cấm gửi tin.
 */
export function discussionAccess(chat: any): DiscussionAccess {
  if (!chat || chat.className === 'ChannelForbidden' || chat.className === 'ChatForbidden') {
    return { isMember: false, canWrite: false, joinMode: 'none', reason: 'Nhóm thảo luận không còn khả dụng với tài khoản này' };
  }
  const isMember = !chat.left;
  const sendBanned = !!(chat.bannedRights?.sendMessages || chat.defaultBannedRights?.sendMessages);
  if (sendBanned && !chat.creator && !chat.adminRights) {
    return { isMember, canWrite: false, joinMode: 'none', reason: 'Bạn không được gửi bình luận trong nhóm này' };
  }
  if (isMember) return { isMember, canWrite: true, joinMode: 'none', reason: '' };
  const joinMode: DiscussionJoinMode = chat.joinRequest ? 'request' : 'join';
  if (!chat.joinToSend) return { isMember, canWrite: true, joinMode, reason: '' };
  return {
    isMember,
    canWrite: false,
    joinMode,
    reason: joinMode === 'request'
      ? 'Cần được quản trị viên duyệt vào nhóm thảo luận để bình luận'
      : 'Tham gia nhóm thảo luận để bình luận',
  };
}

/**
 * Tin gốc của chuỗi bình luận trong nhóm thảo luận: messages.getDiscussionMessage trả các tin mở đầu (album = nhiều tin)
 * theo id giảm dần → gốc = tin có id nhỏ nhất.
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
