import { getTelegramMessagePreview } from '../messages/TelegramMessagePreview';
import type { ForumTopicRow } from '../../../shared/telegram/forumTopics';

/**
 * Danh sách chủ đề forum như Telegram, từ kết quả messages.getForumTopics:
 * - dòng tin mới nhất của chủ đề: người gửi + nội dung + giờ của TIN đó (`topics[].topMessage` → `messages`).
 *   ForumTopic.date là ngày TẠO chủ đề — trước đây dùng nhầm nên giờ và thứ tự trong danh sách sai;
 * - `order` = thứ tự Telegram trả (chủ đề ghim theo thứ tự ghim, còn lại tin mới trước);
 * - biểu tượng: emoji tuỳ chỉnh (Document lấy qua getCustomEmojiDocuments) hoặc màu iconColor;
 * - tắt thông báo riêng của chủ đề (`muteUntil`, null = theo cài đặt của nhóm).
 */

type Normalize = (message: any) => { content: string; msgType: string };

function peerRef(peer: any): { kind: 'user' | 'chat'; id: string } | null {
  if (!peer) return null;
  if (peer.userId != null) return { kind: 'user', id: String(peer.userId) };
  if (peer.channelId != null) return { kind: 'chat', id: String(peer.channelId) };
  if (peer.chatId != null) return { kind: 'chat', id: String(peer.chatId) };
  return null;
}

/** Tên ngắn như dòng xem trước của Telegram: tên (first name) của người, tiêu đề của nhóm / kênh. */
function peerShortName(peer: any, users: Map<string, any>, chats: Map<string, any>): string {
  const ref = peerRef(peer);
  if (!ref) return '';
  if (ref.kind === 'user') {
    const user = users.get(ref.id);
    return String(user?.firstName || user?.lastName || user?.username || '').trim();
  }
  return String(chats.get(ref.id)?.title || '').trim();
}

/** Tin mới nhất của chủ đề → dòng xem trước. Tin hệ thống (tạo / ghim / đổi tên…) đã có tên người làm → không thêm "Tên:". */
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
  // Không có người gửi (quản trị viên ẩn danh, nhóm tự gửi) → tên nhóm, như Telegram
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
      // ForumTopic.id = gốc chủ đề (không đổi); topMessage = tin mới nhất hiện có trong chủ đề
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
