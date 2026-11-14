/**
 * proxyActionPolicy.ts: which channels an employee may call via POST /api/proxy/action, and which file paths may be used.
 *
 * Previously executeProxyAction called ANY ipcMain handler by channel name (fallback `_invokeHandlers`, event=null)
 * with parameters sent by the employee: a logged-in employee could call employee:update / relay:* / settings / plugin / API keys...
 * and the file-sending handlers (zalo:sendFile...) accepted any `filePath` → any file on the Boss machine (including the DB holding
 * the cookies of every account) could be sent into a conversation. This module gathers the rules (pure, has tests):
 *   1. Channel: a handler in the Zalo registry (ipcHandlerRegistry: per-account actions, zaloId and chat permission already checked),
 *      `login:connect` (Boss gets the auth itself), or a channel in the closed list EMPLOYEE_PROXY_IPC_CHANNELS.
 *   2. File paths in the parameters must be inside the Boss media folder (files the employee just uploaded, existing media / library)
 *      and must not belong to an account that is not assigned.
 */
import * as nodePath from 'path';
import { isPathInside } from './bossFileAccess';
import { ACCOUNT_CHANNEL_PROXY_NAMES, employeeChannelSpec } from './employeeChannelRoutes';
import { tr } from '../../shared/i18n';

/**
 * Channels outside the Zalo registry that the employee app sends to Boss (proxyToBoss / proxyToBossWithResult, electron/ipc/*).
 * CLOSED list: a new proxy channel must be added here (Boss rejects it with CHANNEL_FORBIDDEN).
 * No prefixes (`db:`, `crm:`...): the same prefix may have handlers that only Boss may call.
 * Personal Facebook / Telegram: exactly the "proxy" group channels of employeeChannelRoutes.ts (send messages, reactions, unsend, groups...);
 * Boss-only channels (add / log in / connect account, cookies, E2EE) are NOT here.
 */
export const EMPLOYEE_PROXY_IPC_CHANNELS: ReadonlySet<string> = new Set([
  // Personal Facebook / Telegram (chat module; Facebook data scan: crm): account = params.accountId
  ...ACCOUNT_CHANNEL_PROXY_NAMES,
  // AI assistant (ai_assistant module)
  'ai:listAssistants', 'ai:getAssistant', 'ai:getDefault', 'ai:saveAssistant', 'ai:deleteAssistant', 'ai:testAssistant',
  'ai:getFiles', 'ai:uploadFile', 'ai:removeFile', 'ai:getAccountAssistant', 'ai:setAccountAssistant',
  'ai:getAccountAssistants', 'ai:getUsageLogs', 'ai:getUsageStats',
  // CRM (module crm)
  'crm:saveNote', 'crm:deleteNote', 'crm:saveCampaign', 'crm:deleteCampaign', 'crm:cloneCampaign',
  'crm:updateCampaignStatus', 'crm:addCampaignContacts', 'crm:deleteCampaignContacts', 'crm:deleteAllCampaignContacts',
  // Conversation / label / quick message data (written to the Boss DB)
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
  // Shared sticker cache (not per account)
  'db:saveStickers', 'db:saveStickerPacks', 'db:saveKeywordStickers', 'db:addRecentSticker', 'db:markStickerUnsupported',
  // Bank cards per account: both read and write on the Boss DB (ids issued by Boss)
  'db:getBankCards', 'db:upsertBankCard', 'db:deleteBankCard',
  // Integrations (integration module): config + Test connection + run actions (Quick integration, product sync for the AI assistant)
  'integration:save', 'integration:delete', 'integration:toggle',
  'integration:test', 'integration:execute', 'integration:executeByType',
  // Automatic webhook registration on KiotViet / Sapo (integration page)
  'integration:listWebhooks', 'integration:registerWebhooks', 'integration:removeWebhook',
  // Workflow (workflow module; Boss checks that every page of the workflow belongs to the assigned account)
  'workflow:save', 'workflow:delete', 'workflow:toggle', 'workflow:clone', 'workflow:cloneAll',
  // Zalo message images Boss has not saved yet → Boss downloads them with the account session (chat module; only the message id, the link is read from the Boss DB)
  'file:ensureMessageImage',
]);

/** Channel with its own handling in executeProxyAction (Boss gets the auth of the assigned account itself). */
export const SPECIAL_PROXY_CHANNELS: ReadonlySet<string> = new Set(['login:connect']);

export type ProxyChannelDecision =
  | { allowed: true }
  | { allowed: false; code: 'CHANNEL_FORBIDDEN'; error: string };

