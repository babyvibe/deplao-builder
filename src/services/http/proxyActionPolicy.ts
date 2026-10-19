/**
 * proxyActionPolicy.ts — nhân viên gọi POST /api/proxy/action: kênh nào được gọi, đường dẫn file nào được dùng.
 *
 * Trước đây executeProxyAction gọi BẤT KỲ handler ipcMain nào theo tên kênh (fallback `_invokeHandlers`, event=null)
 * với tham số do nhân viên gửi: nhân viên đã đăng nhập gọi được employee:update / relay:* / settings / plugin / API key…
 * và các handler gửi file (zalo:sendFile…) nhận `filePath` tuỳ ý → gửi được file bất kỳ trên máy Boss (kể cả DB chứa
 * cookie mọi tài khoản) vào một cuộc trò chuyện. Module này gom quy tắc (thuần, có test):
 *   1. Kênh: handler trong registry Zalo (ipcHandlerRegistry — thao tác theo tài khoản, đã kiểm tra zaloId + quyền chat),
 *      `login:connect` (Boss tự lấy auth), hoặc nằm trong danh sách đóng EMPLOYEE_PROXY_IPC_CHANNELS.
 *   2. Đường dẫn file trong tham số phải nằm trong thư mục media của Boss (file nhân viên vừa upload, media / thư viện
 *      có sẵn) và không thuộc tài khoản không được giao.
 */
import * as nodePath from 'path';
import { isPathInside } from './bossFileAccess';
import { ACCOUNT_CHANNEL_PROXY_NAMES, employeeChannelSpec } from './employeeChannelRoutes';

/**
 * Kênh ngoài registry Zalo mà app nhân viên gửi lên Boss (proxyToBoss / proxyToBossWithResult — electron/ipc/*).
 * Danh sách ĐÓNG: thêm kênh proxy mới thì phải thêm vào đây (Boss từ chối CHANNEL_FORBIDDEN).
 * Không dùng tiền tố (`db:`, `crm:`…): cùng tiền tố có handler chỉ Boss được gọi.
 * Facebook / Telegram cá nhân: đúng các kênh nhóm "proxy" của employeeChannelRoutes.ts (gửi tin, cảm xúc, thu hồi, nhóm…);
 * kênh chỉ Boss (thêm / đăng nhập / kết nối tài khoản, cookie, E2EE) KHÔNG có ở đây.
 */
export const EMPLOYEE_PROXY_IPC_CHANNELS: ReadonlySet<string> = new Set([
  // Facebook / Telegram cá nhân (module chat; quét dữ liệu Facebook: crm) — tài khoản = params.accountId
  ...ACCOUNT_CHANNEL_PROXY_NAMES,
  // Trợ lý AI (module ai_assistant)
  'ai:listAssistants', 'ai:getAssistant', 'ai:getDefault', 'ai:saveAssistant', 'ai:deleteAssistant', 'ai:testAssistant',
  'ai:getFiles', 'ai:uploadFile', 'ai:removeFile', 'ai:getAccountAssistant', 'ai:setAccountAssistant',
  'ai:getAccountAssistants', 'ai:getUsageLogs', 'ai:getUsageStats',
  // CRM (module crm)
  'crm:saveNote', 'crm:deleteNote', 'crm:saveCampaign', 'crm:deleteCampaign', 'crm:cloneCampaign',
  'crm:updateCampaignStatus', 'crm:addCampaignContacts', 'crm:deleteCampaignContacts', 'crm:deleteAllCampaignContacts',
  // Dữ liệu hội thoại / nhãn / tin nhắn nhanh (ghi lên DB Boss)
  'db:addFriend', 'db:removeFriend', 'db:saveFriends', 'db:upsertFriendRequest', 'db:removeFriendRequest',
  'db:assignLocalLabelToThread', 'db:bulkAssignLocalLabelToThread', 'db:removeLocalLabelFromThread',
  'db:upsertLocalLabel', 'db:deleteLocalLabel', 'db:setLocalLabelActive', 'db:setLocalLabelOrder', 'db:cloneLocalLabels',
  'db:upsertLocalQuickMessage', 'db:deleteLocalQuickMessage', 'db:setLocalQMActive', 'db:setLocalQMOrder',
  'db:bulkReplaceLocalQuickMessages', 'db:cloneLocalQuickMessages',
  'db:getPinnedMessages', 'db:bringPinnedToTop', 'db:setLocalPinnedConversation', 'db:deleteConversation', 'db:deleteMessages',
  'db:markAsRead', 'db:markMessageRecalled', 'db:pinMessage', 'db:unpinMessage', 'db:setMessageStarred',
  'db:saveGroupMembers', 'db:saveLink', 'db:setContactAlias', 'db:setContactFlags', 'db:updateAccountPhone',
  'db:updateContactProfile', 'db:updateReaction',
  'db:upsertGroupMember', 'db:removeGroupMember', 'db:saveFriendRequests',
  // Cache sticker dùng chung (không theo tài khoản)
  'db:saveStickers', 'db:saveStickerPacks', 'db:saveKeywordStickers', 'db:addRecentSticker', 'db:markStickerUnsupported',
  // Thẻ ngân hàng theo tài khoản: đọc + ghi đều trên DB Boss (id do Boss cấp)
  'db:getBankCards', 'db:upsertBankCard', 'db:deleteBankCard',
  // Tích hợp (module integration): cấu hình + Test kết nối + chạy thao tác (Tích hợp nhanh, đồng bộ sản phẩm Trợ lý AI)
  'integration:save', 'integration:delete', 'integration:toggle',
  'integration:test', 'integration:execute', 'integration:executeByType',
  // Đăng ký webhook tự động trên KiotViet / Sapo (trang tích hợp)
  'integration:listWebhooks', 'integration:registerWebhooks', 'integration:removeWebhook',
  // Workflow (module workflow; Boss kiểm tra mọi trang của workflow thuộc tài khoản được giao)
  'workflow:save', 'workflow:delete', 'workflow:toggle', 'workflow:clone', 'workflow:cloneAll',
]);

