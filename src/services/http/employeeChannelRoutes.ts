/**
 * employeeChannelRoutes.ts — handler IPC Facebook (electron/ipc/facebookIpc.ts) và Telegram cá nhân
 * (electron/ipc/telegramUserIpc.ts) ở chế độ nhân viên. Phần thuần, dùng chung: máy nhân viên định tuyến
 * (proxyHelper.employeeRoutedIpcMain), Boss kiểm tra (proxyActionPolicy: danh sách kênh, module quyền, tài khoản,
 * "nhân viên nào đã gửi") và test (proxyActionPolicy.test.ts quét hai file IPC).
 *
 * Phiên Facebook (cookie, MQTT, E2EE) và Telegram (MTProto) chỉ chạy trên máy Boss. Trước đây hai file IPC không biết chế
 * độ nhân viên: gửi tin, cảm xúc, thu hồi, sửa, đã đọc, đang gõ, chuyển tiếp, ghim, bình chọn, thao tác nhóm… của nhân
 * viên chạy ngay trên máy nhân viên (không có phiên) → lỗi hết. Mỗi handler thuộc ĐÚNG một nhóm (handler mới chưa phân
 * loại → test đỏ):
 *   - proxy: thao tác chat theo tài khoản + đọc cần phiên / DB Boss → gửi Boss (/api/proxy/action), chờ và trả KẾT QUẢ
 *     THẬT của handler trên Boss. Tài khoản = `params.accountId` (Boss bắt buộc + phải được giao); file trong tham số
 *     được upload lên Boss trước (cùng danh sách trường PROXY_FILE_PATH_FIELDS mà Boss kiểm tra).
 *   - boss_only: thêm / xoá / đăng nhập / kết nối tài khoản, cookie, E2EE, trạng thái phiên → máy nhân viên trả lỗi rõ
 *     ràng, không chạy cục bộ (máy nhân viên không có phiên; trạng thái tài khoản lấy từ snapshot + event relay của Boss).
 *   - local: tiện ích của chính máy đang dùng (huỷ trình đăng nhập, tab / lịch sử quét lưu cục bộ, báo có mạng lại).
 */

export type EmployeeChannelRoute = 'proxy' | 'boss_only' | 'local';

export interface EmployeeChannelSpec {
  route: EmployeeChannelRoute;
  /** Kênh proxy: nhân viên cần MỘT trong các module quyền này (EmployeeService ALL_MODULES). */
  modules?: readonly string[];
  /** Kênh proxy: thời gian chờ Boss trả lời (ms). Không có → PROXY_DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Kênh proxy gửi MỘT tin mới vào hội thoại → Boss ghi "nhân viên nào đã gửi" (relay:messageSentByEmployee). */
  send?: boolean;
}

/** Thời gian chờ mặc định của /api/proxy/action (như trước). */
export const PROXY_DEFAULT_TIMEOUT_MS = 30_000;
/** Gửi tin chữ, tải lịch sử: Boss có thể chờ Facebook / Telegram tới ~60 s. */
export const PROXY_MEDIUM_TIMEOUT_MS = 60_000;
/** Gửi file, đồng bộ lại hội thoại, quét dữ liệu — dưới giới hạn 100 s của Cloudflare tunnel. */
export const PROXY_SLOW_TIMEOUT_MS = 90_000;

/** Lỗi trả về khi nhân viên gọi thao tác chỉ Boss được làm (không chạy cục bộ). */
export const BOSS_ONLY_CHANNEL_ERROR =
  'Thao tác này chỉ thực hiện trên máy Boss — thêm / xoá, đăng nhập và kết nối tài khoản Facebook / Telegram do Boss quản lý.';
export const BOSS_ONLY_CHANNEL_CODE = 'BOSS_ONLY';

const CHAT = ['chat'] as const;
const CRM = ['crm'] as const;
/** Chặn / thêm liên hệ: gọi từ khung chat (hồ sơ, thao tác nhanh) và cũng là quản lý danh bạ (trang Bạn bè). */
const FRIENDS_OR_CHAT = ['friends', 'chat'] as const;

const BOSS_ONLY: EmployeeChannelSpec = Object.freeze<EmployeeChannelSpec>({ route: 'boss_only' });
const LOCAL: EmployeeChannelSpec = Object.freeze<EmployeeChannelSpec>({ route: 'local' });
const proxy = (modules: readonly string[] = CHAT, extra: Omit<EmployeeChannelSpec, 'route' | 'modules'> = {}): EmployeeChannelSpec =>
  Object.freeze<EmployeeChannelSpec>({ route: 'proxy', modules, ...extra });

