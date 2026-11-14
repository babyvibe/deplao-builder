/**
 * Replied / not replied state of a conversation, shared by main (DatabaseService.getContactsFiltered → the `is_replied` column)
 * and the renderer (updated when a new message arrives, when the conversation opens, and by the "Chưa trả lời" (not replied) filter).
 *
 * Rule: based on the conversation's latest REAL message. If it is mine (sent from the app or another machine) = replied (1). If it is from the other person =
 * not replied (0). No real message yet = unknown (null). System notices, OA broadcasts, Page template messages and deleted messages
 * are not counted. "Chưa trả lời" (not replied) only applies to 1:1 conversations: in a group, the last message from someone else is not a question waiting for me.
 *
 * Manual replied mark (by hand / in bulk, no message needed): contacts.reply_marked_at = the time of the latest message when it was marked. A message from the other person
 * that arrives AFTER this mark turns the conversation back into "not replied" by itself.
 *
 * Previously the state was only kept in memory (reopening the app lost it), older messages loaded later and system messages also changed the state, and
 * the "Chưa trả lời" (not replied) filter was really a "chưa đọc" (unread) filter.
 */

/** A message type that does not show who is waiting for whom. */
export const REPLY_STATE_IGNORED_MSG_TYPES: readonly string[] = [
  'system', 'chat.webcontent', 'chat.webcontent.v2', 'fb.template', 'deleted',
];

const IGNORED = new Set(REPLY_STATE_IGNORED_MSG_TYPES);

export function countsForReplyState(msgType: unknown): boolean {
  return !IGNORED.has(String(msgType ?? ''));
}

/**
 * SQL column for the contacts table (alias `alias`): replied according to the conversation's latest real message: 1 / 0, NULL when there is no real message yet. `withMarked`: the table has the reply_marked_at column (manual replied mark); messages older than or equal to the mark count as replied.
 * Looked up through the index messages(owner_zalo_id, thread_id, timestamp): ~10 ms for a page of 200 conversations.
 */
export function contactReplyStateSql(alias = 'contacts', withMarked = true): string {
  const types = REPLY_STATE_IGNORED_MSG_TYPES.map((type) => `'${type}'`).join(', ');
  const state = withMarked
    ? `CASE WHEN m.is_sent = 1 OR m.timestamp <= COALESCE(${alias}.reply_marked_at, 0) THEN 1 ELSE 0 END`
    : 'm.is_sent';
  return `(SELECT ${state} FROM messages m
    WHERE m.owner_zalo_id = ${alias}.owner_zalo_id AND m.thread_id = ${alias}.contact_id
      AND COALESCE(m.msg_type, '') NOT IN (${types})
    ORDER BY m.timestamp DESC LIMIT 1)`;
}

/** 1:1 conversation whose latest real message is from the other person. */
export function isUnrepliedConversation(contact: { is_replied?: number | null; contact_type?: string | null } | null | undefined): boolean {
  return !!contact && contact.is_replied === 0 && contact.contact_type !== 'group';
}

/** Currently "đã trả lời" (replied) only because of a manual mark (the last message is still from the other person) → allows "Đánh dấu chưa trả lời" (mark as not replied). */
export function isManuallyMarkedReplied(contact: { is_replied?: number | null; reply_marked_at?: number | null } | null | undefined): boolean {
  return !!contact && contact.is_replied === 1 && Number(contact.reply_marked_at) > 0;
}

/**
 * State from the loaded messages (old → new or new → old both work): 1 / 0 / null when there is no real message yet. `markedAt`:
 * the manual replied mark time (reply_marked_at). The other person's messages that are not newer than this mark count as replied.
 */
export function replyStateFromMessages(
  messages: ReadonlyArray<{ msg_id?: string | number | null; msg_type?: string | null; is_sent?: number | boolean | null; timestamp?: number | string | null }> | null | undefined,
  markedAt?: number | null,
): 0 | 1 | null {
  let latest: { ts: number; sent: boolean } | null = null;
  for (const message of messages || []) {
    if (!message) continue;
    const id = String(message.msg_id ?? '');
    if (id.startsWith('temp_') || id.startsWith('retry_')) continue; // sending: counted once the send has finished
    if (!countsForReplyState(message.msg_type)) continue;
    const ts = Number(message.timestamp) || 0;
    if (!latest || ts >= latest.ts) latest = { ts, sent: message.is_sent === 1 || message.is_sent === true };
  }
  if (!latest) return null;
  if (latest.sent) return 1;
  const marked = Number(markedAt) || 0;
  return marked > 0 && latest.ts <= marked ? 1 : 0;
}

/**
 * Does an incoming message change the state: only a real message that is the conversation's newest (old messages loaded later / history do not change
 * the state. Before, catching up the other person's messages after I had replied turned the conversation into "chưa trả lời" (not replied)).
 */
export function replyStateForIncoming(
  message: { msgType?: unknown; timestamp?: unknown; isSelf?: boolean; silent?: boolean },
  currentLastMessageTime: unknown,
): 0 | 1 | undefined {
  if (message.silent || !countsForReplyState(message.msgType)) return undefined;
  const ts = Number(message.timestamp) || 0;
  const current = Number(currentLastMessageTime) || 0;
  if (ts > 0 && current > 0 && ts < current) return undefined;
  return message.isSelf ? 1 : 0;
}
