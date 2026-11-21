/**
 * employeeChannelRoutes.ts: the Facebook IPC handlers (electron/ipc/facebook/facebookIpc.ts) and personal Telegram
 * (electron/ipc/telegram/telegramUserIpc.ts) in employee mode. Shared pure logic: the employee machine routes calls
 * (proxyHelper.employeeRoutedIpcMain), Boss checks them (proxyActionPolicy: channel list, module permissions, accounts,
 * "nhân viên nào đã gửi" (which employee sent it)), and the tests (proxyActionPolicy.test.ts scans the two IPC files).
 *
 * Facebook sessions (cookies, MQTT, E2EE) and Telegram (MTProto) run only on the Boss machine. Previously the two IPC files were unaware of
 * employee mode: sending, reactions, unsend, edit, read, typing, forward, pin, polls, group actions… from an employee ran on the employee machine itself
 * (no session there), so everything failed. Every handler belongs to EXACTLY one group (a new unclassified handler turns the test red):
 *   - proxy: per-account chat actions + reads that need the session / Boss DB → sent to Boss (/api/proxy/action), which waits and returns the REAL
 *     result of the handler on Boss. Account = `params.accountId` (Boss requires it, and it must be assigned); files in the params are uploaded
 *     to Boss first (the same PROXY_FILE_PATH_FIELDS list that Boss checks).
 *   - boss_only: add / delete / log in / connect accounts, cookies, E2EE, session status → the employee machine returns a clear error
 *     and does not run locally (the employee machine has no session; account status comes from the snapshot + Boss relay events).
 *   - local: utilities of the machine in use (cancel the login window, scan tabs / history stored locally, report that the network is back).
 */

import { tr } from '../../shared/i18n';

export type EmployeeChannelRoute = 'proxy' | 'boss_only' | 'local';

export interface EmployeeChannelSpec {
  route: EmployeeChannelRoute;
  /** Proxy channels: the employee needs ONE of these module permissions (EmployeeService ALL_MODULES). */
  modules?: readonly string[];
  /** Proxy channels: how long to wait for Boss to reply (ms). If not set → PROXY_DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** A proxy channel that sends ONE new message into a conversation → Boss records "nhân viên nào đã gửi" (which employee sent it) (relay:messageSentByEmployee). */
  send?: boolean;
}

/** Default timeout for /api/proxy/action (unchanged). */
export const PROXY_DEFAULT_TIMEOUT_MS = 30_000;
/** Text messages and loading history: Boss may wait up to ~60 s for Facebook / Telegram. */
export const PROXY_MEDIUM_TIMEOUT_MS = 60_000;
/** Sending files, re-syncing conversations, data scanning: under the 100 s limit of the Cloudflare tunnel. */
export const PROXY_SLOW_TIMEOUT_MS = 90_000;

/** Error returned when an employee calls an action that only Boss can perform (not run locally). */
export const BOSS_ONLY_CHANNEL_ERROR =
  tr('Thao tác này chỉ thực hiện trên máy Boss — thêm / xoá, đăng nhập và kết nối tài khoản Facebook / Telegram do Boss quản lý.');
export const BOSS_ONLY_CHANNEL_CODE = 'BOSS_ONLY';

const CHAT = ['chat'] as const;
const CRM = ['crm'] as const;
/** Block / add a contact: called from the chat window (profile, quick actions) and also used for contact management (the Friends page). */
const FRIENDS_OR_CHAT = ['friends', 'chat'] as const;

const BOSS_ONLY: EmployeeChannelSpec = Object.freeze<EmployeeChannelSpec>({ route: 'boss_only' });
const LOCAL: EmployeeChannelSpec = Object.freeze<EmployeeChannelSpec>({ route: 'local' });
const proxy = (modules: readonly string[] = CHAT, extra: Omit<EmployeeChannelSpec, 'route' | 'modules'> = {}): EmployeeChannelSpec =>
  Object.freeze<EmployeeChannelSpec>({ route: 'proxy', modules, ...extra });

