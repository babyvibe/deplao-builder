/**
 * Phần bình luận của bài đăng kênh Telegram (nhóm thảo luận): gộp các trang bình luận (tải thêm cũ hơn / làm mới định kỳ),
 * thứ tự như Telegram (cũ ở trên, mới ở dưới), và cập nhật số bình luận của bài trong kênh.
 */

export interface DiscussionCommentLike {
  msg_id: string;
  timestamp: number;
  local_paths?: string;
  /** Tin vừa gửi từ ô soạn tin (MessageQueue): id tạm, gửi xong có real_msg_id */
  temp_id?: string;
  real_msg_id?: string;
}

/** Tin vừa gửi chưa có bản thật từ Telegram (id tạm). */
export function isPendingComment(comment: DiscussionCommentLike): boolean {
  return !!comment.temp_id && !/^\d+$/.test(String(comment.msg_id));
}

/**
 * Người bình luận là người dùng Telegram: bấm ảnh / tên mở hồ sơ như trong nhóm. Bình luận gửi dưới danh nghĩa nhóm / kênh
 * (quản trị viên ẩn danh, kênh tự đăng) có sender_kind 'chat' và id âm: không phải người, không mở hồ sơ.
 */
export function isUserCommentSender(comment: { sender_id?: string | null; sender_kind?: string }): boolean {
  return comment.sender_kind !== 'chat' && /^\d+$/.test(String(comment.sender_id || ''));
}

function parseObject(value: unknown): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function compareComments(a: DiscussionCommentLike, b: DiscussionCommentLike): number {
  return (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0)
    || (Number(a.msg_id) || 0) - (Number(b.msg_id) || 0);
}

/**
 * Gộp bình luận theo msg_id: bản mới thay bản cũ (sửa / cảm xúc), đường dẫn file đã tải giữ lại từ cả hai, sắp cũ → mới.
 */
export function mergeDiscussionComments<T extends DiscussionCommentLike>(current: T[], incoming: T[]): T[] {
  // Tin vừa gửi (id tạm) mà bản thật đã về → bỏ bản tạm (không hiện 2 lần)
  const incomingIds = new Set(incoming.map((comment) => String(comment.msg_id)));
  const byId = new Map<string, T>();
  for (const comment of current) {
    if (comment.real_msg_id && incomingIds.has(String(comment.real_msg_id))) continue;
    byId.set(String(comment.msg_id), comment);
  }
  for (const comment of incoming) {
    const id = String(comment.msg_id);
    const previous = byId.get(id);
    if (!previous) {
      byId.set(id, comment);
      continue;
    }
    const paths = { ...parseObject(previous.local_paths), ...parseObject(comment.local_paths) };
    byId.set(id, { ...previous, ...comment, local_paths: JSON.stringify(paths) });
  }
  return Array.from(byId.values()).sort(compareComments);
}

/** id bình luận cũ nhất đã tải (offset để tải trang cũ hơn); không có → 0. */
export function oldestCommentId(comments: DiscussionCommentLike[]): number {
  let oldest = 0;
  for (const comment of comments) {
    const id = Number(comment.msg_id);
    if (Number.isSafeInteger(id) && id > 0 && (!oldest || id < oldest)) oldest = id;
  }
  return oldest;
}

/**
 * attachments của bài đăng kênh với số bình luận mới (đếm thật từ phần bình luận) — null khi không có thẻ bài / không đổi.
 */
export function withPostCommentCount(attachmentsJson: string | null | undefined, total: number): string | null {
  let attachments: any[];
  try {
    attachments = JSON.parse(attachmentsJson || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(attachments)) return null;
  const index = attachments.findIndex((item) => item?.type === 'telegram_post' || item?.is_channel_post === true);
  if (index < 0) return null;
  const count = Math.max(0, Math.floor(Number(total) || 0));
  if (Number(attachments[index]?.comments || 0) === count) return null;
  attachments[index] = { ...attachments[index], comments: count };
  return JSON.stringify(attachments);
}

/** Bình luận chưa đọc đầu tiên đã tải (id > mốc đã đọc lúc mở) — chỗ đặt vạch "Bình luận chưa đọc"; không có → null. */
export function firstUnreadCommentId(comments: DiscussionCommentLike[], readMaxId: number | null | undefined): string | null {
  const read = Number(readMaxId) || 0;
  if (read <= 0) return null;
  let first: number | null = null;
  for (const comment of comments) {
    const id = Number(comment.msg_id);
    if (Number.isSafeInteger(id) && id > read && (first === null || id < first)) first = id;
  }
  return first === null ? null : String(first);
}

interface ReactionShape {
  total: number;
  lastReact: string;
  emoji: Record<string, { total: number; users: Record<string, number> }>;
}

/**
 * Cảm xúc của mình trên một bình luận (Telegram: mỗi người một cảm xúc) — hiện ngay khi bấm, trước khi Telegram trả số
 * chính thức (event:telegramReaction thay lại). `emoji` rỗng = gỡ. Trả JSON mới (định dạng { total, lastReact, emoji }).
 */
export function setOwnReaction(reactionsJson: string | null | undefined, userId: string, emoji: string): string {
  let parsed: any = null;
  try {
    parsed = typeof reactionsJson === 'string' ? JSON.parse(reactionsJson || '{}') : reactionsJson;
  } catch {
    parsed = null;
  }
  const current: ReactionShape = parsed && typeof parsed === 'object' && parsed.emoji && typeof parsed.emoji === 'object'
    ? JSON.parse(JSON.stringify(parsed))
    : { total: 0, lastReact: '', emoji: {} };
  for (const key of Object.keys(current.emoji)) {
    const entry = current.emoji[key];
    if (!entry?.users?.[userId]) continue;
    delete entry.users[userId];
    entry.total = Math.max(0, (Number(entry.total) || 0) - 1);
    current.total = Math.max(0, (Number(current.total) || 0) - 1);
    if (entry.total <= 0) delete current.emoji[key];
  }
  if (emoji) {
    const entry = current.emoji[emoji] || { total: 0, users: {} };
    entry.total = (Number(entry.total) || 0) + 1;
    entry.users = { ...(entry.users || {}), [userId]: 1 };
    current.emoji[emoji] = entry;
    current.total = (Number(current.total) || 0) + 1;
    current.lastReact = emoji;
  }
  return JSON.stringify(current);
}
