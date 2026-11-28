/**
 * Member count of a Telegram group or channel from a GetFullChannel / GetFullChat answer.
 *
 * Channels and supergroups: ChannelFull.participantsCount. Basic groups: ChatFull carries no count, so the participant
 * list of the same answer decides, then the fresh Chat object in its `chats`. The entity passed in comes last: it can be a
 * cached copy from when the account joined (a new group then showed "1 member").
 */
export function telegramParticipantsCount(fullChat: any, entity?: any, chats?: readonly any[], chatId?: string): number {
  const listed = fullChat?.participants?.participants;
  const freshChat = basicGroupChat(chats, chatId);
  const candidates = [
    fullChat?.participantsCount,
    Array.isArray(listed) ? listed.length : undefined,
    freshChat?.participantsCount,
    entity?.participantsCount,
  ];
  for (const value of candidates) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) return Math.floor(count);
  }
  return 0;
}

/** The Chat object of a basic group in a GetFullChat answer (`chats`), matched by id when one is given. */
export function basicGroupChat(chats: readonly any[] | undefined, chatId?: string): any | null {
  if (!Array.isArray(chats) || chats.length === 0) return null;
  const wanted = chatId ? String(chatId).replace(/^-100/, '').replace(/^-/, '') : '';
  const isChat = (item: any) => item && (item.className === 'Chat' || item.className === 'ChatForbidden');
  if (wanted) return chats.find((item) => isChat(item) && String(item.id) === wanted) || null;
  return chats.find(isChat) || null;
}
