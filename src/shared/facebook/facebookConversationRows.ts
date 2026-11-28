/**
 * Facebook rows of the `contacts` table that are not conversations.
 *
 * Senders in a group are saved as contacts for their name / picture (group bubbles look them up); they are not chats and
 * showed up at the bottom of the conversation list with no message and no time.
 */
export type FacebookConversationRowFields = {
  channel?: string | null;
  contact_type?: string | null;
  last_message?: string | null;
  last_message_time?: number | null;
  unread_count?: number | null;
};

/** A Facebook person that never had a message in a 1-1 chat with the account. Groups are always conversations. */
export function isFacebookProfileOnlyRow(row: FacebookConversationRowFields | null | undefined): boolean {
  if (!row || row.channel !== 'facebook' || row.contact_type === 'group') return false;
  return !Number(row.last_message_time)
    && !String(row.last_message || '').trim()
    && !Number(row.unread_count);
}
