/**
 * Telegram User rows of the `contacts` table that are not conversations.
 *
 * The table also stores people only for their name / avatar (senders in a group whose profile the renderer saved). Telegram never
 * lists such people among chats; Deplao showed them at the bottom of the conversation list with no message and no time (1,551
 * rows on one account), and opening one that turned out to have a private chat loaded its history and made it jump up the list.
 */
export type TelegramConversationRowFields = {
  channel?: string | null;
  contact_type?: string | null;
  last_message?: string | null;
  last_message_time?: number | null;
  unread_count?: number | null;
  /** Set together with telegram_state_updated_at by every dialog sync (persistTelegramDialogState). */
  telegram_peer_type?: string | null;
  telegram_state_updated_at?: number | null;
};

/**
 * A Telegram User person that was never a dialog: no dialog state, no message, no unread. Groups and channels are always
 * conversations (they only enter the table from a dialog, a message or a join).
 */
export function isTelegramProfileOnlyRow(row: TelegramConversationRowFields | null | undefined): boolean {
  if (!row || row.channel !== 'telegram_user' || row.contact_type === 'group') return false;
  return !Number(row.last_message_time)
    && !String(row.last_message || '').trim()
    && !Number(row.unread_count)
    && !row.telegram_peer_type
    && !Number(row.telegram_state_updated_at);
}
