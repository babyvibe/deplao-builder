"use strict";
/**
 * channelConfig.ts — Single Source of Truth cho tính năng từng kênh chat
 * Dùng bởi UI để quyết định hiển thị/ẩn tính năng, bởi IPC facade để route API calls.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHANNEL_CONFIG = void 0;
exports.getCapability = getCapability;
exports.channelSupports = channelSupports;
exports.getAllChannels = getAllChannels;
exports.getChannelLabel = getChannelLabel;
exports.getChannelColor = getChannelColor;
exports.CHANNEL_CONFIG = {
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
function getCapability(channel) {
    return exports.CHANNEL_CONFIG[channel];
}
function channelSupports(channel, feature) {
    return !!exports.CHANNEL_CONFIG[channel][feature];
}
function getAllChannels() {
    return Object.keys(exports.CHANNEL_CONFIG);
}
function getChannelLabel(channel) {
    return exports.CHANNEL_CONFIG[channel].label;
}
function getChannelColor(channel) {
    return exports.CHANNEL_CONFIG[channel].color;
}
//# sourceMappingURL=channelConfig.js.map