/** Kênh xử lý riêng trong executeProxyAction (Boss tự lấy auth của tài khoản được giao). */
export const SPECIAL_PROXY_CHANNELS: ReadonlySet<string> = new Set(['login:connect']);

export type ProxyChannelDecision =
  | { allowed: true }
  | { allowed: false; code: 'CHANNEL_FORBIDDEN'; error: string };

export function checkProxyChannel(channel: string, isZaloRegistryChannel: (channel: string) => boolean): ProxyChannelDecision {
  const name = String(channel || '');
  if (name && (isZaloRegistryChannel(name) || SPECIAL_PROXY_CHANNELS.has(name) || EMPLOYEE_PROXY_IPC_CHANNELS.has(name))) {
    return { allowed: true };
  }
  return { allowed: false, code: 'CHANNEL_FORBIDDEN', error: `Nhân viên không được gọi thao tác này: ${name || '(trống)'}` };
}

// ─── Quyền module ────────────────────────────────────────────────────────────

/**
 * Kết bạn / danh bạ Zalo: gọi từ trang Bạn bè (module friends) VÀ từ khung chat / CRM (thanh lời mời, hồ sơ, xoá bạn,
 * bí danh, tìm theo số) → cần MỘT trong hai quyền. Chỉ 'friends' thì nhân viên có quyền Chat mà không có "Bạn bè" mất các
 * nút kết bạn trong khung chat; chỉ 'chat' (trước đây) thì nhân viên chỉ có "Bạn bè" không thao tác được trên trang Bạn bè.
 */
export const FRIEND_PROXY_CHANNELS: ReadonlySet<string> = new Set([
  'zalo:getFriends', 'zalo:findUser', 'zalo:sendFriendRequest', 'zalo:acceptFriendRequest', 'zalo:rejectFriendRequest',
  'zalo:undoFriendRequest', 'zalo:removeFriend', 'zalo:getSentFriendRequests', 'zalo:getFriendRecommendations',
  'zalo:getFriendRequestStatus', 'zalo:getAliasList', 'zalo:changeFriendAlias', 'zalo:blockUser', 'zalo:unblockUser',
  'zalo:getRelatedFriendGroup',
]);

/**
 * Module quyền cho một kênh proxy: nhân viên cần MỘT trong các module trả về; [] = không yêu cầu module riêng (db:, login:…).
 * Facebook / Telegram theo bảng employeeChannelRoutes (chat; quét dữ liệu Facebook: crm; chặn / thêm liên hệ: friends|chat).
 */
