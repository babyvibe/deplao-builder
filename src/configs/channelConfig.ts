/**
 * channelConfig.ts — Single Source of Truth cho tính năng từng kênh chat
 * Dùng bởi UI để quyết định hiển thị/ẩn tính năng, bởi IPC facade để route API calls.
 */

export type Channel = 'zalo' | 'facebook';

export interface ChannelCapability {
  // ─── Thông tin kênh ─────────────────────────────────────────
  id: Channel;
  label: string;
  icon: string;
  color: string;

  // ─── Loại cuộc trò chuyện ──────────────────────────────────
  supportsDM: boolean;
  supportsGroup: boolean;

  // ─── Tính năng tin nhắn ─────────────────────────────────────
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

  // ─── Tính năng chỉ Zalo ──────────────────────────────────────
  supportsBusinessCard: boolean;
  supportsBankCard: boolean;
  supportsTextStyle: boolean;
  supportsAlias: boolean;        // Biệt danh (Zalo API)
  supportsMuteSync: boolean;     // Đồng bộ mute lên server
  supportsPinConversation: boolean; // Ghim hội thoại (Zalo API)
  supportsCreateGroup: boolean;  // Tạo nhóm từ user
  supportsMutualGroups: boolean; // Nhóm chung
  supportsBlock: boolean;        // Chặn user
  supportsReport: boolean;       // Báo xấu
  supportsRemoveFriend: boolean; // Xoá bạn

  // ─── Quản lý nhóm ──────────────────────────────────────────
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

  // ─── Đăng nhập ─────────────────────────────────────────────
  loginMethods: ('qr' | 'cookie' | 'auth_json' | 'credentials')[];
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

    supportsBusinessCard: true,
    supportsBankCard: true,
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

    loginMethods: ['qr', 'cookie', 'auth_json'],
  },

  facebook: {
    id: 'facebook',
    label: 'Facebook',
    icon: 'facebook',
    color: '#1877F2',

    supportsDM: true,
    supportsGroup: true,

    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsFile: true,
    supportsAudio: true,
    supportsGif: true,
    supportsSticker: false,
    supportsPoll: false,
    supportsReminder: false,
    supportsReply: true,
    supportsReaction: true,
    supportsUnsend: true,
    supportsForward: false,
    supportsPin: false,

    supportsBusinessCard: false,
    supportsBankCard: false,
    supportsTextStyle: false,
    supportsAlias: false,
    supportsMuteSync: false,
    supportsPinConversation: false,
    supportsCreateGroup: false,
    supportsMutualGroups: false,
    supportsBlock: false,
    supportsReport: false,
    supportsRemoveFriend: false,

    supportsGroupRename: true,
    supportsGroupEmoji: true,
    supportsGroupNickname: true,
    supportsGroupLink: true,
    supportsGroupAdmin: true,
    supportsGroupBoard: false,
    supportsGroupLock: false,

    supportsFriendRequest: false,
    supportsLabel: false,
    supportsSeenStatus: false,
    supportsTypingIndicator: true,

    loginMethods: ['cookie', 'credentials'],
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

