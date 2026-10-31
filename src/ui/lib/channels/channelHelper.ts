/**
 * channelHelper.ts — Shared channel detection utilities + constants
 *
 * Thay vì lặp `channel === 'telegram_bot' || channel === 'telegram_user'`
 * ở 20+ file, dùng các helper này.
 *
 * Design principle: UI nên check capability (channelSupports) thay vì check channel name.
 * Nhưng khi cần check channel cụ thể (routing API, chọn adapter), dùng helper ở đây.
 */

import { type Channel, channelSupports, getCapability, type ChannelCapability } from '../../../configs/channels/channelConfig';

// ─── Channel constants — single source of truth cho string literals ───────────
// Dùng CHANNEL.ZALO thay vì 'zalo' để tránh typo và dễ refactor.

export const CHANNEL = {
  ZALO: 'zalo',
  FACEBOOK: 'facebook',
  TELEGRAM_BOT: 'telegram_bot',
  TELEGRAM_USER: 'telegram_user',
} as const;

export type ChannelKey = typeof CHANNEL[keyof typeof CHANNEL];

// ─── Channel type checks ─────────────────────────────────────────────────────

export function isZalo(ch?: string): boolean {
  return (ch || CHANNEL.ZALO) === CHANNEL.ZALO;
}

export function isFacebook(ch?: string): boolean {
  return ch === CHANNEL.FACEBOOK;
}

export function isTelegram(ch?: string): boolean {
  return ch === CHANNEL.TELEGRAM_BOT || ch === CHANNEL.TELEGRAM_USER;
}

export function isTelegramBot(ch?: string): boolean {
  return ch === CHANNEL.TELEGRAM_BOT;
}

export function isTelegramUser(ch?: string): boolean {
  return ch === CHANNEL.TELEGRAM_USER;
}

/** Non-Zalo = cần dùng adapter thay vì ipc.zalo */
export function isNonZalo(ch?: string): boolean {
  return (ch || CHANNEL.ZALO) !== CHANNEL.ZALO;
}

// ─── Resolve channel ─────────────────────────────────────────────────────────

/**
 * Resolve channel từ contact + account, ưu tiên contact.channel.
 * Dùng trong component khi cần channel mà không muốn lặp logic.
 */
export function resolveChannel(contact?: { channel?: string }, account?: { channel?: string }): Channel {
  return ((contact?.channel || account?.channel || CHANNEL.ZALO) as Channel);
}

// ─── Capability-based helpers ────────────────────────────────────────────────

/**
 * Kiểm tra feature có được hỗ trợ cho channel không.
 * Wrapper gọn hơn channelSupports().
 */
export function supports(ch: Channel, feature: keyof ChannelCapability): boolean {
  return channelSupports(ch, feature);
}

/**
 * Lấy capability object cho channel.
 */
export function getCap(ch: Channel): ChannelCapability {
  return getCapability(ch);
}

// ─── Telegram Forum helpers ──────────────────────────────────────────────────

/**
 * Telegram Forum: General topic (ForumTopic.id = 1) is the normal supergroup
 * timeline — NOT a reply thread. Only topics with id != 1 are threads that
 * use GetReplies / InputReplyToMessage.topMsgId.
 *
 * When this returns true, the caller should use ordinary history/send
 * semantics instead of topic-specific paths.
 *
 * @param topicId The activeTopicId stored in chatStore (root message id or forum topic id)
 */
export function isTelegramForumGeneral(topicId?: string | null): boolean {
  return topicId === '1' || topicId === 'general';
}

// ─── Common pattern helpers ──────────────────────────────────────────────────

/**
 * Helper cho pattern phổ biến: "chỉ gọi Zalo API khi channel là Zalo".
 * Trả về true nếu nên skip (không phải Zalo).
 *
 * Usage:
 *   if (shouldSkipZaloApi(ch)) return;
 *   await ipc.zalo?.someMethod(...)
 */
export function shouldSkipZaloApi(ch?: string): boolean {
  return (ch || CHANNEL.ZALO) !== CHANNEL.ZALO;
}

/**
 * Helper cho pattern: "dùng adapter cho non-Zalo, ipc.zalo cho Zalo".
 * Trả về true nếu nên dùng adapter.
 */
export function shouldUseAdapter(ch?: string): boolean {
  return (ch || CHANNEL.ZALO) !== CHANNEL.ZALO;
}
