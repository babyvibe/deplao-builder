/**
 * Đăng ký phần riêng từng kênh của khung chat. Thêm kênh: viết `channels/<kênh>/chatWindow.ts` (ChatWindowChannel, chỉ
 * khai báo những gì kênh làm khác) rồi thêm vào CHANNELS; hook riêng khi mở hội thoại (nếu có) gọi trong
 * useChannelThreadSync. Kênh chưa đăng ký: khung chat chỉ đọc DB.
 */
import { CHANNEL } from '@/lib/channels/channelHelper';
import type { ChatWindowChannel, ThreadSyncDeps } from './types';
import { zaloChatWindow } from './zalo/chatWindow';
import { telegramBotChatWindow, telegramUserChatWindow } from './telegram/chatWindow';
import { facebookChatWindow } from './facebook/chatWindow';
import { useTelegramThreadSync } from './telegram/useTelegramThreadSync';

const CHANNELS: Record<string, ChatWindowChannel> = {
  [CHANNEL.ZALO]: zaloChatWindow,
  [CHANNEL.TELEGRAM_USER]: telegramUserChatWindow,
  [CHANNEL.TELEGRAM_BOT]: telegramBotChatWindow,
  [CHANNEL.FACEBOOK]: facebookChatWindow,
};

/** Kênh không đăng ký: không có gì riêng (chỉ DB) */
const DB_ONLY: ChatWindowChannel = {};

/** Phần riêng của kênh. Không có kênh = Zalo (như isZalo). */
export function chatWindowChannel(channel?: string | null): ChatWindowChannel {
  return CHANNELS[channel || CHANNEL.ZALO] || DB_ONLY;
}

/**
 * Việc riêng của từng kênh khi mở hội thoại (hook luôn được gọi, tự bỏ qua khi không phải kênh của mình; thứ tự gọi
 * không đổi giữa các lần vẽ). Telegram: tin topic forum, sửa dữ liệu cũ, đồng bộ cảm xúc.
 */
export function useChannelThreadSync(deps: ThreadSyncDeps): void {
  useTelegramThreadSync(deps);
}

export type { ChatWindowChannel, ThreadSyncDeps } from './types';
