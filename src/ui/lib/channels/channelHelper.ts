/**
 * channelHelper.ts: shared channel detection utilities + constants
 *
 * Instead of repeating `channel === 'telegram_bot' || channel === 'telegram_user'`
 * in 20+ files, use these helpers.
 *
 * Design principle: UI should check capability (channelSupports) instead of the channel name.
 * But when a specific channel must be checked (API routing, choosing an adapter), use the helpers here.
 */

import { type Channel, channelSupports, getCapability, type ChannelCapability } from '../../../configs/channels/channelConfig';

// ─── Channel constants — single source of truth cho string literals ───────────
// Use CHANNEL.ZALO instead of 'zalo' to avoid typos and make refactoring easier.

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

/** Non-Zalo = must use an adapter instead of ipc.zalo */
export function isNonZalo(ch?: string): boolean {
  return (ch || CHANNEL.ZALO) !== CHANNEL.ZALO;
}

// ─── Resolve channel ─────────────────────────────────────────────────────────

/**
 * The channel of the conversation. Telegram / Facebook accounts only have conversations on the same channel, so the ACCOUNT's channel wins: the
 * contacts.channel column defaulted to 'zalo' and was once written wrongly (e.g. the My Documents of a Telegram account), and a pinned conversation loads late by id when it
 * is not in the store (no contact). Zalo accounts or unknown accounts: the conversation's channel, defaulting to Zalo.
 */
export function resolveChannel(
  contact?: { channel?: string | null } | null,
  account?: { channel?: string | null } | null,
): Channel {
  const accountChannel = account?.channel;
  if (accountChannel && accountChannel !== CHANNEL.ZALO) return accountChannel as Channel;
  return (contact?.channel || accountChannel || CHANNEL.ZALO) as Channel;
}

// ─── Capability-based helpers ────────────────────────────────────────────────

/**
 * Checks whether a feature is supported for the channel.
 * A more compact wrapper of channelSupports().
 */
export function supports(ch: Channel, feature: keyof ChannelCapability): boolean {
  return channelSupports(ch, feature);
}

/**
 * Gets the capability object for the channel.
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
 * Helper for the common pattern: "only call the Zalo API when the channel is Zalo".
 * Returns true if it should skip (not Zalo).
 *
 * Usage:
 *   if (shouldSkipZaloApi(ch)) return;
 *   await ipc.zalo?.someMethod(...)
 */
export function shouldSkipZaloApi(ch?: string): boolean {
  return (ch || CHANNEL.ZALO) !== CHANNEL.ZALO;
}

/**
 * Helper for the pattern: "use the adapter for non-Zalo, ipc.zalo for Zalo".
 * Returns true if the adapter should be used.
 */
export function shouldUseAdapter(ch?: string): boolean {
  return (ch || CHANNEL.ZALO) !== CHANNEL.ZALO;
}
