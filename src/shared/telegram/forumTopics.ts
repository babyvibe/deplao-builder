import type { TelegramStickerItem } from './telegramStickers';
import { appLocale, tr } from '../i18n';

/** One row in the Telegram forum topic list (main → renderer, also stored in localStorage). */
export interface ForumTopicRow {
  /** ForumTopic.id = id of the topic's root message (never changes). General = '1'. */
  id: string;
  forumTopicId?: string;
  rootMessageId?: string;
  title: string;
  iconEmojiId: string;
  /** Default icon colour (RGB), used when there is no custom emoji */
  iconColor: number;
  /** Custom emoji used as the icon (Document cached in main → downloaded via getStickerFile) */
  iconEmoji?: TelegramStickerItem | null;
  topMessageId: string;
  /** Seconds: time of the latest message (a topic with no messages yet: its creation time) */
  topMessageDate: number;
  createdDate?: number;
  lastMessageText?: string;
  /** Short name of the latest message's sender ('' = system message / my own message, see lastIsOut) */
  lastSenderName?: string;
  lastIsOut?: boolean;
  unreadCount: number;
  unreadMentionsCount?: number;
  isPinned: boolean;
  isClosed: boolean;
  isHidden?: boolean;
  isShort?: boolean;
  /** Mute the topic's own notifications until (seconds); null / missing = follow the group */
  muteUntil?: number | null;
  /** Order returned by Telegram (pinned topics in pin order) */
  order?: number;
  creatorId?: string;
  creatorName?: string;
}

/** The forum's General topic (id 1): Telegram draws a "#" icon. */
export const FORUM_GENERAL_TOPIC_ID = '1';

export function isGeneralForumTopic(topic: Pick<ForumTopicRow, 'id'>): boolean {
  return String(topic.id) === FORUM_GENERAL_TOPIC_ID;
}

/** Whether the topic has this id (one of 3 equivalent ids: id, root, forumTopicId; compared as strings). */
export function forumTopicHasId(topic: Pick<ForumTopicRow, 'id' | 'rootMessageId' | 'forumTopicId'>, id: string | null | undefined): boolean {
  if (id == null || id === '') return false;
  const key = String(id);
  return [topic.rootMessageId, topic.id, topic.forumTopicId].some((value) => value != null && value !== '' && String(value) === key);
}

/** Order like Telegram: pinned topics first (in pin order), the rest newest message first. */
export function sortForumTopics<T extends Pick<ForumTopicRow, 'isPinned' | 'order' | 'topMessageDate'>>(list: T[]): T[] {
  const orderOf = (topic: T) => (typeof topic.order === 'number' ? topic.order : Number.MAX_SAFE_INTEGER);
  return [...list].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isPinned) return orderOf(a) - orderOf(b);
    return (b.topMessageDate || 0) - (a.topMessageDate || 0) || orderOf(a) - orderOf(b);
  });
}

/** The 6 topic icon colours of Telegram; unknown colour / 0 → default blue. */
export const FORUM_TOPIC_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f];

export function forumTopicColor(iconColor: number | null | undefined): string {
  const value = Number(iconColor) > 0 && Number(iconColor) <= 0xffffff ? Number(iconColor) : FORUM_TOPIC_COLORS[0];
  return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * Latest message time (seconds), formatted like the conversation list: today → time of day, yesterday, within the week → number of days, older → day / month
 * (add the year if it is a different year).
 */
export function formatForumTopicTime(seconds: number, now = new Date()): string {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString(appLocale(), { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return tr('Hôm qua');
  if (days < 7) return tr('{{days}} ngày', { days });
  // Built by hand (Electron's toLocaleDateString gives "08-06")
  const pad = (value: number) => String(value).padStart(2, '0');
  const dayMonth = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
  return date.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth}/${pad(date.getFullYear() % 100)}`;
}

/** Grey badge like Telegram: the topic has its own notifications muted, or it follows the group (muted) when the topic has no setting of its own. */
export function isForumTopicMuted(topic: Pick<ForumTopicRow, 'muteUntil'>, groupMuted: boolean, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (typeof topic.muteUntil === 'number') return topic.muteUntil > nowSec;
  return groupMuted;
}

export interface ForumTopicLiveMessage {
  /** Topic root of the message; missing = General */
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
 * New incoming message (realtime) → the topic row for the message: latest message, time, unread +1 (except my own messages / the open topic), like
 * Telegram, without calling the API again. Returns null when nothing changes (no such topic, or the message is older than the one shown).
 * `open`: the forum is open in the chat pane (topicId null = no topic chosen yet → viewing General); null = not open.
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
  // Older than the message shown (history backfill, resync after a network drop; Telegram already counted it in the unread count) → skip.
  // Message IDs in a group increase; a non-numeric id (temporary message) is compared by time only.
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
    // My own sent message = read up to there (like Telegram)
    unreadCount: message.isSelf ? 0 : sameMessage || isOpen ? topic.unreadCount : (topic.unreadCount || 0) + 1,
  };
  const updated = [...list];
  updated[index] = next;
  return updated;
}
