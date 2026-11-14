import { getTelegramMessagePreview } from '../messages/TelegramMessagePreview';
import type { ForumTopicRow } from '../../../shared/telegram/forumTopics';

/**
 * Forum topic list like Telegram, from the messages.getForumTopics result:
 * - the topic's latest message line: the sender + content + time of THAT message (`topics[].topMessage` → `messages`).
 *   ForumTopic.date is the topic's CREATION date; previously it was used by mistake, so the times and order in the list were wrong;
 * - `order` = Telegram's order (pinned topics in pin order, the rest newest message first);
 * - icon: a custom emoji (Document fetched via getCustomEmojiDocuments) or the iconColor;
 * - the topic's own mute setting (`muteUntil`, null = follows the group's setting).
 */

type Normalize = (message: any) => { content: string; msgType: string };

function peerRef(peer: any): { kind: 'user' | 'chat'; id: string } | null {
  if (!peer) return null;
  if (peer.userId != null) return { kind: 'user', id: String(peer.userId) };
  if (peer.channelId != null) return { kind: 'chat', id: String(peer.channelId) };
  if (peer.chatId != null) return { kind: 'chat', id: String(peer.chatId) };
  return null;
}

/** Short name as in Telegram's preview line: the person's first name, or the group / channel title. */
function peerShortName(peer: any, users: Map<string, any>, chats: Map<string, any>): string {
  const ref = peerRef(peer);
  if (!ref) return '';
  if (ref.kind === 'user') {
    const user = users.get(ref.id);
    return String(user?.firstName || user?.lastName || user?.username || '').trim();
  }
  return String(chats.get(ref.id)?.title || '').trim();
}

/** The topic's latest message → preview line. System messages (created / pinned / renamed…) already have the actor's name, so no "Tên:" (Name:) prefix is added. */
export function forumTopicLastMessage(
  message: any,
  users: Map<string, any>,
  chats: Map<string, any>,
  normalize: Normalize,
): { text: string; senderName: string; isOut: boolean; date: number } | null {
  if (!message || message.className === 'MessageEmpty') return null;
  const { content, msgType } = normalize(message);
  const text = getTelegramMessagePreview(msgType, content).replace(/\s+/g, ' ').trim();
  const isService = message.className === 'MessageService' || msgType === 'system';
  const isOut = !!message.out && !isService;
  // No sender (anonymous admin, group posting as itself) → the group name, as in Telegram
  const senderName = isOut || isService
    ? ''
    : peerShortName(message.fromId, users, chats) || peerShortName(message.peerId, users, chats);
  return { text, senderName, isOut, date: Number(message.date || 0) };
}

export function mapForumTopics(result: any, normalize: Normalize, iconEmoji: Map<string, any> = new Map()): ForumTopicRow[] {
  const users = new Map<string, any>((result?.users || []).map((user: any) => [String(user.id), user]));
  const chats = new Map<string, any>((result?.chats || []).map((chat: any) => [String(chat.id), chat]));
  const messages = new Map<string, any>((result?.messages || []).map((message: any) => [String(message.id), message]));
  return (result?.topics || [])
    .filter((topic: any) => topic && topic.className !== 'ForumTopicDeleted')
    .map((topic: any, order: number): ForumTopicRow => {
      // ForumTopic.id = the topic's root (does not change); topMessage = the latest message in the topic
      const id = String(topic.id || '');
      const emojiId = topic.iconEmojiId ? String(topic.iconEmojiId) : '';
      const last = forumTopicLastMessage(messages.get(String(topic.topMessage || '')), users, chats, normalize);
      const creatorId = String(topic.fromId?.userId || '');
      const creator = users.get(creatorId);
      const muteUntil = topic.notifySettings?.muteUntil;
      return {
        id,
        forumTopicId: id,
        rootMessageId: id,
        title: String(topic.title || ''),
        iconEmojiId: emojiId,
        iconColor: Number(topic.iconColor || 0),
        iconEmoji: emojiId ? iconEmoji.get(emojiId) || null : null,
        topMessageId: String(topic.topMessage || ''),
        topMessageDate: last?.date || Number(topic.date || 0),
        createdDate: Number(topic.date || 0),
        lastMessageText: last?.text || '',
        lastSenderName: last?.senderName || '',
        lastIsOut: !!last?.isOut,
        unreadCount: Number(topic.unreadCount || 0),
        unreadMentionsCount: Number(topic.unreadMentionsCount || 0),
        isPinned: !!topic.pinned,
        isClosed: !!topic.closed,
        isHidden: !!topic.hidden,
        isShort: !!topic.short,
        muteUntil: typeof muteUntil === 'number' ? muteUntil : null,
        order,
        creatorId,
        creatorName: creator ? [creator.firstName, creator.lastName].filter(Boolean).join(' ') : '',
      };
    });
}
