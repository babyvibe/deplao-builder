/**
 * Receiving status of a Telegram bot (getUpdates): shared by main (TelegramBotIngressService) and the UI.
 *
 * Telegram allows only ONE caller of getUpdates per bot: a second one (OpenClaw, a bot server, Deplao on another machine…) makes
 * Deplao get error 409. Then Deplao pauses (it does not compete for messages) until the user clicks Reconnect.
 */

/** Pause reason: conflict = another place receives the messages (409); unauthorized = token revoked (401); not_found = bot deleted (404). */
import { tr } from '../i18n';

export type BotPauseReason = 'conflict' | 'unauthorized' | 'not_found';
export type BotPollState = 'polling' | BotPauseReason | 'stopped';

/** reason of event:disconnected, by pause reason. */
export const BOT_DISCONNECT_REASON: Record<BotPauseReason, string> = {
  conflict: 'bot_poll_conflict',
  unauthorized: 'token_invalid',
  not_found: 'bot_not_found',
};

/** Message shown to the user when the bot stops receiving messages (null = another reason, use the general message). */
export function botDisconnectMessage(reason: string | undefined, botName: string): string | null {
  const name = botName || 'Telegram';
  switch (reason) {
    case BOT_DISCONNECT_REASON.conflict:
      return tr('Bot {{name}} đang nhận tin ở nơi khác (vd OpenClaw). Tắt nơi đó rồi bấm Kết nối lại.', { name });
    case BOT_DISCONNECT_REASON.unauthorized:
      return tr('Token của bot {{name}} không còn dùng được. Kết nối lại bot bằng token mới.', { name });
    case BOT_DISCONNECT_REASON.not_found:
      return tr('Không tìm thấy bot {{name}} trên Telegram. Kết nối lại bot bằng token mới.', { name });
    default:
      return null;
  }
}
