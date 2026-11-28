/**
 * `event:messagesSynced`: a bulk sync finished on the machine that keeps the account's connection (the Boss). Its messages were written
 * straight into that machine's DB, without one event per message: Zalo "Đồng bộ từ điện thoại", "Đồng bộ tin nhắn Facebook", the
 * Telegram sync (button or catch-up after a reconnect). Relayed to the employees assigned to the account, who reload its conversation
 * list and the open conversation (renderer: hooks/chat/useMessagesSyncedReload). The Boss reloads from the sync buttons' own progress
 * events (event:mobileSync / event:fbHistorySync / event:telegramSync, Boss-only).
 */

export type MessagesSyncSource = 'zalo_mobile' | 'facebook_history' | 'telegram';

export interface MessagesSyncedEvent {
  /** accounts.zalo_id of the account (Zalo / Facebook / Telegram): the relay sends the event to the employees assigned to it. */
  zaloId: string;
  source: MessagesSyncSource;
  /** New messages the sync saved. */
  inserted: number;
}
