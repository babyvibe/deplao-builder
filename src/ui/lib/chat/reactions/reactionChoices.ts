import React from 'react';
import ipc from '@/lib/ipc';
import { EMOJI_TO_REACTION } from '@/lib/chat/messages/emojiUtils';
import { isFacebook, isTelegram } from '@/lib/channels/channelHelper';
import { DEFAULT_TELEGRAM_REACTIONS, normalizeTelegramReaction } from '../../../../shared/telegram/telegramReactions';

/**
 * Danh sách reaction theo kênh — dùng chung cho thanh chọn khi rê chuột và menu chuột phải.
 * - 6 reaction hiện sẵn CÙNG THỨ TỰ ở mọi kênh (REACTION_SLOTS): tim, haha, wow, buồn, phẫn nộ, thích. Thanh rê chuột:
 *   reaction đầu sát nút nhất; menu chuột phải: trái sang phải.
 * - Zalo: chỉ các loại Zalo có (EMOJI_TO_REACTION) — emoji khác bị gửi thành ❤️ (trước đây 😆 / 😯 ở menu chuột phải).
 * - Facebook (Messenger nhận mọi emoji): 6 reaction mặc định của Messenger.
 * - Telegram: danh sách thật của hội thoại (useTelegramChatReactions) — chuỗi đúng như Telegram (tim là "❤").
 */
const unique = (items: readonly string[]) => [...new Set(items)];

/**
 * Thứ tự chung: mỗi ô một ý, emoji đúng của từng kênh. Haha: Zalo 😄 (mã ":>"), Messenger 😆, Telegram 😁 (không có
 * 😄 / 😆); phẫn nộ của Messenger là 😠; Telegram không có 😮 nên "wow" là 😱. Trước đây Telegram một thứ tự riêng
 * (👍 😁 ❤ 😢 👏 😡), Zalo / Facebook một thứ tự khác.
 */
export const REACTION_SLOTS = [
  { slot: 'heart', zalo: '❤️', facebook: '❤️', telegram: '❤' },
  { slot: 'haha', zalo: '😄', facebook: '😆', telegram: '😁' },
  { slot: 'wow', zalo: '😮', facebook: '😮', telegram: '😱' },
  { slot: 'sad', zalo: '😢', facebook: '😢', telegram: '😢' },
  { slot: 'angry', zalo: '😡', facebook: '😠', telegram: '😡' },
  { slot: 'like', zalo: '👍', facebook: '👍', telegram: '👍' },
] as const;

// Zalo / Facebook: giữ ít reaction như cũ (6), danh sách dài chỉ dành cho Telegram
export const ZALO_QUICK_REACTIONS: string[] = REACTION_SLOTS.map((reaction) => reaction.zalo);
export const ZALO_ALL_REACTIONS = unique(ZALO_QUICK_REACTIONS.filter((emoji) => !!EMOJI_TO_REACTION[emoji]));
export const FACEBOOK_QUICK_REACTIONS: string[] = REACTION_SLOTS.map((reaction) => reaction.facebook);
export const FACEBOOK_ALL_REACTIONS = [...FACEBOOK_QUICK_REACTIONS];
/** Telegram: số reaction hiện sẵn (menu chuột phải trước nút mở rộng, thanh rê chuột trước khi cuộn). */
export const TELEGRAM_QUICK_COUNT = 6;
/**
 * Reaction hiện sẵn của Telegram: cố định, cùng thứ tự Zalo / Facebook, không dùng thẳng danh sách "hay dùng" Telegram cá
 * nhân hoá (từng ra 🍌 / 👎…). Chuỗi đúng như Telegram (tim là "❤").
 */
export const TELEGRAM_PREFERRED_QUICK: string[] = REACTION_SLOTS.map((reaction) => reaction.telegram);

export function getReactionChoices(channel: string | undefined, telegramReactions: readonly string[]): { quick: string[]; all: string[] } {
  if (isTelegram(channel)) {
    // Nhóm / kênh chỉ cho một số reaction → bỏ cái không được phép, bù bằng reaction được phép kế tiếp
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

/** Cùng một reaction dù khác biến thể hiển thị ("❤" / "❤️"). */
export function sameReaction(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normalizeTelegramReaction(a) === normalizeTelegramReaction(b);
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; reactions: string[] }>();
const inflight = new Map<string, Promise<string[] | null>>();

/**
 * Reaction dùng được trong hội thoại Telegram đang mở. Mặc định danh sách chuẩn; `load()` (gọi khi mở thanh chọn / menu
 * chuột phải, KHÔNG gọi khi vẽ từng tin) hỏi main 1 lần / 10 phút / hội thoại. Nhóm tắt reaction → [].
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

/** Chỉ dùng trong test. */
export function __resetTelegramReactionCache(): void {
  cache.clear();
  inflight.clear();
}
