/** Shared Telegram identity contract. Keep MTProto peer identity separate from
 * renderer conversation contacts: a peer may be a group member or a resolved
 * username without being a conversation in the inbox. */
export type TelegramPeerType = 'user' | 'basic_group' | 'supergroup' | 'channel' | 'forum';

export interface TelegramPeer {
  accountId: string;
  peerId: string;
  peerType: TelegramPeerType;
  accessHash?: string;
  username?: string;
  displayName?: string;
  phone?: string;
  avatarUrl?: string;
}

/** A topic root identifies a separate timeline inside a forum parent peer. */
export interface TelegramMessageContext {
  accountId: string;
  peerId: string;
  topicRootMessageId?: string | null;
  messageId: string;
  senderPeerId?: string;
}

/** IPC-safe parent-peer context. `chatId` is a marked Telegram peer ID. */
export interface TelegramChatContext {
  accountId: string;
  chatId: string;
}

/** IPC-safe forum context. The root/top message ID is deliberately named so
 * it cannot be confused with Telegram's separate ForumTopic metadata ID. */
export interface TelegramForumTopicContext extends TelegramChatContext {
  topicRootMessageId: string;
}
