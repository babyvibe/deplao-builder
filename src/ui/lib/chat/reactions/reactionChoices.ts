import React from 'react';
import ipc from '@/lib/ipc';
import { EMOJI_TO_REACTION } from '@/lib/chat/messages/emojiUtils';
import { isFacebook, isTelegram } from '@/lib/channels/channelHelper';
import { DEFAULT_TELEGRAM_REACTIONS, normalizeTelegramReaction } from '../../../../shared/telegram/telegramReactions';

/**
 * Reaction list per channel: shared by the hover pickers and the right-click menu.
 * - The 6 reactions shown by default are in the SAME ORDER on every channel (REACTION_SLOTS), Zalo's order: like, heart, haha,
 *   wow, sad, angry. Zalo's horizontal bar and the right-click menu read left to right; Telegram's column starts at the button.
 * - Zalo: only the types Zalo has (EMOJI_TO_REACTION); other emoji are sent as ❤️.
 * - Facebook (Messenger accepts every emoji): the 6 default Messenger reactions.
 * - Telegram: the conversation's real list (useTelegramChatReactions): strings exactly as Telegram (heart is "❤").
 */
const unique = (items: readonly string[]) => [...new Set(items)];

/**
 * Shared order: one meaning per slot, with each channel's correct emoji. Zalo draws haha 😆 (code ":>") and cry 😭 (":-(("),
 * Messenger 😆 / 😢 and angry 😠, Telegram 😁 (no 😆) and 😱 for wow (no 😮).
 */
export const REACTION_SLOTS = [
  { slot: 'like', zalo: '👍', facebook: '👍', telegram: '👍' },
  { slot: 'heart', zalo: '❤️', facebook: '❤️', telegram: '❤' },
  { slot: 'haha', zalo: '😆', facebook: '😆', telegram: '😁' },
  { slot: 'wow', zalo: '😮', facebook: '😮', telegram: '😱' },
  { slot: 'sad', zalo: '😭', facebook: '😢', telegram: '😢' },
  { slot: 'angry', zalo: '😡', facebook: '😠', telegram: '😡' },
] as const;

// Zalo / Facebook: keep the few reactions as before (6), the long list is only for Telegram
export const ZALO_QUICK_REACTIONS: string[] = REACTION_SLOTS.map((reaction) => reaction.zalo);
export const ZALO_ALL_REACTIONS = unique(ZALO_QUICK_REACTIONS.filter((emoji) => !!EMOJI_TO_REACTION[emoji]));
export const FACEBOOK_QUICK_REACTIONS: string[] = REACTION_SLOTS.map((reaction) => reaction.facebook);
export const FACEBOOK_ALL_REACTIONS = [...FACEBOOK_QUICK_REACTIONS];
/** Telegram: number of reactions shown by default (right-click menu before the expand button, hover column before scrolling). */
export const TELEGRAM_QUICK_COUNT = 6;
/**
 * Telegram's default reactions: fixed, in the same order as Zalo / Facebook, not taken directly from the personalised "frequently used" list of Telegram
 * (which once produced 🍌 / 👎...). Strings exactly as Telegram (heart is "❤").
 */
export const TELEGRAM_PREFERRED_QUICK: string[] = REACTION_SLOTS.map((reaction) => reaction.telegram);

export function getReactionChoices(channel: string | undefined, telegramReactions: readonly string[]): { quick: string[]; all: string[] } {
  if (isTelegram(channel)) {
    // A group / channel allows only some reactions → drop the ones not allowed, fill up with the next allowed reactions
    const allowed = new Set(telegramReactions);
    const quick = TELEGRAM_PREFERRED_QUICK.filter((emoji) => allowed.has(emoji));
    for (const emoji of telegramReactions) {
      if (quick.length >= TELEGRAM_QUICK_COUNT) break;
      if (!quick.includes(emoji)) quick.push(emoji);
    }
    return { quick, all: unique([...quick, ...telegramReactions]) };
  }
  if (isFacebook(channel)) return { quick: FACEBOOK_QUICK_REACTIONS, all: FACEBOOK_ALL_REACTIONS };
  return { quick: ZALO_QUICK_REACTIONS, all: ZALO_ALL_REACTIONS };
}

/** The same reaction even when the display variant differs ("❤" / "❤️"). */
export function sameReaction(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normalizeTelegramReaction(a) === normalizeTelegramReaction(b);
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; reactions: string[] }>();
const inflight = new Map<string, Promise<string[] | null>>();

