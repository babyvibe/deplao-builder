/**
 * The comments section of a Telegram channel post (discussion group): merges the comment pages (loading older ones / periodic refresh),
 * in Telegram's order (oldest on top, newest at the bottom), and updates the comment count of the post in the channel.
 */

export interface DiscussionCommentLike {
  msg_id: string;
  timestamp: number;
  local_paths?: string;
  /** Message just sent from the composer (MessageQueue): temporary id, real_msg_id once sent */
  temp_id?: string;
  real_msg_id?: string;
}

/** Message just sent that has no real copy from Telegram yet (temporary id). */
export function isPendingComment(comment: DiscussionCommentLike): boolean {
  return !!comment.temp_id && !/^\d+$/.test(String(comment.msg_id));
}

/**
 * The commenter is a Telegram user: tapping the photo / name opens the profile, as in the group. Comments sent in the name of the group / channel
 * (anonymous admin, channel auto-posts) have sender_kind 'chat' and a negative id: not a person, they do not open a profile.
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
 * Merges comments by msg_id: the newer copy replaces the older one (edit / reaction), the downloaded file paths are kept from both, sorted old → new.
 */
export function mergeDiscussionComments<T extends DiscussionCommentLike>(current: T[], incoming: T[]): T[] {
  // A message just sent (temporary id) whose real copy has arrived → drop the temp copy (so it does not show twice)
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

/** id of the oldest comment loaded (offset for loading older pages); none → 0. */
export function oldestCommentId(comments: DiscussionCommentLike[]): number {
  let oldest = 0;
  for (const comment of comments) {
    const id = Number(comment.msg_id);
    if (Number.isSafeInteger(id) && id > 0 && (!oldest || id < oldest)) oldest = id;
  }
  return oldest;
}

/**
 * The attachments of the channel post with the new comment count (counted from the comments section); null when there is no post card / nothing changed.
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

/** First unread comment loaded (id > the read mark when opened): where the "Bình luận chưa đọc" (Unread comments) divider goes; none → null. */
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
 * My reaction on a comment (Telegram: one reaction per person): shown at once when tapped, before Telegram returns the
 * official count (event:telegramReaction replaces it later). An empty `emoji` = remove. Returns a new JSON (format { total, lastReact, emoji }).
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
