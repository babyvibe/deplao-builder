import type { TelegramStickerItem } from './telegramStickers';

/** Một dòng trong danh sách chủ đề forum Telegram (main → renderer, lưu cả trong localStorage). */
export interface ForumTopicRow {
  /** ForumTopic.id = id tin gốc của chủ đề (không đổi). General = '1'. */
  id: string;
  forumTopicId?: string;
  rootMessageId?: string;
  title: string;
  iconEmojiId: string;
  /** Màu biểu tượng mặc định (RGB), dùng khi không có emoji tuỳ chỉnh */
  iconColor: number;
  /** Emoji tuỳ chỉnh làm biểu tượng (Document đã nhớ ở main → tải qua getStickerFile) */
  iconEmoji?: TelegramStickerItem | null;
  topMessageId: string;
  /** Giây — giờ tin mới nhất (chủ đề chưa có tin: lúc tạo) */
  topMessageDate: number;
  createdDate?: number;
  lastMessageText?: string;
  /** Tên ngắn người gửi tin mới nhất ('' = tin hệ thống / tin của mình — xem lastIsOut) */
  lastSenderName?: string;
  lastIsOut?: boolean;
  unreadCount: number;
  unreadMentionsCount?: number;
  isPinned: boolean;
  isClosed: boolean;
  isHidden?: boolean;
  isShort?: boolean;
  /** Tắt thông báo riêng của chủ đề tới (giây); null / thiếu = theo nhóm */
  muteUntil?: number | null;
  /** Thứ tự Telegram trả về (chủ đề ghim theo thứ tự ghim) */
  order?: number;
  creatorId?: string;
  creatorName?: string;
}

/** General của forum (id 1) — Telegram vẽ biểu tượng "#". */
export const FORUM_GENERAL_TOPIC_ID = '1';

export function isGeneralForumTopic(topic: Pick<ForumTopicRow, 'id'>): boolean {
  return String(topic.id) === FORUM_GENERAL_TOPIC_ID;
}

/** Chủ đề có id (một trong 3 id tương đương: id, gốc, forumTopicId — so dạng chuỗi) không. */
export function forumTopicHasId(topic: Pick<ForumTopicRow, 'id' | 'rootMessageId' | 'forumTopicId'>, id: string | null | undefined): boolean {
  if (id == null || id === '') return false;
  const key = String(id);
  return [topic.rootMessageId, topic.id, topic.forumTopicId].some((value) => value != null && value !== '' && String(value) === key);
}

/** Thứ tự như Telegram: chủ đề ghim trước (theo thứ tự ghim), còn lại tin mới nhất trước. */
export function sortForumTopics<T extends Pick<ForumTopicRow, 'isPinned' | 'order' | 'topMessageDate'>>(list: T[]): T[] {
  const orderOf = (topic: T) => (typeof topic.order === 'number' ? topic.order : Number.MAX_SAFE_INTEGER);
  return [...list].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isPinned) return orderOf(a) - orderOf(b);
    return (b.topMessageDate || 0) - (a.topMessageDate || 0) || orderOf(a) - orderOf(b);
  });
}

/** 6 màu biểu tượng chủ đề của Telegram; màu lạ / 0 → xanh mặc định. */
export const FORUM_TOPIC_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f];

export function forumTopicColor(iconColor: number | null | undefined): string {
  const value = Number(iconColor) > 0 && Number(iconColor) <= 0xffffff ? Number(iconColor) : FORUM_TOPIC_COLORS[0];
  return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * Giờ tin mới nhất (giây) như danh sách hội thoại: hôm nay → giờ, hôm qua, trong tuần → số ngày, cũ hơn → ngày / tháng
 * (khác năm thì thêm năm).
 */
export function formatForumTopicTime(seconds: number, now = new Date()): string {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Hôm qua';
  if (days < 7) return `${days} ngày`;
  // Tự ghép (toLocaleDateString của Electron cho "08-06")
  const pad = (value: number) => String(value).padStart(2, '0');
  const dayMonth = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
  return date.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth}/${pad(date.getFullYear() % 100)}`;
}

/** Badge xám như Telegram: chủ đề tắt thông báo riêng, hoặc theo nhóm (đang tắt) khi chủ đề không đặt riêng. */
export function isForumTopicMuted(topic: Pick<ForumTopicRow, 'muteUntil'>, groupMuted: boolean, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (typeof topic.muteUntil === 'number') return topic.muteUntil > nowSec;
  return groupMuted;
}

export interface ForumTopicLiveMessage {
  /** Gốc chủ đề của tin; thiếu = General */
  topicId?: string | null;
  msgId: string;
  /** ms */
  timestamp: number;
  preview: string;
  senderName: string;
  isSelf: boolean;
  isSystem?: boolean;
}

/**
 * Tin mới tới (realtime) → dòng chủ đề của tin: tin mới nhất, giờ, chưa đọc +1 (trừ tin của mình / chủ đề đang mở), như
 * Telegram mà không gọi lại API. Trả null khi không đổi gì (không có chủ đề đó, tin cũ hơn tin đang hiện).
 * `open`: forum đang mở ở khung chat (topicId null = chưa chọn chủ đề → đang xem General); null = không mở.
 */
export function applyForumTopicMessage<T extends ForumTopicRow>(
  list: T[],
  message: ForumTopicLiveMessage,
  open: { topicId: string | null } | null,
): T[] | null {
  const targetId = message.topicId ? String(message.topicId) : FORUM_GENERAL_TOPIC_ID;
  const index = list.findIndex((topic) => forumTopicHasId(topic, targetId));
  if (index < 0) return null;
  const topic = list[index];
  const date = Math.floor(Number(message.timestamp || 0) / 1000);
  const sameMessage = String(topic.topMessageId || '') === String(message.msgId);
  // Tin cũ hơn tin đang hiện (lấy bù lịch sử, đồng bộ lại sau mất mạng — Telegram đã tính vào số chưa đọc) → bỏ qua.
  // Id tin trong một nhóm tăng dần; id không phải số (tin tạm) thì chỉ so giờ.
  const newId = Number(message.msgId);
  const topId = Number(topic.topMessageId);
  const olderId = Number.isSafeInteger(newId) && Number.isSafeInteger(topId) && topId > 0 && newId <= topId;
  if (!sameMessage && (olderId || date < (topic.topMessageDate || 0))) return null;
  const isOpen = !!open && (open.topicId ? forumTopicHasId(topic, open.topicId) : isGeneralForumTopic(topic));
  const text = String(message.preview || '').replace(/\s+/g, ' ').trim();
  const next: T = {
    ...topic,
    topMessageId: String(message.msgId),
    topMessageDate: Math.max(date, sameMessage ? topic.topMessageDate || 0 : 0),
    lastMessageText: text,
    lastSenderName: message.isSelf || message.isSystem ? '' : String(message.senderName || '').trim(),
    lastIsOut: message.isSelf && !message.isSystem,
    // Mình gửi = đã đọc tới đó (như Telegram)
    unreadCount: message.isSelf ? 0 : sameMessage || isOpen ? topic.unreadCount : (topic.unreadCount || 0) + 1,
  };
  const updated = [...list];
  updated[index] = next;
  return updated;
}