export function proxyChannelModules(channel: string): string[] {
  const name = String(channel || '');
  const spec = employeeChannelSpec(name);
  if (spec?.modules?.length) return [...spec.modules];
  if (FRIEND_PROXY_CHANNELS.has(name)) return ['friends', 'chat'];
  if (name.startsWith('zalo:') || name.startsWith('fb:') || name.startsWith('telegramUser:')) return ['chat'];
  if (name.startsWith('crm:')) return ['crm'];
  if (name.startsWith('workflow:')) return ['workflow'];
  if (name.startsWith('integration:')) return ['integration'];
  if (name.startsWith('ai:')) return ['ai_assistant'];
  return [];
}

// ─── Tài khoản thực hiện ─────────────────────────────────────────────────────
//
// Trước đây thiếu `zaloId` ở cấp params thì Boss dùng tài khoản được giao ĐẦU TIÊN rồi thay auth bằng auth của tài khoản
// đó: nhân viên giữ 2 tài khoản gửi tin / thả cảm xúc / đánh dấu đã đọc từ tài khoản B thì Boss làm bằng tài khoản A.
// Máy nhân viên không có cookie (snapshot không gửi) nên Boss không suy ra được tài khoản từ auth như ở máy Boss —
// UI phải gửi id tài khoản (buildZaloAuth → auth.accountId, hoặc zaloId), Boss chỉ đoán khi không mơ hồ.

/** Trường id tài khoản ở cấp params (như trước) và trong `auth` (buildZaloAuth: accountId; markConversationRead: zaloId). */
const PROXY_PARAM_ACCOUNT_KEYS = ['zaloId', 'zalo_id'] as const;
const PROXY_AUTH_ACCOUNT_KEYS = ['zaloId', 'zalo_id', 'accountId'] as const;

function idOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim();
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return null;
}