/**
 * Reactions allowed in the open Telegram conversation. Defaults to the standard list; `load()` (called when the picker / right-click menu opens,
 * NOT when each message is drawn) asks main once per 10 minutes per conversation. A group with reactions turned off → [].
 */
export function useTelegramChatReactions(accountId: string | null | undefined, chatId: string | null | undefined, enabled: boolean) {
  const key = enabled && accountId && chatId ? `${accountId}:${chatId}` : '';
  const keyRef = React.useRef(key);
  keyRef.current = key;
  const [reactions, setReactions] = React.useState<readonly string[]>(() => (key && cache.get(key)?.reactions) || DEFAULT_TELEGRAM_REACTIONS);

  React.useEffect(() => {
    setReactions((key && cache.get(key)?.reactions) || DEFAULT_TELEGRAM_REACTIONS);
  }, [key]);

  const load = React.useCallback(() => {
    if (!key || !accountId || !chatId) return;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setReactions(cached.reactions);
      return;
    }
    let task = inflight.get(key);
    if (!task) {
      const request = ipc.telegramUser?.getAvailableReactions?.({ accountId, chatId });
      task = (request || Promise.resolve(null))
        .then((result) => (result?.success && Array.isArray(result.reactions) ? result.reactions : null))
        .catch(() => null)
        .finally(() => { inflight.delete(key); });
      inflight.set(key, task);
    }
    void task.then((list) => {
      if (!list) return;
      cache.set(key, { at: Date.now(), reactions: list });
      if (keyRef.current === key) setReactions(list);
    });
  }, [key, accountId, chatId]);

  return { reactions, load };
}

/** Telegram's own default quick reaction (when the account's setting is unknown or a Premium custom emoji). */
export const TELEGRAM_DEFAULT_QUICK_REACTION = '👍';
const QUICK_TTL_MS = 6 * 60 * 60 * 1000;
const quickCache = new Map<string, { at: number; emoji: string }>();
const quickInflight = new Map<string, Promise<string>>();

/** The account's quick reaction (Telegram settings → Quick Reaction): read once per 6 hours, 👍 until known. */
export function loadTelegramQuickReaction(accountId: string | null | undefined): Promise<string> {
  if (!accountId) return Promise.resolve(TELEGRAM_DEFAULT_QUICK_REACTION);
  const cached = quickCache.get(accountId);
  if (cached && Date.now() - cached.at < QUICK_TTL_MS) return Promise.resolve(cached.emoji);
  let task = quickInflight.get(accountId);
  if (!task) {
    const request = ipc.telegramUser?.getQuickReaction?.({ accountId });
    task = (request || Promise.resolve(null))
      .then((result) => {
        const emoji = result?.success && result.emoji ? normalizeTelegramReaction(result.emoji) : TELEGRAM_DEFAULT_QUICK_REACTION;
        // Not connected yet / error: keep 👍 for now, ask again next time
        if (result?.success) quickCache.set(accountId, { at: Date.now(), emoji });
        return emoji;
      })
      .catch(() => TELEGRAM_DEFAULT_QUICK_REACTION)
      .finally(() => { quickInflight.delete(accountId); });
    quickInflight.set(accountId, task);
  }
  return task;
}

/** Quick reaction known so far (no request). */
export function cachedTelegramQuickReaction(accountId: string | null | undefined): string {
  return (accountId && quickCache.get(accountId)?.emoji) || TELEGRAM_DEFAULT_QUICK_REACTION;
}

/** The quick reaction for the open Telegram conversation: 👍 until the account's setting is read (on first hover / double-click). */
export function useTelegramQuickReaction(accountId: string | null | undefined, enabled: boolean) {
  const [emoji, setEmoji] = React.useState(() => cachedTelegramQuickReaction(accountId));
  React.useEffect(() => { setEmoji(cachedTelegramQuickReaction(accountId)); }, [accountId]);
  const load = React.useCallback(() => {
    if (!enabled || !accountId) return Promise.resolve(TELEGRAM_DEFAULT_QUICK_REACTION);
    return loadTelegramQuickReaction(accountId).then((value) => {
      setEmoji(value);
      return value;
    });
  }, [accountId, enabled]);
  return { emoji, load };
}

/** Test only. */
export function __resetTelegramReactionCache(): void {
  cache.clear();
  inflight.clear();
  quickCache.clear();
  quickInflight.clear();
}