export function checkProxyChannel(channel: string, isZaloRegistryChannel: (channel: string) => boolean): ProxyChannelDecision {
  const name = String(channel || '');
  if (name && (isZaloRegistryChannel(name) || SPECIAL_PROXY_CHANNELS.has(name) || EMPLOYEE_PROXY_IPC_CHANNELS.has(name))) {
    return { allowed: true };
  }
  return { allowed: false, code: 'CHANNEL_FORBIDDEN', error: tr('Nhân viên không được gọi thao tác này: {{v1}}', { v1: name || tr('(trống)') }) };
}

// ─── Module permissions ────────────────────────────────────────────────────────

/**
 * Zalo friends / contacts: called from the Friends page (friends module) AND from the chat window / CRM (friend request bar, profile, unfriend,
 * alias, search by number) → needs ONE of the two permissions. With only 'friends', an employee who has Chat but not "Bạn bè" loses the
 * add-friend buttons in the chat window; with only 'chat' (the old setup), an employee who has "Bạn bè" cannot act on the Friends page.
 */
export const FRIEND_PROXY_CHANNELS: ReadonlySet<string> = new Set([
  'zalo:getFriends', 'zalo:findUser', 'zalo:sendFriendRequest', 'zalo:acceptFriendRequest', 'zalo:rejectFriendRequest',
  'zalo:undoFriendRequest', 'zalo:removeFriend', 'zalo:getSentFriendRequests', 'zalo:getFriendRecommendations',
  'zalo:getFriendRequestStatus', 'zalo:getAliasList', 'zalo:changeFriendAlias', 'zalo:blockUser', 'zalo:unblockUser',
  'zalo:getRelatedFriendGroup',
]);

/**
 * Settings of the Zalo account itself (privacy: SRS ZL-02; change / reset the PIN of hidden conversations: ZL-03): only people with
 * the account management permission (settings_accounts), not the Chat permission like the other zalo:* channels.
 */
export const ACCOUNT_SETTINGS_PROXY_CHANNELS: ReadonlySet<string> = new Set([
  'zalo:getAccountSettings', 'zalo:updateAccountSetting', 'zalo:hiddenSetPin', 'zalo:hiddenResetPin',
]);

/** Writes the Zalo Business product catalog (SRS ZL-04): employees need the CRM permission (decision Q7); reading / sending follows the Chat permission. */
export const CATALOG_WRITE_PROXY_CHANNELS: ReadonlySet<string> = new Set([
  'zalo:createCatalog', 'zalo:updateCatalog', 'zalo:deleteCatalog',
  'zalo:createCatalogProduct', 'zalo:updateCatalogProduct', 'zalo:deleteCatalogProducts', 'zalo:uploadProductPhoto',
]);

/**
 * Permission modules for a proxy channel: the employee needs ONE of the returned modules; [] = no separate module required (db:, login:...).
 * Facebook / Telegram follow the employeeChannelRoutes table (chat; Facebook data scan: crm; block / add contact: friends|chat).
 */
export function proxyChannelModules(channel: string): string[] {
  const name = String(channel || '');
  const spec = employeeChannelSpec(name);
  if (spec?.modules?.length) return [...spec.modules];
  if (ACCOUNT_SETTINGS_PROXY_CHANNELS.has(name)) return ['settings_accounts'];
  if (CATALOG_WRITE_PROXY_CHANNELS.has(name)) return ['crm'];
  if (name === 'file:ensureMessageImage') return ['chat'];
  if (FRIEND_PROXY_CHANNELS.has(name)) return ['friends', 'chat'];
  if (name.startsWith('zalo:') || name.startsWith('fb:') || name.startsWith('telegramUser:')) return ['chat'];
  if (name.startsWith('crm:')) return ['crm'];
  if (name.startsWith('workflow:')) return ['workflow'];
  if (name.startsWith('integration:')) return ['integration'];
  if (name.startsWith('ai:')) return ['ai_assistant'];
  return [];
}

// ─── Acting account ─────────────────────────────────────────────────────────
//
// Previously, when `zaloId` was missing at the params level, Boss used the FIRST assigned account and then replaced the auth with the auth of that account
// so an employee with 2 accounts who sent a message / reacted / marked as read from account B had Boss act with account A.
// The employee machine has no cookies (the snapshot does not send them), so Boss cannot infer the account from the auth the way the Boss machine does:
// the UI must send the account id (buildZaloAuth → auth.accountId, or zaloId); Boss only guesses when there is no ambiguity.

/** Account id field at the params level (as before) and inside `auth` (buildZaloAuth: accountId; markConversationRead: zaloId). */
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

/** Every account id the employee states explicitly in the parameters (no duplicates). Several different ids = invalid request. */
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

