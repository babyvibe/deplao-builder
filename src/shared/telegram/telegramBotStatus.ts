/**
 * Trạng thái nhận tin của bot Telegram (getUpdates) — dùng chung main (TelegramBotIngressService) và giao diện.
 *
 * Telegram chỉ cho MỘT nơi gọi getUpdates của một bot: nơi thứ hai (OpenClaw, bot server, Deplao trên máy khác…) làm
 * Deplao nhận lỗi 409. Khi đó Deplao tạm dừng (không giành tin) tới khi người dùng bấm Kết nối lại.
 */

/** Lý do tạm dừng: conflict = nơi khác nhận tin (409); unauthorized = token bị thu hồi (401); not_found = bot bị xoá (404). */
export type BotPauseReason = 'conflict' | 'unauthorized' | 'not_found';
export type BotPollState = 'polling' | BotPauseReason | 'stopped';

/** reason của event:disconnected theo lý do tạm dừng. */
export const BOT_DISCONNECT_REASON: Record<BotPauseReason, string> = {
  conflict: 'bot_poll_conflict',
  unauthorized: 'token_invalid',
  not_found: 'bot_not_found',
};

/** Thông báo cho người dùng khi bot dừng nhận tin (null = lý do khác, dùng thông báo chung). */
export function botDisconnectMessage(reason: string | undefined, botName: string): string | null {
  const name = botName || 'Telegram';
  switch (reason) {
    case BOT_DISCONNECT_REASON.conflict:
      return `Bot ${name} đang nhận tin ở nơi khác (vd OpenClaw). Tắt nơi đó rồi bấm Kết nối lại.`;
    case BOT_DISCONNECT_REASON.unauthorized:
      return `Token của bot ${name} không còn dùng được. Kết nối lại bot bằng token mới.`;
    case BOT_DISCONNECT_REASON.not_found:
      return `Không tìm thấy bot ${name} trên Telegram. Kết nối lại bot bằng token mới.`;
    default:
      return null;
  }
}
