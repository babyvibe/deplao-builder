/**
 * channelConfig.ts - Single Source of Truth for the features of each chat channel
 * Used by the UI to decide which features to show/hide, and by the IPC facade to route API calls.
 */

export type Channel = 'zalo' | 'facebook' | 'telegram_bot' | 'telegram_user';

export interface ChannelCapability {
  // ─── Channel info ─────────────────────────────────────────
  id: Channel;
  label: string;
  icon: string;
  color: string;

  // ─── Conversation type ──────────────────────────────────────
  supportsDM: boolean;
  supportsGroup: boolean;

  // ─── Message features ─────────────────────────────────────
  supportsText: boolean;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsFile: boolean;
  supportsAudio: boolean;
  supportsGif: boolean;
  supportsSticker: boolean;
  supportsPoll: boolean;
  supportsReminder: boolean;
  supportsReply: boolean;
  supportsReaction: boolean;
  supportsUnsend: boolean;
  supportsForward: boolean;
  supportsPin: boolean;
  supportsEdit: boolean;           // Edit a sent message

  // ─── Zalo-only features ──────────────────────────────────────
  supportsBusinessCard: boolean;
  supportsBankCard: boolean;
  /** Product catalog (Zalo Business, SRS ZL-04); the button only shows when the account is zBusiness. */
  supportsProductCatalog: boolean;
  supportsTextStyle: boolean;
  supportsAlias: boolean;        // Aliases (Zalo API)
  supportsMuteSync: boolean;     // Sync mute to the server
  supportsPinConversation: boolean; // Pin a conversation (Zalo API)
  supportsCreateGroup: boolean;  // Create a group from users
  supportsMutualGroups: boolean; // Common groups
  supportsBlock: boolean;        // Block a user
  supportsReport: boolean;       // Report abuse
  supportsRemoveFriend: boolean; // Delete friend

  // ─── Group management ──────────────────────────────────────────
  supportsGroupRename: boolean;
  supportsGroupEmoji: boolean;
  supportsGroupNickname: boolean;
  supportsGroupLink: boolean;
  supportsGroupAdmin: boolean;
  supportsGroupBoard: boolean;
  supportsGroupLock: boolean;

  // ─── CRM & Social ──────────────────────────────────────────
  supportsFriendRequest: boolean;
  supportsLabel: boolean;
  supportsSeenStatus: boolean;
  supportsTypingIndicator: boolean;
  supportsCRMSearch: boolean;
  supportsCRMHistory: boolean;
  supportsCRMPhoneImport: boolean;
  supportsCRMGroups: boolean;
  supportsScanData: boolean;

  // ─── Additional capabilities ───────────────────────────────
  supportsChangeGroupAvatar: boolean;
  supportsGroupManage: boolean;
  supportsPendingApproval: boolean;
  supportsLeaveGroup: boolean;
  supportsGroupReload: boolean;
  supportsQuickMessages: boolean;
  supportsInviteToGroup: boolean;
  supportsCampaigns: boolean;

  // ─── Sign in ─────────────────────────────────────────────
  loginMethods: ('qr' | 'cookie' | 'auth_json' | 'credentials' | 'phone_otp')[];

  // ─── Template message sync mode ──────────────────────────
  quickMessageSyncMode: 'remote' | 'local';  // remote = synced from the server, local = local only
}