/** Conversation / group ids in the parameters (threadId, groupId, the message JSON of unsend / reactions, messages[].idTo...). */
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
  /** Actions run with the session of ONE account (Zalo registry, login:connect) → must know which account. */
  required: boolean;
  /** Among `candidates` (assigned accounts), which account has the conversations / groups `threadIds`: Boss looks it up in the contacts table. */
  ownersOfThreads?: (threadIds: string[], candidates: string[]) => string[];
}

/**
 * The account that performs a proxy command:
 *  1. an explicit id (params / auth): must be assigned, and only one id;
 *  2. a channel that needs no account → nothing is guessed (the handler reads its own parameters);
 *  3. the employee has only one assigned account → that account;
 *  4. the conversation in the parameters belongs to exactly one assigned account → that account;
 *  5. otherwise → reject (ACCOUNT_REQUIRED), NEVER take the first account.
 */
export function resolveProxyAccount(
  params: unknown,
  assignedAccounts: readonly string[] | null | undefined,
  opts: ProxyAccountOptions,
): ProxyAccountDecision {
  const assigned = [...new Set((assignedAccounts || []).map((id) => idOf(id)).filter(Boolean))];
  const explicit = proxyAccountIds(params);
  if (explicit.length > 1) {
    return { allowed: false, code: 'ACCOUNT_FORBIDDEN', error: tr('Tham số chứa nhiều tài khoản khác nhau') };
  }
  if (explicit.length === 1) {
    if (!assigned.includes(explicit[0])) {
      return { allowed: false, code: 'ACCOUNT_FORBIDDEN', error: tr('Không có quyền truy cập tài khoản này') };
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
    error: tr('Không xác định được tài khoản thực hiện thao tác (nhân viên được giao nhiều tài khoản) — hãy chọn lại hội thoại rồi thử lại'),
  };
}

/**
 * The account that performs a personal Facebook / Telegram proxy command (employeeChannelRoutes, "proxy" group): the handler receives
 * `params.accountId` → it is REQUIRED and must be assigned, nothing is guessed. Previously resolveProxyAccount ignored `accountId` at the
 * params level (channels that need no account) → nothing was checked at all.
 * Facebook accepts both the internal id (fb_accounts.id, UUID) and the real Facebook id (= accounts.zalo_id, the assigned list) →
 * `canonical` (Boss looks up fb_accounts) maps it back to accounts.zalo_id before comparing. Other ids in the parameters (zaloId, auth.*) must match.
 */
export function resolveAccountChannelProxy(
  params: unknown,
  assignedAccounts: readonly string[] | null | undefined,
  canonical: (accountId: string) => string = (id) => id,
): ProxyAccountDecision {
  const record = asObject(params);
  const raw = idOf(record?.accountId);
  if (!raw) {
    return { allowed: false, code: 'ACCOUNT_REQUIRED', error: tr('Thiếu tài khoản thực hiện thao tác — hãy chọn lại hội thoại rồi thử lại') };
  }
  let accountId = raw;
  try { accountId = idOf(canonical(raw)) || raw; } catch { accountId = raw; }
  if (proxyAccountIds(params).some((id) => id !== accountId && id !== raw)) {
    return { allowed: false, code: 'ACCOUNT_FORBIDDEN', error: tr('Tham số chứa nhiều tài khoản khác nhau') };
  }
  const assigned = new Set((assignedAccounts || []).map((id) => idOf(id)).filter(Boolean));
  if (!assigned.has(accountId)) {
    return { allowed: false, code: 'ACCOUNT_FORBIDDEN', error: tr('Không có quyền truy cập tài khoản này') };
  }
  return { allowed: true, accountId, source: 'explicit' };
}

// ─── "Which employee sent it" ──────────────────────────────────────────────────

export interface EmployeeSendInfo {
  /** Id of the message just sent ('' = the handler returns no id; Boss attaches it to the latest sent message of the conversation). */
  msgId: string;
  threadId: string;
  /** 0 = 1-1, 1 = group (employee log). */
  threadType: number;
}

/** Zalo channel that sends messages (old rule): the name contains "send", except seen / typing. */
function isLegacySendChannel(channel: string): boolean {
  return (channel.includes('send') || channel.includes('Send'))
    && !channel.includes('Seen') && !channel.includes('seen') && !channel.includes('Typing') && !channel.includes('typing');
}

/**
 * When the proxy command just run is a message sent by an employee → the message / conversation id so Boss can write the employee log and emit
 * relay:messageSentByEmployee; null = not a message send, or the handler reported an error (the message was not sent: previously it was still logged as "sent").
 *  - Facebook / Telegram: exactly the `send` channels of employeeChannelRoutes (fb:unsendMessage / fb:sendTyping / fb:sendSeen
 *    contain "send" but are not message sends); result `{ success, messageId }`; conversation = threadId / chatId / chatJid.
 *  - Zalo (registry): unchanged, result `{ success, response: { msgId | message.msgId | message.data.msgId } }`.
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
      threadType = threadId.startsWith('-') ? 1 : 0; // Telegram groups / channels have negative ids
    } else {
      const options = asObject(record.options);
      const typeChat = options && Object.prototype.hasOwnProperty.call(options, 'typeChat') ? options.typeChat : record.typeChat;
      threadType = typeChat === null ? 1 : 0; // Facebook: null = group, 'user' = 1-1
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

// ─── File paths ─────────────────────────────────────────────────────────────

/**
 * Fields that hold ONE file path: the employee app uploads exactly these fields before the proxy call (proxyHelper
 * .prepareLocalFilesForProxy uses this same list), and Boss checks exactly these fields. If a proxy handler takes a path in
 * another field, Boss does NOT check it → it must be added here (photoPath: telegramUser:editChatPhoto; stickerPath: Telegram bot).
 */
export const PROXY_FILE_PATH_FIELDS = ['filePath', 'videoPath', 'thumbPath', 'voicePath', 'avatarPath', 'mediaPath', 'photoPath', 'stickerPath'] as const;
/** Field that holds a list of paths. */
export const PROXY_FILE_PATH_LIST_FIELDS = ['filePaths'] as const;

export interface ProxyPathContext {
  /** Boss media folder (absolute, realpath applied when available). */
  roots: readonly string[];
  /** Path sent by the employee → absolute (FileStorageService.resolveAbsolutePath + realpath if the file exists). */
  resolve: (value: string) => string;
  /**
   * Per-folder permission, takes a path relative to the root: uses the SAME rule as file download /api/media
   * (bossFileAccess: classifyMediaPath + checkMediaAccess). null = allowed.
   */
  checkAccess: (relPathFromRoot: string) => { error: string } | null;
  /** Compare paths the Windows way (default follows the running machine). */
  windows?: boolean;
}

export type ProxyPathDecision =
  | { allowed: true; params: any }
  | { allowed: false; code: 'PATH_FORBIDDEN' | 'ACCOUNT_FORBIDDEN'; error: string; path: string };

/**
 * Checks every file path in the proxy parameters. If valid → returns the params with the paths normalized to absolute
 * (the handler uses exactly the path that was checked, it does not resolve it again differently). Empty or missing fields are skipped.
 */
export function checkProxyFilePaths(params: any, ctx: ProxyPathContext): ProxyPathDecision {
  if (!params || typeof params !== 'object') return { allowed: true, params };
  const windows = ctx.windows ?? process.platform === 'win32';
  const pathImpl = windows ? nodePath.win32 : nodePath.posix;
  const next: any = { ...params };

  const checkOne = (raw: unknown): { ok: true; value: string } | Extract<ProxyPathDecision, { allowed: false }> => {
    if (typeof raw !== 'string') {
      return { allowed: false, code: 'PATH_FORBIDDEN', error: tr('Đường dẫn file không hợp lệ'), path: String(raw) };
    }
    let resolved = '';
    try { resolved = ctx.resolve(raw); } catch { resolved = ''; }
    const root = resolved ? ctx.roots.find((r) => isPathInside(r, resolved, { windows })) : undefined;
    if (!root) {
      return { allowed: false, code: 'PATH_FORBIDDEN', error: tr('Chỉ gửi được file đã tải lên Boss hoặc media có sẵn của Boss'), path: raw };
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

// ─── Merging Telegram reaction poll commands ────────────────────────────────

/** Periodic poll channel: several employees open the same group → Boss asks Telegram only once within this window. */
export const COALESCED_POLL_CHANNELS: ReadonlySet<string> = new Set(['telegramUser:refreshReactions', 'telegramUser:refreshPollResults']);
export const POLL_COALESCE_WINDOW_MS = 15_000;

export interface RecentPoll { at: number; ids: ReadonlySet<string> }

/**
 * The ChatWindow polls Telegram group reactions every 20 s (Telegram only pushes reactions to the message author). Through Boss, each
 * employee who opens the group adds one more GetMessagesReactions call on the SAME Telegram session → easily hits FLOOD_WAIT. Boss has already written
 * the DB and emitted the event to everyone when a reaction changed, so a duplicate command (same account + group, messages already asked about in the
 * window) can be skipped. Returns true = skip this command.
 */
export function shouldSkipCoalescedPoll(recent: RecentPoll | undefined, messageIds: readonly string[], now: number,
  windowMs: number = POLL_COALESCE_WINDOW_MS): boolean {
  if (!recent || now - recent.at >= windowMs || now < recent.at) return false;
  if (messageIds.length === 0) return true;
  return messageIds.every((id) => recent.ids.has(String(id)));
}