/** Mọi id tài khoản nhân viên ghi rõ trong tham số (không trùng). Nhiều id khác nhau = yêu cầu không hợp lệ. */
export function proxyAccountIds(params: unknown): string[] {
  const ids = new Set<string>();
  const record = asObject(params);
  if (!record) return [];
  for (const key of PROXY_PARAM_ACCOUNT_KEYS) {
    const id = idOf(record[key]);
    if (id) ids.add(id);
  }
  const auth = asObject(record.auth);
  if (auth) {
    for (const key of PROXY_AUTH_ACCOUNT_KEYS) {
      const id = idOf(auth[key]);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** Id hội thoại / nhóm trong tham số (threadId, groupId, message JSON của thu hồi / cảm xúc, messages[].idTo…). */
export function proxyThreadIds(params: unknown): string[] {
  const ids = new Set<string>();
  const record = asObject(params);
  if (!record) return [];
  const add = (value: unknown) => { const id = idOf(value); if (id) ids.add(id); };
  add(record.threadId);
  add(record.thread_id);
  add(record.groupId);
  if (Array.isArray(record.threadIds)) record.threadIds.forEach(add);
  const message = asObject(record.message);
  if (message) add(message.threadId);
  if (Array.isArray(record.messages)) {
    for (const item of record.messages) {
      const msg = asObject(item);
      if (msg) add(msg.idTo ?? msg.threadId);
    }
  }
  return [...ids];
}

export type ProxyAccountDecision =
  | { allowed: true; accountId: string; source: 'explicit' | 'single' | 'thread' | 'none' }
  | { allowed: false; code: 'ACCOUNT_FORBIDDEN' | 'ACCOUNT_REQUIRED'; error: string };

export interface ProxyAccountOptions {
  /** Thao tác chạy bằng phiên của MỘT tài khoản (registry Zalo, login:connect) → bắt buộc biết tài khoản nào. */
  required: boolean;
  /** Trong `candidates` (tài khoản được giao), tài khoản nào có hội thoại / nhóm `threadIds` — Boss tra bảng contacts. */
  ownersOfThreads?: (threadIds: string[], candidates: string[]) => string[];
}

/**
 * Tài khoản thực hiện một lệnh proxy:
 *  1. id ghi rõ (params / auth) — phải được giao, và chỉ một id;
 *  2. kênh không cần tài khoản → không đoán (handler tự đọc tham số của nó);
 *  3. nhân viên chỉ được giao một tài khoản → tài khoản đó;
 *  4. hội thoại trong tham số thuộc đúng một tài khoản được giao → tài khoản đó;
 *  5. còn lại → từ chối (ACCOUNT_REQUIRED), KHÔNG lấy tài khoản đầu tiên.
 */
export function resolveProxyAccount(
  params: unknown,
  assignedAccounts: readonly string[] | null | undefined,
  opts: ProxyAccountOptions,
): ProxyAccountDecision {
  const assigned = [...new Set((assignedAccounts || []).map((id) => idOf(id)).filter(Boolean))];
  const explicit = proxyAccountIds(params);
  if (explicit.length > 1) {
    return { allowed: false, code: 'ACCOUNT_FORBIDDEN', error: 'Tham số chứa nhiều tài khoản khác nhau' };
  }
  if (explicit.length === 1) {
    if (!assigned.includes(explicit[0])) {
      return { allowed: false, code: 'ACCOUNT_FORBIDDEN', error: 'Không có quyền truy cập tài khoản này' };
    }
    return { allowed: true, accountId: explicit[0], source: 'explicit' };
  }
  if (!opts.required) return { allowed: true, accountId: '', source: 'none' };
  if (assigned.length === 1) return { allowed: true, accountId: assigned[0], source: 'single' };
  const threads = proxyThreadIds(params);
  if (threads.length > 0 && assigned.length > 1 && opts.ownersOfThreads) {
    let owners: string[] = [];
    try { owners = opts.ownersOfThreads(threads, assigned); } catch { owners = []; }
    const matched = [...new Set(owners.map((id) => idOf(id)))].filter((id) => assigned.includes(id));
    if (matched.length === 1) return { allowed: true, accountId: matched[0], source: 'thread' };
  }
  return {
    allowed: false,
    code: 'ACCOUNT_REQUIRED',
    error: 'Không xác định được tài khoản thực hiện thao tác (nhân viên được giao nhiều tài khoản) — hãy chọn lại hội thoại rồi thử lại',
  };
}

/**
 * Tài khoản thực hiện lệnh proxy Facebook / Telegram cá nhân (employeeChannelRoutes, nhóm "proxy"): handler nhận
 * `params.accountId` → BẮT BUỘC có và phải được giao, không đoán. Trước đây resolveProxyAccount bỏ qua `accountId` ở cấp
 * params (kênh không cần tài khoản) → không kiểm tra gì cả.
 * Facebook nhận cả id nội bộ (fb_accounts.id, UUID) lẫn id Facebook thật (= accounts.zalo_id, danh sách được giao) —
 * `canonical` (Boss tra fb_accounts) đổi về accounts.zalo_id trước khi so. Id khác trong tham số (zaloId, auth.*) phải trùng.
 */
export function resolveAccountChannelProxy(
  params: unknown,
  assignedAccounts: readonly string[] | null | undefined,
  canonical: (accountId: string) => string = (id) => id,
): ProxyAccountDecision {
  const record = asObject(params);
  const raw = idOf(record?.accountId);
  if (!raw) {
    return { allowed: false, code: 'ACCOUNT_REQUIRED', error: 'Thiếu tài khoản thực hiện thao tác — hãy chọn lại hội thoại rồi thử lại' };
  }
  let accountId = raw;
  try { accountId = idOf(canonical(raw)) || raw; } catch { accountId = raw; }
  if (proxyAccountIds(params).some((id) => id !== accountId && id !== raw)) {
    return { allowed: false, code: 'ACCOUNT_FORBIDDEN', error: 'Tham số chứa nhiều tài khoản khác nhau' };
  }
  const assigned = new Set((assignedAccounts || []).map((id) => idOf(id)).filter(Boolean));
  if (!assigned.has(accountId)) {
    return { allowed: false, code: 'ACCOUNT_FORBIDDEN', error: 'Không có quyền truy cập tài khoản này' };
  }
  return { allowed: true, accountId, source: 'explicit' };
}

// ─── "Nhân viên nào đã gửi" ──────────────────────────────────────────────────

export interface EmployeeSendInfo {
  /** Id tin vừa gửi ('' = handler không trả id — Boss gắn theo tin gửi gần nhất của hội thoại). */
  msgId: string;
  threadId: string;
  /** 0 = 1-1, 1 = nhóm (Nhật ký nhân viên). */
  threadType: number;
}

/** Kênh Zalo gửi tin (quy tắc cũ): tên có "send", trừ đã xem / đang gõ. */
function isLegacySendChannel(channel: string): boolean {
  return (channel.includes('send') || channel.includes('Send'))
    && !channel.includes('Seen') && !channel.includes('seen') && !channel.includes('Typing') && !channel.includes('typing');
}

/**
 * Lệnh proxy vừa chạy là một tin nhân viên gửi → id tin / hội thoại để Boss ghi Nhật ký nhân viên + phát
 * relay:messageSentByEmployee; null = không phải gửi tin, hoặc handler báo lỗi (tin chưa gửi — trước đây vẫn bị ghi "đã gửi").
 *  - Facebook / Telegram: đúng các kênh `send` của employeeChannelRoutes (fb:unsendMessage / fb:sendTyping / fb:sendSeen
 *    có chữ "send" nhưng không phải gửi tin); kết quả `{ success, messageId }`; hội thoại = threadId / chatId / chatJid.
 *  - Zalo (registry): như cũ — kết quả `{ success, response: { msgId | message.msgId | message.data.msgId } }`.
 */
export function employeeSendInfo(channel: string, params: unknown, result: any): EmployeeSendInfo | null {
  const name = String(channel || '');
  if (result && typeof result === 'object' && result.success === false) return null;
  const record = asObject(params) || {};
  const spec = employeeChannelSpec(name);
  if (spec) {
    if (spec.route !== 'proxy' || !spec.send) return null;
    const threadId = (idOf(record.threadId) || idOf(record.chatId) || idOf(record.chatJid)).replace(/@.*$/, '');
    let threadType = 0;
    if (name.startsWith('telegramUser:')) {
      threadType = threadId.startsWith('-') ? 1 : 0; // nhóm / kênh Telegram có id âm
    } else {
      const options = asObject(record.options);
      const typeChat = options && Object.prototype.hasOwnProperty.call(options, 'typeChat') ? options.typeChat : record.typeChat;
      threadType = typeChat === null ? 1 : 0; // Facebook: null = nhóm, 'user' = 1-1
    }
    return { msgId: idOf(result?.messageId ?? result?.msgId), threadId, threadType };
  }
  if (!isLegacySendChannel(name)) return null;
  const rawMsgId = result?.response?.msgId
    ?? result?.response?.message?.msgId
    ?? result?.response?.message?.data?.msgId
    ?? '';
  return {
    msgId: String(rawMsgId),
    threadId: idOf(record.threadId) || idOf(record.thread_id),
    threadType: Number(record.threadType ?? record.thread_type ?? 0) || 0,
  };
}

// ─── Đường dẫn file ──────────────────────────────────────────────────────────

/**
 * Trường chứa MỘT đường dẫn file — app nhân viên upload đúng các trường này trước khi proxy (proxyHelper
 * .prepareLocalFilesForProxy dùng chính danh sách này), Boss kiểm tra đúng các trường này. Handler proxy nhận đường dẫn ở
 * trường khác thì Boss KHÔNG kiểm tra → phải thêm vào đây (photoPath: telegramUser:editChatPhoto; stickerPath: bot Telegram).
 */
export const PROXY_FILE_PATH_FIELDS = ['filePath', 'videoPath', 'thumbPath', 'voicePath', 'avatarPath', 'mediaPath', 'photoPath', 'stickerPath'] as const;
/** Trường chứa danh sách đường dẫn. */
export const PROXY_FILE_PATH_LIST_FIELDS = ['filePaths'] as const;

export interface ProxyPathContext {
  /** Thư mục media của Boss (tuyệt đối, đã realpath nếu có). */
  roots: readonly string[];
  /** Đường dẫn nhân viên gửi → tuyệt đối (FileStorageService.resolveAbsolutePath + realpath nếu file tồn tại). */
  resolve: (value: string) => string;
  /**
   * Quyền theo thư mục, nhận đường dẫn tương đối so với root — dùng CÙNG quy tắc với tải file /api/media
   * (bossFileAccess: classifyMediaPath + checkMediaAccess). null = được dùng.
   */
  checkAccess: (relPathFromRoot: string) => { error: string } | null;
  /** So sánh đường dẫn kiểu Windows (mặc định theo máy đang chạy). */
  windows?: boolean;
}

export type ProxyPathDecision =
  | { allowed: true; params: any }
  | { allowed: false; code: 'PATH_FORBIDDEN' | 'ACCOUNT_FORBIDDEN'; error: string; path: string };

/**
 * Kiểm tra mọi đường dẫn file trong tham số proxy. Hợp lệ → trả params với đường dẫn đã chuẩn hoá thành tuyệt đối
 * (handler dùng đúng đường dẫn vừa kiểm tra, không tự resolve lại khác đi). Trường rỗng / không có thì bỏ qua.
 */
export function checkProxyFilePaths(params: any, ctx: ProxyPathContext): ProxyPathDecision {
  if (!params || typeof params !== 'object') return { allowed: true, params };
  const windows = ctx.windows ?? process.platform === 'win32';
  const pathImpl = windows ? nodePath.win32 : nodePath.posix;
  const next: any = { ...params };

  const checkOne = (raw: unknown): { ok: true; value: string } | Extract<ProxyPathDecision, { allowed: false }> => {
    if (typeof raw !== 'string') {
      return { allowed: false, code: 'PATH_FORBIDDEN', error: 'Đường dẫn file không hợp lệ', path: String(raw) };
    }
    let resolved = '';
    try { resolved = ctx.resolve(raw); } catch { resolved = ''; }
    const root = resolved ? ctx.roots.find((r) => isPathInside(r, resolved, { windows })) : undefined;
    if (!root) {
      return { allowed: false, code: 'PATH_FORBIDDEN', error: 'Chỉ gửi được file đã tải lên Boss hoặc media có sẵn của Boss', path: raw };
    }
    const denied = ctx.checkAccess(pathImpl.relative(root, resolved));
    if (denied) return { allowed: false, code: 'ACCOUNT_FORBIDDEN', error: denied.error, path: raw };
    return { ok: true, value: resolved };
  };

  for (const field of PROXY_FILE_PATH_FIELDS) {
    const raw = next[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const checked = checkOne(raw);
    if (!('ok' in checked)) return checked;
    next[field] = checked.value;
  }
  for (const field of PROXY_FILE_PATH_LIST_FIELDS) {
    const raw = next[field];
    if (raw === undefined || raw === null) continue;
    const list: unknown[] = Array.isArray(raw) ? raw : [raw];
    const out: unknown[] = [];
    for (const item of list) {
      if (item === undefined || item === null || item === '') { out.push(item); continue; }
      const checked = checkOne(item);
      if (!('ok' in checked)) return checked;
      out.push(checked.value);
    }
    next[field] = Array.isArray(raw) ? out : out[0];
  }
  return { allowed: true, params: next };
}

// ─── Gộp lệnh poll reaction Telegram ────────────────────────────────────────

/** Kênh poll định kỳ: nhiều nhân viên mở cùng nhóm → Boss chỉ hỏi Telegram một lần trong cửa sổ này. */
export const COALESCED_POLL_CHANNELS: ReadonlySet<string> = new Set(['telegramUser:refreshReactions']);
export const POLL_COALESCE_WINDOW_MS = 15_000;

export interface RecentPoll { at: number; ids: ReadonlySet<string> }

/**
 * ChatWindow poll reaction nhóm Telegram mỗi 20 s (Telegram chỉ đẩy reaction cho tác giả tin). Qua Boss, mỗi nhân
 * viên mở nhóm = thêm một lệnh GetMessagesReactions trên CÙNG phiên Telegram → dễ dính FLOOD_WAIT. Boss đã ghi DB và
 * phát sự kiện cho mọi người khi reaction đổi, nên lệnh trùng (cùng tài khoản + nhóm, các tin đã được hỏi trong
 * cửa sổ) bỏ qua được. Trả true = bỏ qua lệnh này.
 */
export function shouldSkipCoalescedPoll(recent: RecentPoll | undefined, messageIds: readonly string[], now: number,
  windowMs: number = POLL_COALESCE_WINDOW_MS): boolean {
  if (!recent || now - recent.at >= windowMs || now < recent.at) return false;
  if (messageIds.length === 0) return true;
  return messageIds.every((id) => recent.ids.has(String(id)));
}