export const CHANNEL_CONFIG: Record<Channel, ChannelCapability> = {
  zalo: {
    id: 'zalo',
    label: 'Zalo',
    icon: 'zalo',
    color: '#0068FF',

    supportsDM: true,
    supportsGroup: true,

    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsFile: true,
    supportsAudio: true,
    supportsGif: true,
    supportsSticker: true,
    supportsPoll: true,
    supportsReminder: true,
    supportsReply: true,
    supportsReaction: true,
    supportsUnsend: true,
    supportsForward: true,
    supportsPin: true,
    supportsEdit: false,             // Zalo does not support edit

    supportsBusinessCard: true,
    supportsBankCard: true,
    supportsProductCatalog: true,
    supportsTextStyle: true,
    supportsAlias: true,
    supportsMuteSync: true,
    supportsPinConversation: true,
    supportsCreateGroup: true,
    supportsMutualGroups: true,
    supportsBlock: true,
    supportsReport: true,
    supportsRemoveFriend: true,

    supportsGroupRename: true,
    supportsGroupEmoji: true,
    supportsGroupNickname: true,
    supportsGroupLink: true,
    supportsGroupAdmin: true,
    supportsGroupBoard: true,
    supportsGroupLock: true,

    supportsFriendRequest: true,
    supportsLabel: true,
    supportsSeenStatus: true,
    supportsTypingIndicator: true,
    supportsCRMSearch: true,
    supportsCRMHistory: true,
    supportsCRMPhoneImport: true,
    supportsCRMGroups: true,
    supportsScanData: false,

    loginMethods: ['qr', 'cookie', 'auth_json'],

    supportsChangeGroupAvatar: true,
    supportsGroupManage: true,
    supportsPendingApproval: true,
    supportsLeaveGroup: true,
    supportsGroupReload: true,
    supportsQuickMessages: true,
    supportsInviteToGroup: true,
    supportsCampaigns: true,
    quickMessageSyncMode: 'remote',
  },

  facebook: {
    id: 'facebook',
    label: 'Facebook Messenger',
    icon: 'facebook',
    color: '#1877F2',

    supportsDM: true,
    supportsGroup: true,

    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsFile: true,
    supportsAudio: true,
    // No Facebook GIF picker yet; stickers = recently used stickers + like (fb:getRecentStickers / fb:sendSticker)
    supportsGif: false,
    supportsSticker: true,
    supportsPoll: true,
    supportsReminder: false,
    supportsReply: true,
    supportsReaction: true,
    supportsUnsend: true,
    supportsForward: true,
    supportsPin: true,    supportsEdit: true,              // Facebook: editMessage
    supportsBusinessCard: false,
    supportsBankCard: false,
    supportsProductCatalog: false,
    supportsTextStyle: false,
    supportsAlias: true,
    supportsMuteSync: false,
    supportsPinConversation: false,
    supportsCreateGroup: true,
    supportsMutualGroups: false,
    supportsBlock: true,
    supportsReport: false,
    supportsRemoveFriend: false,

    supportsGroupRename: true,
    // Emoji / nickname / group link have main-process calls but no screen yet
    supportsGroupEmoji: false,
    supportsGroupNickname: false,
    supportsGroupLink: false,
    supportsGroupAdmin: true,
    supportsGroupBoard: false,
    supportsGroupLock: false,

    supportsFriendRequest: false,
    supportsLabel: false,
    supportsSeenStatus: true,
    supportsTypingIndicator: true,
    supportsCRMSearch: false,
    supportsCRMHistory: false,
    supportsCRMPhoneImport: false,
    supportsCRMGroups: false,
    supportsScanData: true,

    loginMethods: ['cookie', 'credentials'],

    supportsChangeGroupAvatar: true,
    supportsGroupManage: false,
    supportsPendingApproval: false,
    supportsLeaveGroup: true,
    supportsGroupReload: false,
    supportsQuickMessages: false,
    supportsInviteToGroup: false,
    // Message campaigns only (CRMQueueService): the Facebook API here has no friend request / group invite campaign action.
    supportsCampaigns: true,
    quickMessageSyncMode: 'local',
  },

  telegram_bot: {
    id: 'telegram_bot',
    label: 'Telegram Bot',
    icon: 'telegram',
    color: '#0088CC',

    supportsDM: true,
    supportsGroup: true,

    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsFile: true,
    supportsAudio: true,
    supportsGif: true,
    supportsSticker: true,
    supportsPoll: true,              // Bot API: sendPoll
    supportsReminder: false,
    supportsReply: true,
    supportsReaction: true,          // Bot API 7.0+: setMessageReaction
    supportsUnsend: true,            // Bot API: deleteMessage
    supportsForward: true,           // Bot API: forwardMessage
    supportsPin: true,               // Bot API: pinChatMessage
    supportsEdit: true,              // Bot API: editMessageText

    supportsBusinessCard: false,
    supportsBankCard: false,
    supportsProductCatalog: false,
    supportsTextStyle: false,
    supportsAlias: false,
    supportsMuteSync: false,
    supportsPinConversation: false,
    supportsCreateGroup: false,      // Bot can't create groups
    supportsMutualGroups: false,
    supportsBlock: false,            // Bot can't block users
    supportsReport: false,
    supportsRemoveFriend: false,

    supportsGroupRename: true,       // Bot API: setChatTitle
    supportsGroupEmoji: false,
    supportsGroupNickname: false,
    supportsGroupLink: true,         // Bot API: exportChatInviteLink
    supportsGroupAdmin: true,        // Bot API: promoteChatMember
    supportsGroupBoard: false,
    supportsGroupLock: false,

    supportsFriendRequest: false,
    supportsLabel: false,
    supportsSeenStatus: false,       // Bot can't mark as read
    supportsTypingIndicator: false,  // Bot can't send typing
    supportsCRMSearch: false,
    supportsCRMHistory: true,
    supportsCRMPhoneImport: false,
    // Only show the groups the Bot has received updates from / knows about.
    supportsCRMGroups: true,
    supportsScanData: false,

    supportsChangeGroupAvatar: true, // Bot API: setChatPhoto
    supportsGroupManage: true,       // Bot API: banChatMember, etc.
    supportsPendingApproval: false,
    supportsLeaveGroup: true,        // Bot API: leaveChat
    supportsGroupReload: false,
    supportsQuickMessages: true,     // Local-only feature
    supportsInviteToGroup: true,     // Bot API: invite link
    // Only run message campaigns to the chats the Bot knows.
    supportsCampaigns: true,
    quickMessageSyncMode: 'local',

    loginMethods: ['credentials'],  // botToken
  },

  telegram_user: {
    id: 'telegram_user',
    label: 'Telegram',
    icon: 'telegram',
    color: '#0088CC',

    supportsDM: true,
    supportsGroup: true,

    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsFile: true,
    supportsAudio: true,
    supportsGif: true,
    supportsSticker: true,
    supportsPoll: false,             // no MTProto poll send implementation yet
    supportsReminder: false,
    supportsReply: true,
    supportsReaction: true,          // MTProto: messages.SendReaction
    supportsUnsend: true,
    supportsForward: true,
    supportsPin: true,               // MTProto: messages.PinMessage
    supportsEdit: true,              // MTProto: messages.editMessage

    supportsBusinessCard: false,
    supportsBankCard: false,
    supportsProductCatalog: false,
    supportsTextStyle: false,
    supportsAlias: false,
    supportsMuteSync: false,
    supportsPinConversation: true,
    supportsCreateGroup: false,
    supportsMutualGroups: false,
    supportsBlock: true,             // MTProto: contacts.Block/Unblock
    supportsReport: false,
    supportsRemoveFriend: false,

    supportsGroupRename: true,
    supportsGroupEmoji: false,
    supportsGroupNickname: false,
    supportsGroupLink: true,
    supportsGroupAdmin: true,
    supportsGroupBoard: true,        // MTProto: Telegram Topics/forum mode
    supportsGroupLock: false,

    supportsFriendRequest: false,
    supportsLabel: false,
    supportsSeenStatus: true,
    supportsTypingIndicator: true,
    supportsCRMSearch: false,
    supportsCRMHistory: true,
    supportsCRMPhoneImport: false,
    supportsCRMGroups: true,
    supportsScanData: false,

    supportsChangeGroupAvatar: true,
    supportsGroupManage: true,
    supportsPendingApproval: false,
    supportsLeaveGroup: true,
    supportsGroupReload: false,
    supportsQuickMessages: true,     // Local-only feature
    supportsInviteToGroup: true,
    supportsCampaigns: true,
    quickMessageSyncMode: 'local',

    loginMethods: ['phone_otp'],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getCapability(channel: Channel): ChannelCapability {
  return CHANNEL_CONFIG[channel];
}

export function channelSupports(channel: Channel, feature: keyof ChannelCapability): boolean {
  return !!(CHANNEL_CONFIG[channel] as any)[feature];
}

export function getAllChannels(): Channel[] {
  return Object.keys(CHANNEL_CONFIG) as Channel[];
}

export function getChannelLabel(channel: Channel): string {
  return CHANNEL_CONFIG[channel].label;
}

export function getChannelColor(channel: Channel): string {
  return CHANNEL_CONFIG[channel].color;
}

/**
 * Normalize the channel string: handles legacy data that only has 'zalo'/'facebook'.
 * Used for workflows, DB records, imported data.
 */
export function normalizeChannel(ch?: string): Channel {
  if (ch && ch in CHANNEL_CONFIG) return ch as Channel;
  return 'zalo'; // default legacy
}

/**
 * Safely get the channel from an account object.
 * Old accounts may have no channel field → default 'zalo'.
 */
export function resolveAccountChannel(account: { channel?: string }): Channel {
  return normalizeChannel(account.channel);
}