export const FACEBOOK_CHANNEL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>> = Object.freeze({
  // ── Tài khoản / đăng nhập / phiên: chỉ Boss ─────────────────────────────
  'fb:addAccount': BOSS_ONLY,
  'fb:addAccountWithCredentials': BOSS_ONLY,
  'fb:loginWithCredentials': BOSS_ONLY,
  'fb:startMessengerLiteLogin': BOSS_ONLY,
  'fb:submitMessengerLiteLogin': BOSS_ONLY,
  'fb:waitMessengerLiteLogin': BOSS_ONLY,
  'fb:backMessengerLiteLogin': BOSS_ONLY,
  'fb:runMessengerLiteWebStep': BOSS_ONLY,
  'fb:removeAccount': BOSS_ONLY,
  'fb:updateCookie': BOSS_ONLY,
  'fb:refreshProfile': BOSS_ONLY, // tên / ảnh CỦA tài khoản (thẻ tài khoản trên Boss)
  'fb:getAccounts': BOSS_ONLY, // bản ghi fb_accounts kèm cookie — nhân viên nhận danh sách tài khoản qua snapshot
  'fb:connect': BOSS_ONLY,
  'fb:disconnect': BOSS_ONLY,
  'fb:checkHealth': BOSS_ONLY, // trạng thái: snapshot (listener_active) + fb:onConnectionStatus relay
  'fb:getE2EEStatus': BOSS_ONLY,
  'fb:toggleE2EE': BOSS_ONLY,
  'fb:createNote': BOSS_ONLY, // Messenger Note = đăng lên hồ sơ tài khoản, không phải thao tác hội thoại
  // ── Cục bộ ──────────────────────────────────────────────────────────────
  'fb:cancelMessengerLiteLogin': LOCAL, // huỷ trình đăng nhập của máy này (nhân viên không mở được → không có gì)
  // Tab / lịch sử quét lưu ở máy đang dùng (FacebookScanTabService / FacebookScanLogService); chỉ lệnh quét cần phiên
  'fb:saveScanLog': LOCAL,
  'fb:getScanLogs': LOCAL,
  'fb:scanResetCache': LOCAL,
  'fb:scanSaveTab': LOCAL,
  'fb:scanGetTabs': LOCAL,
  'fb:scanGetTab': LOCAL,
  'fb:scanUpdateTabStatus': LOCAL,
  'fb:scanDeleteTab': LOCAL,
  'fb:scanTouchTab': LOCAL,
  'fb:scanSaveTabData': LOCAL,
  'fb:scanGetTabData': LOCAL,
  'fb:scanSaveRequestLog': LOCAL,
  'fb:scanGetRequestLogs': LOCAL,
  'fb:scanGetStats': LOCAL,
  // ── Gửi tin ─────────────────────────────────────────────────────────────
  'fb:sendMessage': proxy(CHAT, { send: true, timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'fb:sendE2EEMessage': proxy(CHAT, { send: true, timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'fb:sendAttachment': proxy(CHAT, { send: true, timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'fb:sendAttachments': proxy(CHAT, { send: true, timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  // ── Tin nhắn / hội thoại ────────────────────────────────────────────────
  'fb:unsendMessage': proxy(),
  'fb:addReaction': proxy(),
  'fb:editMessage': proxy(),
  'fb:forwardMessage': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'fb:pinMessage': proxy(),
  'fb:unpinMessage': proxy(),
  'fb:createPoll': proxy(),
  'fb:votePoll': proxy(),
  'fb:markAsRead': proxy(),
  'fb:sendSeen': proxy(),
  'fb:sendTyping': proxy(),
  'fb:changeThreadName': proxy(),
  'fb:changeThreadEmoji': proxy(),
  'fb:changeThreadTheme': proxy(),
  'fb:changeNickname': proxy(),
  // ── Nhóm ────────────────────────────────────────────────────────────────
  'fb:createGroup': proxy(),
  'fb:addGroupAdmin': proxy(),
  'fb:removeGroupAdmin': proxy(),
  'fb:changeApprovalMode': proxy(),
  'fb:approvePendingMember': proxy(),
  'fb:getGroupLink': proxy(),
  'fb:setGroupLink': proxy(),
  // ── Chặn người dùng ─────────────────────────────────────────────────────
  'fb:blockUser': proxy(FRIENDS_OR_CHAT),
  'fb:unblockUser': proxy(FRIENDS_OR_CHAT),
  // ── Đọc cần phiên / DB Boss ─────────────────────────────────────────────
  'fb:getThreads': proxy(CHAT, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }), // forceRefresh = đồng bộ lại (TopBar)
  'fb:getMessages': proxy(),
  'fb:fetchThreadMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'fb:fetchOlderMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }), // cuộn lên: một trang lịch sử qua bridge của Boss
  'fb:startHistorySync': BOSS_ONLY, // đồng bộ cả tài khoản chạy nền trên máy Boss (như đồng bộ từ điện thoại của Zalo)
  'fb:cancelHistorySync': BOSS_ONLY,
  'fb:getHistorySyncStatus': BOSS_ONLY,
  'fb:getUserInfoFacebook': proxy(),
  'fb:getUserInfoFacebookHtml': proxy(), // tên cũ của fb:getUserInfoFacebook (bản renderer cũ)
  'fb:refreshContactAvatar': proxy(),
  // ── Quét dữ liệu (CRM → Quét dữ liệu): dùng phiên của tài khoản trên Boss ──
  'fb:scanGroupMembers': proxy(CRM, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'fb:scanGroupKeyword': proxy(CRM, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'fb:scanFanpageKeyword': proxy(CRM, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'fb:scanPostComments': proxy(CRM, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'fb:scanPostKeyword': proxy(CRM, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'fb:scanPostTimeline': proxy(CRM, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'fb:scanGroupMembersBatch': proxy(CRM, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'fb:scanPostCommentsBatch': proxy(CRM, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
});

export const TELEGRAM_USER_CHANNEL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>> = Object.freeze({
  // ── Đăng nhập / phiên: chỉ Boss ─────────────────────────────────────────
  'telegramUser:sendCode': BOSS_ONLY,
  'telegramUser:signIn': BOSS_ONLY,
  'telegramUser:signIn2FA': BOSS_ONLY,
  'telegramUser:startListener': BOSS_ONLY,
  'telegramUser:stopListener': BOSS_ONLY,
  'telegramUser:isConnected': BOSS_ONLY, // trạng thái: snapshot + event:connected / event:disconnected relay
  'telegramUser:getActive': BOSS_ONLY,
  'telegramUser:fetchSelfAvatar': BOSS_ONLY, // ảnh CỦA tài khoản (thẻ tài khoản trên Boss)
  'telegramUser:checkForumForNewGroups': BOSS_ONLY, // quét nền toàn tài khoản
  // ── Cục bộ ──────────────────────────────────────────────────────────────
  'telegramUser:networkOnline': LOCAL, // máy này có mạng lại: chỉ dựng lại phiên MTProto CỦA máy này (nhân viên không có)
  // ── Gửi tin ─────────────────────────────────────────────────────────────
  'telegramUser:sendMessage': proxy(CHAT, { send: true, timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:sendTopicMessage': proxy(CHAT, { send: true, timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:sendFile': proxy(CHAT, { send: true, timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'telegramUser:sendTopicFile': proxy(CHAT, { send: true, timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'telegramUser:sendSticker': proxy(CHAT, { send: true }),
  'telegramUser:sendGif': proxy(CHAT, { send: true }),
  // ── Tin nhắn ────────────────────────────────────────────────────────────
  'telegramUser:editMessage': proxy(),
  'telegramUser:deleteMessages': proxy(),
  'telegramUser:forwardMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:pinMessage': proxy(),
  'telegramUser:syncPinnedMessages': proxy(),
  'telegramUser:sendReaction': proxy(),
  'telegramUser:getAvailableReactions': proxy(),
  'telegramUser:sendTyping': proxy(),
  'telegramUser:readChatHistory': proxy(),
  'telegramUser:readForumTopic': proxy(),
  // ── Hội thoại ───────────────────────────────────────────────────────────
  'telegramUser:setDialogMute': proxy(),
  'telegramUser:setDialogArchived': proxy(),
  'telegramUser:setDialogPin': proxy(),
  'telegramUser:refreshMessages': proxy(), // Boss chạy đồng bộ nền (TopBar "Đồng bộ"), trả lời ngay
  // ── Nhóm / forum ────────────────────────────────────────────────────────
  'telegramUser:getGroupInfo': proxy(),
  'telegramUser:getGroupMembers': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:getGroupAdmins': proxy(CHAT), // chức vụ cạnh tên người gửi (đọc)
  'telegramUser:searchGroupMembers': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }), // ô @nhắc đến: tìm trên Telegram + lưu DB Boss
  'telegramUser:getFullChat': proxy(),
  'telegramUser:addChatUser': proxy(),
  'telegramUser:deleteChatUser': proxy(),
  'telegramUser:editChatTitle': proxy(),
  'telegramUser:editChatPhoto': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:editChatAdmin': proxy(),
  'telegramUser:leaveChat': proxy(),
  'telegramUser:exportChatInvite': proxy(),
  'telegramUser:joinGroup': proxy(),
  'telegramUser:createGroup': proxy(),
  'telegramUser:previewJoinLink': proxy(),
  'telegramUser:joinByLink': proxy(),
  'telegramUser:createChannel': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:checkChatUsername': proxy(),
  'telegramUser:setChatUsername': proxy(),
  'telegramUser:getChatSettings': proxy(),
  'telegramUser:editChatAbout': proxy(),
  'telegramUser:revokeInviteLink': proxy(),
  'telegramUser:toggleSignatures': proxy(),
  'telegramUser:getDiscussionGroups': proxy(),
  'telegramUser:setDiscussionGroup': proxy(),
  'telegramUser:setHistoryTtl': proxy(),
  'telegramUser:deleteChat': proxy(),
  'telegramUser:inviteUsers': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:getCallHistory': proxy(),
  'telegramUser:declineCall': proxy(),
  'telegramUser:isForum': proxy(),
  'telegramUser:getForumTopics': proxy(),
  'telegramUser:getForumTopicMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:createForumTopic': proxy(),
  'telegramUser:editForumTopic': proxy(),
  // ── Danh bạ / chặn ──────────────────────────────────────────────────────
  'telegramUser:addContact': proxy(FRIENDS_OR_CHAT),
  'telegramUser:getContacts': proxy(FRIENDS_OR_CHAT),
  'telegramUser:deleteContacts': proxy(FRIENDS_OR_CHAT),
  'telegramUser:blockUser': proxy(FRIENDS_OR_CHAT),
  'telegramUser:unblockUser': proxy(FRIENDS_OR_CHAT),
  // ── Đọc cần phiên / DB Boss ─────────────────────────────────────────────
  'telegramUser:getMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:ensureMessageAvailable': proxy(),
  'telegramUser:hydrateMessageSenders': proxy(),
  'telegramUser:refreshReactions': proxy(),
  'telegramUser:getMessageReactions': proxy(),
  'telegramUser:getMessageReadParticipants': proxy(),
  'telegramUser:repairMessageMedia': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:repairEmptyMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:refreshMessageAttachments': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:repairMessageQuotes': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:getUserProfile': proxy(),
  'telegramUser:resolveUsername': proxy(),
  'telegramUser:searchContacts': proxy(),
  'telegramUser:getPeers': proxy(),
  'telegramUser:refreshContactAvatar': proxy(),
  'telegramUser:getBotCommands': proxy(),
  // ── Mini App của bot ────────────────────────────────────────────────────
  'telegramUser:requestWebView': proxy(),
  'telegramUser:requestMainWebView': proxy(),
  'telegramUser:prolongWebView': proxy(),
  // ── Sticker / GIF ───────────────────────────────────────────────────────
  'telegramUser:getStickerSets': proxy(),
  'telegramUser:getStickerSetStickers': proxy(),
  'telegramUser:getRecentStickers': proxy(),
  'telegramUser:getGifs': proxy(),
  'telegramUser:searchGifs': proxy(),
  'telegramUser:downloadSticker': proxy(),
  'telegramUser:getStickerPanel': proxy(),
  'telegramUser:getStickerSet': proxy(),
  'telegramUser:getStickerSetOfMessage': proxy(),
  'telegramUser:getStickerFile': proxy(), // file nằm dưới media/ của Boss → nhân viên xem qua /api/media
  'telegramUser:searchStickerSets': proxy(),
  // Thêm / gỡ bộ sticker, lưu GIF: dữ liệu của tài khoản Telegram (như ghim / lưu trữ hội thoại), dùng từ khung chat
  'telegramUser:setStickerSetInstalled': proxy(),
  'telegramUser:saveGif': proxy(),
});

const ALL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>> = Object.freeze({
  ...FACEBOOK_CHANNEL_ROUTES,
  ...TELEGRAM_USER_CHANNEL_ROUTES,
});

/** Cách xử lý một kênh Facebook / Telegram cá nhân ở chế độ nhân viên; null = kênh không thuộc bảng (giữ nguyên). */
export function employeeChannelSpec(channel: string): EmployeeChannelSpec | null {
  const name = String(channel || '');
  return Object.prototype.hasOwnProperty.call(ALL_ROUTES, name) ? ALL_ROUTES[name] : null;
}

/** Kênh Facebook / Telegram nhân viên được gửi lên Boss (tài khoản = `params.accountId`, Boss bắt buộc + kiểm tra). */
export function isAccountChannelProxy(channel: string): boolean {
  return employeeChannelSpec(channel)?.route === 'proxy';
}

/** Tên các kênh proxy Facebook / Telegram — Boss thêm vào danh sách đóng EMPLOYEE_PROXY_IPC_CHANNELS. */
export const ACCOUNT_CHANNEL_PROXY_NAMES: readonly string[] = Object.freeze(
  Object.keys(ALL_ROUTES).filter((name) => ALL_ROUTES[name].route === 'proxy'),
);
