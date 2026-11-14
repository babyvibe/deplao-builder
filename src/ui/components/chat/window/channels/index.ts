/**
 * Registry of the per-channel parts of the chat window. To add a channel: write `channels/<channel>/chatWindow.ts` (ChatWindowChannel, declaring only
 * what the channel does differently), then add it to CHANNELS; a dedicated hook for opening a conversation (if any) is called from
 * useChannelThreadSync. Unregistered channel: the chat window only reads the DB.
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

/** Unregistered channel: nothing special (DB only) */
const DB_ONLY: ChatWindowChannel = {};

/** The channel's own part. No channel = Zalo (same as isZalo). */
export function chatWindowChannel(channel?: string | null): ChatWindowChannel {
  return CHANNELS[channel || CHANNEL.ZALO] || DB_ONLY;
}

/**
 * Per-channel work when opening a conversation (the hook is always called and skips itself when it is not its channel; the call order
 * does not change between renders). Telegram: forum topic messages, fixing old data, syncing reactions.
 */
export function useChannelThreadSync(deps: ThreadSyncDeps): void {
  useTelegramThreadSync(deps);
}

export type { ChatWindowChannel, ThreadSyncDeps } from './types';