export const FACEBOOK_CHANNEL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>> = Object.freeze({
  // ── Accounts / login / session: Boss only ─────────────────────────────
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
  'fb:refreshProfile': BOSS_ONLY, // account name / avatar (the account card on Boss)
  'fb:getAccounts': BOSS_ONLY, // fb_accounts record with cookies: employees get the account list through the snapshot
  'fb:connect': BOSS_ONLY,
  'fb:disconnect': BOSS_ONLY,
  'fb:checkHealth': BOSS_ONLY, // status: snapshot (listener_active) + fb:onConnectionStatus relay
  'fb:getE2EEStatus': BOSS_ONLY,
  'fb:toggleE2EE': BOSS_ONLY,
  'fb:createNote': BOSS_ONLY, // A Messenger Note = posted to the account profile, not a conversation action
  // ── Local ──────────────────────────────────────────────────────────────
  'fb:cancelMessengerLiteLogin': LOCAL, // cancel this machine's login window (an employee cannot open one, so there is nothing to cancel)
  // Scan tabs / history stored on the machine in use (FacebookScanTabService / FacebookScanLogService); only scan commands need a session
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
  // ── Sending messages ─────────────────────────────────────────────────────
  'fb:sendMessage': proxy(CHAT, { send: true, timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'fb:sendE2EEMessage': proxy(CHAT, { send: true, timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'fb:sendAttachment': proxy(CHAT, { send: true, timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'fb:sendAttachments': proxy(CHAT, { send: true, timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  // ── Messages / conversations ────────────────────────────────────────────
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
  // ── Groups ────────────────────────────────────────────────────────────
  'fb:createGroup': proxy(),
  'fb:addGroupAdmin': proxy(),
  'fb:removeGroupAdmin': proxy(),
  'fb:changeApprovalMode': proxy(),
  'fb:approvePendingMember': proxy(),
  'fb:getGroupLink': proxy(),
  'fb:setGroupLink': proxy(),
  // ── Blocking users ─────────────────────────────────────────────────────
  'fb:blockUser': proxy(FRIENDS_OR_CHAT),
  'fb:unblockUser': proxy(FRIENDS_OR_CHAT),
  // ── Reads that need a session / Boss DB ─────────────────────────────────
  'fb:getThreads': proxy(CHAT, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }), // forceRefresh = re-sync (TopBar)
  'fb:getMessages': proxy(),
  'fb:fetchThreadMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'fb:fetchOlderMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }), // scroll up: one page of history through Boss's bridge
  'fb:startHistorySync': BOSS_ONLY, // sync the whole account in the background on the Boss machine (like syncing from the Zalo phone)
  'fb:cancelHistorySync': BOSS_ONLY,
  'fb:getHistorySyncStatus': BOSS_ONLY,
  'fb:getUserInfoFacebook': proxy(),
  'fb:getUserInfoFacebookHtml': proxy(), // old name of fb:getUserInfoFacebook (old renderer version)
  'fb:refreshContactAvatar': proxy(),
  // ── Data scanning (CRM → Data scanning): uses the account's session on Boss ──
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
  // ── Login / session: Boss only ─────────────────────────────────────────
  'telegramUser:sendCode': BOSS_ONLY,
  'telegramUser:signIn': BOSS_ONLY,
  'telegramUser:signIn2FA': BOSS_ONLY,
  'telegramUser:startListener': BOSS_ONLY,
  'telegramUser:stopListener': BOSS_ONLY,
  'telegramUser:isConnected': BOSS_ONLY, // status: snapshot + relayed event:connected / event:disconnected
  'telegramUser:getActive': BOSS_ONLY,
  'telegramUser:fetchSelfAvatar': BOSS_ONLY, // account image (the account card on Boss)
  'telegramUser:checkForumForNewGroups': BOSS_ONLY, // background scan of all accounts
  // ── Local ──────────────────────────────────────────────────────────────
  'telegramUser:networkOnline': LOCAL, // this machine's network is back: rebuild only THIS machine's MTProto session (employees have none)
  // The conversation open on this machine → the file-download queue of this machine. An employee machine has no session (it downloads nothing); Boss does not accept
  // so an employee's open conversation does not take priority over Boss; the file an employee asks for is still a "request from the UI" (repairMessageMedia).
  'telegramUser:setDownloadFocus': LOCAL,
  // ── Sending messages ─────────────────────────────────────────────────────
  'telegramUser:sendMessage': proxy(CHAT, { send: true, timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:sendTopicMessage': proxy(CHAT, { send: true, timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:sendFile': proxy(CHAT, { send: true, timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'telegramUser:sendTopicFile': proxy(CHAT, { send: true, timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  // Several photos as one album: `filePaths` are uploaded to Boss first (PROXY_FILE_PATH_LIST_FIELDS); the album's
  // first message (`messageId`) is recorded as sent by the employee, like fb:sendAttachments
  'telegramUser:sendAlbum': proxy(CHAT, { send: true, timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  'telegramUser:sendSticker': proxy(CHAT, { send: true }),
  'telegramUser:sendGif': proxy(CHAT, { send: true }),
  // ── Messages ────────────────────────────────────────────────────────────
  'telegramUser:editMessage': proxy(),
  'telegramUser:deleteMessages': proxy(),
  'telegramUser:forwardMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:pinMessage': proxy(),
  'telegramUser:syncPinnedMessages': proxy(),
  'telegramUser:sendReaction': proxy(),
  'telegramUser:getAvailableReactions': proxy(),
  'telegramUser:getQuickReaction': proxy(),
  'telegramUser:sendTyping': proxy(),
  'telegramUser:readChatHistory': proxy(),
  'telegramUser:readForumTopic': proxy(),
  // ── Conversations ───────────────────────────────────────────────────────
  'telegramUser:setDialogMute': proxy(),
  'telegramUser:setDialogArchived': proxy(),
  'telegramUser:setDialogPin': proxy(),
  'telegramUser:refreshMessages': proxy(), // Boss runs the background sync (TopBar "Đồng bộ" / Sync), then replies right away
  // ── Groups / forum ────────────────────────────────────────────────────
  'telegramUser:getGroupInfo': proxy(),
  'telegramUser:getGroupMembers': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:getGroupAdmins': proxy(CHAT), // the role shown next to the sender's name (read)
  'telegramUser:searchGroupMembers': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }), // the @mention box: search on Telegram + save to Boss's DB
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
  // ── Contacts / blocking ──────────────────────────────────────────────────
  'telegramUser:addContact': proxy(FRIENDS_OR_CHAT),
  'telegramUser:getContacts': proxy(FRIENDS_OR_CHAT),
  'telegramUser:deleteContacts': proxy(FRIENDS_OR_CHAT),
  'telegramUser:blockUser': proxy(FRIENDS_OR_CHAT),
  'telegramUser:unblockUser': proxy(FRIENDS_OR_CHAT),
  // ── Reads that need a session / Boss DB ─────────────────────────────────
  'telegramUser:getMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:ensureMessageAvailable': proxy(),
  'telegramUser:hydrateMessageSenders': proxy(),
  'telegramUser:refreshReactions': proxy(),
  'telegramUser:getMessageReactions': proxy(),
  'telegramUser:getMessageReadParticipants': proxy(),
  'telegramUser:repairMessageMedia': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:downloadRichMedia': proxy(CHAT, { timeoutMs: PROXY_SLOW_TIMEOUT_MS }),
  // Comments on channel posts (discussion group) + post statistics
  'telegramUser:getPostDiscussion': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:readPostDiscussion': proxy(),
  'telegramUser:refreshPostStats': proxy(),
  'telegramUser:refreshPollResults': proxy(),
  'telegramUser:repairEmptyMessages': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:refreshMessageAttachments': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:repairMessageQuotes': proxy(CHAT, { timeoutMs: PROXY_MEDIUM_TIMEOUT_MS }),
  'telegramUser:getUserProfile': proxy(),
  'telegramUser:resolveUsername': proxy(),
  'telegramUser:searchContacts': proxy(),
  'telegramUser:getPeers': proxy(),
  'telegramUser:refreshContactAvatar': proxy(),
  'telegramUser:getBotCommands': proxy(),
  // ── Bot Mini App ────────────────────────────────────────────────────────
  'telegramUser:requestWebView': proxy(),
  'telegramUser:requestMainWebView': proxy(),
  'telegramUser:prolongWebView': proxy(),
  'telegramUser:miniAppCustomMethod': proxy(),
  'telegramUser:miniAppWriteAccess': proxy(),
  'telegramUser:miniAppSharePhone': proxy(),
  // The bot's login button (keyboardButtonUrlAuth)
  'telegramUser:requestUrlAuth': proxy(),
  'telegramUser:acceptUrlAuth': proxy(),
  // Telegram links opened inside the app: phone number, Mini App by name, bot ?start link
  'telegramUser:resolvePhone': proxy(),
  'telegramUser:getBotApp': proxy(),
  'telegramUser:requestAppWebView': proxy(),
  'telegramUser:startBot': proxy(),
  // Callback / copy / profile buttons of a bot message
  'telegramUser:pressInlineButton': proxy(),
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
  'telegramUser:getStickerFile': proxy(), // files under Boss's media/ folder: employees view them via /api/media
  'telegramUser:searchStickerSets': proxy(),
  // Add / remove a sticker set, save GIFs: the Telegram account's data (like pinning / archiving a conversation), used from the chat window
  'telegramUser:setStickerSetInstalled': proxy(),
  'telegramUser:saveGif': proxy(),
});

const ALL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>> = Object.freeze({
  ...FACEBOOK_CHANNEL_ROUTES,
  ...TELEGRAM_USER_CHANNEL_ROUTES,
});

/** How a personal Facebook / Telegram channel is handled in employee mode; null = channel not in the table (unchanged). */
export function employeeChannelSpec(channel: string): EmployeeChannelSpec | null {
  const name = String(channel || '');
  return Object.prototype.hasOwnProperty.call(ALL_ROUTES, name) ? ALL_ROUTES[name] : null;
}

/** Facebook / Telegram channels that employees send up to Boss (account = `params.accountId`, Boss requires it and checks it). */
export function isAccountChannelProxy(channel: string): boolean {
  return employeeChannelSpec(channel)?.route === 'proxy';
}

/** Names of the Facebook / Telegram proxy channels: Boss adds them to the EMPLOYEE_PROXY_IPC_CHANNELS closed list. */
export const ACCOUNT_CHANNEL_PROXY_NAMES: readonly string[] = Object.freeze(
  Object.keys(ALL_ROUTES).filter((name) => ALL_ROUTES[name].route === 'proxy'),
);
