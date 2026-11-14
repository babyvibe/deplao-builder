import React, { useEffect } from 'react';
import { useAccountStore } from '@/store/accounts/accountStore';
import { consumeLocalReaction } from '@/lib/chat/reactions/localReactionRegistry';
import { useShallow } from 'zustand/react/shallow';
import { getMessageCacheKey, getMessageCacheKeysForThread, MessageItem, useChatStore } from '@/store/chat/chatStore';
import { useAppStore, CachedGroupInfo } from '@/store/app/appStore';
import { useCRMStore } from '@/store/crm/crmStore';
import { useStarredStore } from '@/store/chat/starredStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import ipc from '../../lib/ipc'
import DataAccessor, { isReadFailure, refreshLibraryCache } from '../../lib/data/DataAccessor';
import { useEmployeeResync } from '../accounts/useEmployeeResync';
import { LIBRARY_CHANGED_EVENT, LOCAL_PIN_CHANGED_EVENT, THREAD_LABELS_CHANGED_EVENT } from '@/lib/chat/realtime/relayUiEvents';
import { reloadAccountContacts } from '@/lib/chat/conversations/accountContacts';
import { messageQueue } from '@/lib/chat/send/MessageQueue';
import { fetchAllAliases } from '../../lib/zalo/zaloAliasUtils';
import { channelSupports, type Channel } from '@/../configs/channels/channelConfig';
import { installLiveReadPresence, isChatPaneVisible, liveReadSync } from '@/lib/chat/read/liveReadSync';
import { installTelegramDownloadFocus } from '@/lib/media/telegramDownloadFocus';
import { CHANNEL, isZalo, isFacebook, isTelegram, isTelegramForumGeneral } from '@/lib/channels/channelHelper';
import { playNotificationSound, showDesktopNotification, requestNotificationPermission } from '../../lib/notifications/NotificationService';
import { inAppToastAllowed, useInAppNotifyStore } from '@/store/chat/inAppNotifyStore';
import { getFilteredUnreadCount, queueBadgeRefresh } from '@/lib/notifications/badgeUtils';
import { createCatchUpBatcher, isDeferrableCatchUpMessage } from '@/lib/chat/realtime/catchUpEventBatcher';
import { noteForumTopicMessage } from '@/lib/chat/telegram/forumTopicsLive';
import Logger from "../../../utils/Logger";
import { extractUserProfile } from "../../../utils/zalo/profileUtils";
import { BellIcon, ChartIcon, EditIcon, ImageIcon, LinkIcon, SendIcon, UserCheckIcon, WaveIcon, WifiIcon } from '@/components/common/icons';
import { groupAdminRole, groupOwnerRole } from '../../../shared/chat/groupMemberRoles';
import { zaloReactionIconToEmoji } from '../../../shared/zalo/zaloReactions';
import { replyStateForIncoming } from '../../../shared/chat/replyState';
import { zinstantPreviewText } from '../../../shared/zalo/zaloZinstant';
import { botDisconnectMessage } from '../../../shared/telegram/telegramBotStatus';
import { tr } from '../../../shared/i18n';

// ─── Contact fetch cache (7 days) ────────────────────────────────────────────
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_KEY = 'contactFetchTimes';

function getContactFetchTimes(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function setContactFetchTime(key: string) {
  const times = getContactFetchTimes();
  times[key] = Date.now();
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(times)); } catch {}
}
function isContactCacheFresh(key: string): boolean {
  const t = getContactFetchTimes()[key];
  return !!t && (Date.now() - t) < CACHE_TTL_MS;
}

// ─── Alias refresh cache (24 hours) ───────────────────────────────────────────
const ALIAS_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const ALIAS_REFRESH_KEY = 'aliasLastRefreshTimes';

function getAliasRefreshTimes(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(ALIAS_REFRESH_KEY) || '{}'); } catch { return {}; }
}
function setAliasRefreshTime(key: string) {
  const times = getAliasRefreshTimes();
  times[key] = Date.now();
  try { localStorage.setItem(ALIAS_REFRESH_KEY, JSON.stringify(times)); } catch {}
}
function isAliasRefreshFresh(key: string): boolean {
  const t = getAliasRefreshTimes()[key];
  return !!t && (Date.now() - t) < ALIAS_REFRESH_TTL_MS;
}

/**
 * Employee mode: realtime events are echoes of Boss changes ALREADY written to the DB (the Boss relays them to every employee of the account).
 * The handler must not write back to the Boss (profile updates, mark as read, @ flags, aliases…): N machines × each event
 * = N REST calls, and each call emits a relay event to every employee again.
 */
function isEmployeeMode(): boolean {
  return useEmployeeStore.getState().mode === 'employee';
}

/** Re-reads the number of friend requests received for `zaloId` → the number on the CRM tab + the red dot (on a read error: keep as is). */
function syncReceivedFriendRequestBadge(zaloId: string): void {
  DataAccessor.getFriendRequests({ zaloId, direction: 'received' }).then((res: any) => {
    if (isReadFailure(res)) return; // read error ≠ 0 requests: do not clear the red dot
    const count = res?.requests?.length ?? 0;
    if (useAccountStore.getState().activeAccountId === zaloId) {
      useCRMStore.getState().setRequestCount(count);
    }
    if (count === 0) {
      useAppStore.getState().clearCRMRequestUnseen(zaloId);
    }
  }).catch(() => {});
}

// Module-level alias map
const aliasMap = new Map<string, string>();
const aliasLoadInFlight = new Map<string, Promise<void>>();
const aliasLoadLastAttemptAt = new Map<string, number>();
const ALIAS_LOAD_RETRY_COOLDOWN_MS = 5000;

async function loadAliases(zaloId: string) {
  // Only load aliases for Zalo accounts
  const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
  if (!account || !isZalo(account.channel)) return;

  const now = Date.now();
  const lastAttemptAt = aliasLoadLastAttemptAt.get(zaloId) || 0;
  const existing = aliasLoadInFlight.get(zaloId);
  if (existing) {
    return existing;
  }
  if ((now - lastAttemptAt) < ALIAS_LOAD_RETRY_COOLDOWN_MS) {
    return;
  }

  aliasLoadLastAttemptAt.set(zaloId, now);

  const task = (async () => {
    try {
      const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
      if (!account) return;
      const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent, accountId: zaloId };
      const aliasItems = await fetchAllAliases(auth);
      for (const item of aliasItems) {
        if (item.alias && item.userId) {
          const aliasKey = `${zaloId}__${item.userId}`;
          const unchanged = aliasMap.get(aliasKey) === item.alias;
          aliasMap.set(aliasKey, item.alias);
          // Push the alias into chatStore (its own alias field, does NOT overwrite display_name)
          useChatStore.getState().updateContact(zaloId, {
            contact_id: item.userId,
            alias: item.alias,
          });
          // Save to the DB so it survives restarts, only when the alias changes: each save emits db:contactAliasChanged (the Boss relays
          // it to every employee of the account), so previously each connection = one event for EVERY alias. Employees do not save.
          if (!unchanged && !isEmployeeMode()) {
            DataAccessor.setContactAlias({ zaloId, contactId: item.userId, alias: item.alias }).catch(() => {});
          }
        }
      }
    } catch {}
  })();

  aliasLoadInFlight.set(zaloId, task);
  try {
    await task;
  } finally {
    if (aliasLoadInFlight.get(zaloId) === task) {
      aliasLoadInFlight.delete(zaloId);
    }
  }
}

/**
 * Gets the display name of the account from accountStore.
 * Used in the notification title to show which account the message came in on.
 */
function getAccountDisplayName(zaloId: string): string {
  const accounts = useAccountStore.getState().accounts;
  const acc = accounts.find(a => a.zalo_id === zaloId || a.facebook_id === zaloId);
  return acc?.full_name || acc?.zalo_id || zaloId;
}

/**
 * Builds the preview string for last_message / notifications based on the message type.
 * Shared by updateContact (last_message) and showDesktopNotification (msgText).
 */
function buildMessagePreview(
  contentRaw: any,
  rawMsgType: any,
  isImage: boolean,
  contentStr: string,
): string {
  const mt = String(rawMsgType || '').toLowerCase();
  const action = typeof contentRaw === 'object' && contentRaw !== null ? String(contentRaw.action || '') : '';

  // ── chat.recommended call actions ───────────────────────────────────────
  if (action === 'recommened.misscall') return tr('📵 Cuộc gọi nhỡ');
  if (action === 'recommened.calltime') {
    let params: any = {};
    try { const p = contentRaw?.params; params = typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch {}
    const secs = params.duration || 0;
    if (secs > 0) { const m = Math.floor(secs / 60), s = secs % 60; return tr('📞 Cuộc gọi ({{v1}}{{s}}s)', { v1: m > 0 ? `${m}p ` : '', s }); }
    return tr('📞 Cuộc gọi');
  }

  // ── Link preview (action=recommened.link): must be checked before the image heuristic ──
  if (action === 'recommened.link' || action === 'recommended.link') {
    if (typeof contentRaw === 'object' && contentRaw !== null && contentRaw.title && typeof contentRaw.title === 'string') return `🔗 ${contentRaw.title}`;
    return '🔗 Link';
  }

  // ── Bank card action ──────────────────────────────────────────────────────
  if (action === 'zinstant.bankcard') return tr('🏦 Tài khoản ngân hàng');

  // ── Legacy/explicit call types ───────────────────────────────────────────
  if (mt.includes('call') || (typeof contentRaw === 'object' && contentRaw !== null && (contentRaw.call_id || contentRaw.callId || contentRaw.callType !== undefined))) {
    const missed = contentRaw?.missed || contentRaw?.status === 2;
    const secs = contentRaw?.duration || contentRaw?.call_duration;
    if (missed) return tr('📵 Cuộc gọi nhỡ');
    if (secs) { const m = Math.floor(secs / 60), s = secs % 60; return tr('📞 Cuộc gọi ({{v1}}{{s}}s)', { v1: m > 0 ? `${m}p ` : '', s }); }
    return tr('📞 Cuộc gọi');
  }

  // ── Voice / audio ────────────────────────────────────────────────────────
  if (mt.includes('voice') || mt.includes('audio')) {
    const secs = (typeof contentRaw === 'object' && contentRaw !== null) ? (contentRaw?.duration || 0) : 0;
    return tr('🎙 Tin nhắn thoại{{v1}}', { v1: secs ? ` (${secs}s)` : '' });
  }

  // ── Sticker ──────────────────────────────────────────────────────────────
  if (mt.includes('sticker') || (typeof contentRaw === 'object' && contentRaw !== null && (contentRaw.sticker_id || contentRaw.stickerId))) return tr('🎭 Nhãn dán');

  // ── GIF ──────────────────────────────────────────────────────────────────
  if (mt.includes('gif')) return '🎬 GIF';

  // ── Video ────────────────────────────────────────────────────────────────
  if (mt.includes('video')) return '🎥 Video';

  // ── System card (chat.ecard): reminders, group notices ────────────────
  if (mt === 'chat.ecard') {
    if (typeof contentRaw === 'object' && contentRaw !== null && contentRaw.title) return `🔔 ${contentRaw.title}`;
    return tr('🔔 Thông báo');
  }

  // ── Link types (chat.recommended, chat.link, share.link) ───────────────
  if (mt === 'chat.recommended' || mt === 'chat.recommend' || mt === 'chat.link' || mt === 'share.link') {
    if (typeof contentRaw === 'object' && contentRaw !== null && contentRaw.title && typeof contentRaw.title === 'string') return `🔗 ${contentRaw.title}`;
    return '🔗 Link';
  }

  // ── Bank card (chat.webcontent) ────────────────────────────────────────
  if (mt === 'chat.webcontent') {
    if (typeof contentRaw === 'object' && contentRaw !== null && contentRaw.action === 'zinstant.bankcard') return tr('🏦 Tài khoản ngân hàng');
  }
  // ── Official Account news / notices (zinstant) ────────────────
  if (mt === 'chat.webcontent' || mt === 'chat.webcontent.v2') {
    const zinstant = zinstantPreviewText(contentRaw, mt);
    if (zinstant) return zinstant;
  }

  // ── Official Account news (chat.list.action): content is an array of articles ──
  if (mt === 'chat.list.action') {
    let list: any = contentRaw;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
    const items: any[] = Array.isArray(list) ? list : (list && typeof list === 'object' ? [list] : []);
    const first = items.find(it => it && typeof it === 'object' && typeof it.title === 'string' && it.title.trim());
    return first ? `📰 ${first.title.trim()}` : tr('📰 Bản tin');
  }

  // ── Poll ───────────────────────────────────────────────────────────────
  if (mt === 'group.poll' || mt === 'telegram.poll') return tr('📊 Bình chọn');

  // ── Location ──────────────────────────────────────────────────────────
  if (mt === 'chat.location.new') {
    const desc = typeof contentRaw === 'object' && contentRaw !== null ? contentRaw.description : '';
    return desc ? `📍 ${desc}` : tr('📍 [Vị trí]');
  }

  // ── Todo ───────────────────────────────────────────────────────────────
  if (mt === 'chat.todo') return tr('📝 Công việc');

  // ── Image (from type detection - Zalo) ──────────────────────────────────
  if (isImage) return tr('🖼 Hình ảnh');

  // ── Telegram-specific msgTypes ─────────────────────────────────────────
  if (mt === 'photo') return tr('🖼 Hình ảnh');
  if (mt === 'video_note') return '🎬 Video message';
  if (mt === 'audio') return '🎵 Audio';

  // ── File (explicit type) ─────────────────────────────────────────────────
  if (mt.includes('file') || mt === 'share.file') {
    const title = typeof contentRaw === 'object' && contentRaw !== null ? contentRaw?.title : null;
    return title ? `📂 ${title}` : tr('📂 File đính kèm');
  }

  // ── Object content: heuristic detection ─────────────────────────────────
  if (typeof contentRaw === 'object' && contentRaw !== null) {
    // Bank card (webcontent + zinstant.bankcard)
    if (contentRaw.action === 'zinstant.bankcard') return tr('🏦 Tài khoản ngân hàng');
    const params = (() => { try { const p = contentRaw.params; return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } })();
    // File heuristic: title + file-specific fields
    if (contentRaw.title && (params?.fileSize || params?.fileExt || params?.fileUrl || contentRaw.normalUrl || contentRaw.fileUrl)) return `📂 ${contentRaw.title}`;
    // Link heuristic: title + href without image params → link, not image
    if (contentRaw.title && contentRaw.href && !params?.rawUrl && !params?.hd) return `🔗 ${contentRaw.title}`;
    // Image heuristic: has rawUrl/hd, or href/thumb without title
    if (params?.rawUrl || params?.hd) return tr('🖼 Hình ảnh');
    if ((contentRaw.href || contentRaw.thumb) && !contentRaw.title) return tr('🖼 Hình ảnh');
    // title without file markers → plain text (reminder, link preview, etc.)
    if (contentRaw.title && typeof contentRaw.title === 'string') return contentRaw.title;
    if (contentRaw.msg && typeof contentRaw.msg === 'string') return contentRaw.msg;
    if (contentRaw.content && typeof contentRaw.content === 'string') return contentRaw.content;
    return tr('[Đính kèm]');
  }

  return contentStr;
}

function detectImageContent(contentRaw: any, msgType?: string): boolean {
  if (!contentRaw || typeof contentRaw !== 'object') return false;
  // Explicitly photo types → always image
  if (msgType === 'chat.photo' || msgType === 'photo' || msgType === 'image') return true;
  // parse params (may be string)
  let params: any = contentRaw.params;
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
  // File messages: have title + href but NO rawUrl/hd → NOT an image
  if (contentRaw.title && contentRaw.href && !params?.rawUrl && !params?.hd) return false;
  return !!(contentRaw.href || contentRaw.thumb || params?.rawUrl || params?.hd);
}

/** Extracts the image URL from quote data */
function extractQuoteImageUrl(rawQuote: any): string {
  if (!rawQuote) return '';
  const attach = rawQuote.attach;
  const msg = rawQuote.msg;

  // Helper: parse params string → object
  const parseParams = (p: any): any => {
    if (!p) return {};
    if (typeof p === 'string') { try { return JSON.parse(p); } catch { return {}; } }
    return p;
  };

  // Helper: checks whether a URL is a CDN image (avoids returning an ordinary web href)
  const isImageUrl = (url: string): boolean => {
    if (!url) return false;
    return /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) ||
      /zdn\.vn|zadn\.vn|zalo\.me\/[0-9]|cloudfront\.net|imgix/i.test(url);
  };

  // 1. Try attach
  if (attach) {
    try {
      const parsed = typeof attach === 'string' ? JSON.parse(attach) : attach;
      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      if (item && typeof item === 'object') {
        const p = parseParams(item.params);
        const url = p?.hd || p?.rawUrl || item.normalUrl || item.hdUrl || item.hd || item.thumb || item.url
          || item.data?.params?.hd || item.data?.params?.rawUrl || item.data?.href || item.data?.thumb || '';
        if (url) return url;
      }
    } catch {}
  }
  // 2. Try msg
  const msgObj = (msg && typeof msg === 'string' && msg !== '' && msg !== 'null')
    ? (() => { try { return JSON.parse(msg); } catch { return null; } })()
    : (msg && typeof msg === 'object' ? msg : null);

  if (msgObj && typeof msgObj === 'object') {
    const action = String(msgObj.action || '');
    const p = parseParams(msgObj.params);
    // Real image: has params.hd / params.rawUrl
    if (p?.hd || p?.rawUrl) return p.hd || p.rawUrl;
    // Link preview (recommened.link): only use thumb (the thumbnail image), NOT href (the web page URL)
    if (action === 'recommened.link' || action === 'recommended.link') {
      return String(msgObj.thumb || '');
    }
    // Other cases: href is only used if it looks like an image URL
    const hrefUrl = String(msgObj.href || '');
    if (hrefUrl && isImageUrl(hrefUrl)) return hrefUrl;
    return String(msgObj.thumb || '');
  }
  return '';
}

/** Extracts the image URL from the content of the original message (when rawQuote has no image) */
function extractQuoteImageFromContent(content: string, msgType: string): string {
  if (!content) return '';
  // Only extract images from message types that are images
  if (!['photo', 'image', 'chat.photo'].includes(msgType)) {
    // Check whether it is JSON containing an image
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        let params = parsed.params;
        if (typeof params === 'string') {
          try { params = JSON.parse(params); } catch { params = null; }
        }
        // Has title + href but no image params → a link/file, not an image
        if (parsed.title && parsed.href && !params?.hd && !params?.rawUrl) {
          return '';
        }
        // Has image params or thumb → it is an image
        return params?.hd || params?.rawUrl || parsed.href || parsed.thumb || '';
      }
    } catch {}
    return '';
  }
  // It is an image → extract the URL
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      let params = parsed.params;
      if (typeof params === 'string') {
        try { params = JSON.parse(params); } catch { params = null; }
      }
      return params?.hd || params?.rawUrl || parsed.href || parsed.thumb || '';
    }
  } catch {}
  return '';
}

function extractContent(contentRaw: any, fallbackMessage?: string, msgType?: string): string {
  if (contentRaw === null || contentRaw === undefined) {
    return fallbackMessage ? String(fallbackMessage) : '';
  }
  if (typeof contentRaw === 'string') return contentRaw;
  if (typeof contentRaw !== 'object') return String(contentRaw);
  if (detectImageContent(contentRaw, msgType)) return JSON.stringify(contentRaw);
  const text =
    (typeof contentRaw.content === 'string' ? contentRaw.content : null) ??
    (typeof contentRaw.msg === 'string' ? contentRaw.msg : null) ??
    (typeof contentRaw.message === 'string' ? contentRaw.message : null) ??
    (typeof contentRaw.text === 'string' ? contentRaw.text : null);
  if (text !== null) return text;
  return JSON.stringify(contentRaw);
}

/** Background fetch of contact info, alias first, cached for 7 days */
export async function fetchContactInfo(zaloId: string, contactId: string): Promise<void> {
  const cacheKey = `${zaloId}__${contactId}`;
  const contacts = useChatStore.getState().contacts[zaloId] || [];
  const existing = contacts.find((c) => c.contact_id === contactId);
  const hasFullInfo = existing &&
    existing.display_name && existing.display_name !== contactId &&
    existing.avatar_url;

  if (hasFullInfo && isContactCacheFresh(cacheKey)) return;
  setContactFetchTime(cacheKey);

  try {
    const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
    if (!account) return;
    // Guard: only Zalo uses ipc.zalo.getUserInfo. FB uses getUserInfoFacebook, Telegram uses the adapter.
    if (!isZalo(account.channel)) return;
    const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent, accountId: zaloId };
    const res = await ipc.zalo?.getUserInfo({ auth, userId: contactId });

    const rawProfile = res?.response?.changed_profiles?.[contactId]
      || res?.response?.data?.[contactId];
    if (!rawProfile) return;

    // ── Centralized extraction ──────────────────────────────────────────
    const { displayName: realName, avatar: avatarUrl, phone, gender, birthday, alias: apiAlias } = extractUserProfile(rawProfile);

    // Alias: from getUserInfo OR from the alias map already loaded
    const cachedAlias = aliasMap.get(`${zaloId}__${contactId}`);
    const resolvedAlias = apiAlias || cachedAlias || '';


    if (!realName) return;

    // Always update display_name = the real name from Zalo (not mixed with the alias)
    useChatStore.getState().updateContact(zaloId, {
      contact_id: contactId,
      display_name: realName,
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      ...(phone ? { phone } : {}),
      // Separate alias - only set if present
      ...(resolvedAlias ? { alias: resolvedAlias } : {}),
    });

    // Save the real name + gender + birthday to the DB
    DataAccessor.updateContactProfile({ zaloId, contactId, displayName: realName, avatarUrl, phone, gender, birthday }).catch(() => {});

    // Save the alias to the DB if present (its own field, does not overwrite display_name)
    if (resolvedAlias) {
      aliasMap.set(`${zaloId}__${contactId}`, resolvedAlias);
      DataAccessor.setContactAlias({ zaloId, contactId, alias: resolvedAlias }).catch(() => {});
    }
  } catch {
    const times = getContactFetchTimes();
    delete times[cacheKey];
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(times)); } catch {}
  }
}

/** Background refresh of the alias only (not the full profile). Cached for 24 hours, silent on failure. */
export async function refreshContactAlias(zaloId: string, contactId: string): Promise<void> {
  const aliasCacheKey = `${zaloId}__${contactId}`;
  if (isAliasRefreshFresh(aliasCacheKey)) return;

  try {
    const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
    if (!account) return;
    // Guard: only Zalo uses ipc.zalo.getUserInfo
    if (!isZalo(account.channel)) return;
    const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent, accountId: zaloId };
    const res = await ipc.zalo?.getUserInfo({ auth, userId: contactId });
    const rawProfile = res?.response?.changed_profiles?.[contactId]
      || res?.response?.data?.[contactId];
    if (!rawProfile) return;

    const { alias: apiAlias } = extractUserProfile(rawProfile);
    if (!apiAlias) return;

    const cachedAlias = aliasMap.get(`${zaloId}__${contactId}`);
    const resolvedAlias = apiAlias || cachedAlias || '';
    if (!resolvedAlias) return;

    useChatStore.getState().updateContact(zaloId, {
      contact_id: contactId,
      alias: resolvedAlias,
    });
    aliasMap.set(`${zaloId}__${contactId}`, resolvedAlias);
    DataAccessor.setContactAlias({ zaloId, contactId, alias: resolvedAlias }).catch(() => {});
    setAliasRefreshTime(aliasCacheKey);
  } catch {
    // On failure, do NOT set the timestamp so it retries next time
  }
}

// Throttle set: avoid fetching the group again and again within 60s
const fetchingGroups = new Set<string>();

// ─── Throttle set: fetch the personal info of each group member ──────────────
const fetchingMemberInfo = new Set<string>();

/**
 * Fetch individual group member's displayName + avatar using getUserInfo API.
 * Called when a group message arrives from a sender_id that has no name/avatar yet.
 * Updates: contact store + groupInfoCache + DB.
 * Throttle: each member is fetched at most once per 60s.
 */
async function fetchGroupMemberInfo(zaloId: string, memberId: string, groupId: string): Promise<void> {
  const key = `${zaloId}__${memberId}`;
  if (fetchingMemberInfo.has(key)) return;
  fetchingMemberInfo.add(key);
  // Clear the throttle after 60s to allow a refresh later
  setTimeout(() => fetchingMemberInfo.delete(key), 60_000);

  try {
    const account = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
    // Zalo only: Telegram can also "quản lý nhóm" (manage groups), so the old capability check wrongly called zalo:getUserInfo for the
    // Telegram account (main blocks it: "explicit account … is not an active Zalo connection"), one wasted IPC per group message
    if (!account || !isZalo(account.channel)) return;

    const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent, accountId: zaloId };
    const res = await ipc.zalo?.getUserInfo({ auth, userId: memberId });
    if (!res?.success || !res.response) return;

    const profile = res.response.changed_profiles?.[memberId];
    if (!profile) return;

    const displayName = profile.displayName || profile.zaloName || '';
    const avatar = profile.avatar || '';
    if (!displayName && !avatar) return;

    // 1. Update the contact store so ChatWindow renders right away
    if (displayName || avatar) {
      useChatStore.getState().updateContact(zaloId, {
        contact_id: memberId,
        ...(displayName ? { display_name: displayName } : {}),
        ...(avatar ? { avatar_url: avatar } : {}),
      });
    }

    // 2. Update groupInfoCache
    if (displayName || avatar) {
      const cached = useAppStore.getState().groupInfoCache?.[zaloId]?.[groupId];
      if (cached?.members) {
        const members = [...cached.members];
        const idx = members.findIndex(m => m.userId === memberId);
        if (idx >= 0) {
          members[idx] = {
            ...members[idx],
            ...(displayName ? { displayName } : {}),
            ...(avatar ? { avatar } : {}),
          };
        } else {
          members.push({
            userId: memberId,
            displayName: displayName || memberId,
            avatar: avatar || '',
            role: 0,
          });
        }
        useAppStore.getState().setGroupInfo(zaloId, groupId, {
          ...cached,
          members,
          fetchedAt: Date.now(),
        });
      }
    }

    // 3. Save to DB
    await DataAccessor.saveGroupMembers({
      zaloId, groupId,
      members: [{
        memberId,
        displayName: displayName || memberId,
        avatar: avatar || '',
        role: 0,
      }],
    }).catch(() => {});

    if (displayName || avatar) {
      DataAccessor.updateContactProfile({
        zaloId, contactId: memberId,
        displayName: displayName || memberId,
        avatarUrl: avatar,
        phone: '',
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('[useZaloEvents] fetchGroupMemberInfo error:', err);
  }
}

/**
 * Unified: fetch the group info (name, avatar) + member list from one API call.
 *
 * Priority:
 *  1. Check the DB (contact + members): uses ipc.db instead of the in-memory store so it is always accurate
 *  2. If the group is not in the DB yet (first time) → call getGroupInfo right away (bypass throttle)
 *  3. If the group has a contact but no members yet → call getGroupInfo
 *  4. If the info is complete → skip
 *
 * @param forceNotifUpdate  When true: after the fetch finishes, push the new name/avatar into the store
 *                          so notifications afterwards use the right name (used when the first message arrives)
 */
async function fetchGroupInfoAndMembers(zaloId: string, groupId: string, forceNotifUpdate = false): Promise<void> {
  const key = `${zaloId}__${groupId}`;

  // Guard: only fetch group info for Zalo accounts
  const _acc = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
  if (!_acc || !isZalo(_acc.channel)) return;

  // Quick in-memory check first to avoid an unnecessary IPC round-trip
  const inMemory = useChatStore.getState().contacts[zaloId]?.find(c => c.contact_id === groupId);
  const inMemoryHasRealName = !!(inMemory?.display_name &&
    inMemory.display_name !== groupId &&
    !/^\d+$/.test(inMemory.display_name));

  // Bypass the throttle if there is no real name yet (first time seeing this group)
  const bypassThrottle = !inMemoryHasRealName;
  if (!bypassThrottle && fetchingGroups.has(key)) return;

  fetchingGroups.add(key);
  // Release the throttle after 5 minutes to allow a refresh later
  setTimeout(() => fetchingGroups.delete(key), 5 * 60_000);

  try {
    const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
    if (!account) { fetchingGroups.delete(key); return; }

    // 1. Check the DB contact directly (not the in-memory store, which may not be synced yet). DataAccessor: employee mode
    // reads the conversations on the BOSS (ipc.db.getContacts on the employee machine is only a stub → always "chưa có tên" (no name yet) → an unnecessary Zalo API call)
    let hasRealName = inMemoryHasRealName;
    if (!hasRealName) {
      try {
        const existing: any = await DataAccessor.getConversationById(zaloId, groupId);
        hasRealName = !!(existing?.display_name &&
          existing.display_name !== groupId &&
          !/^\d+$/.test(existing.display_name));
      } catch {
        // Fall back to in-memory if the DB query fails
        hasRealName = inMemoryHasRealName;
      }
    }

    // 2. Check the members in the DB
    let hasMembers = false;
    try {
      const membersRes = await DataAccessor.getGroupMembers({ zaloId, groupId });
      hasMembers = (membersRes?.members?.length || 0) > 0;
    } catch {}

    // If the info is complete and no forced update is needed → skip
    if (hasRealName && hasMembers && !forceNotifUpdate) {
      fetchingGroups.delete(key);
      return;
    }

    // 3. Call the getGroupInfo API once
    const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent };
    const res = await ipc.zalo?.getGroupInfo({ auth, groupId });
    const info = res?.response?.gridInfoMap?.[groupId] || res?.response;
    if (!info) { fetchingGroups.delete(key); return; }

    const name = info.name || info.groupName || '';
    const avatar = info.avt || info.avatar || info.thumb || '';
    const creatorId: string = info.creatorId || info.creator || '';
    const adminIds: string[] = info.adminIds || info.subAdmins || [];

    // 4. Update the contact if there is no real name yet OR forceNotifUpdate
    if ((!hasRealName || forceNotifUpdate) && name) {
      useChatStore.getState().updateContact(zaloId, {
        contact_id: groupId,
        display_name: name,
        ...(avatar ? { avatar_url: avatar } : {}),
        contact_type: 'group',
      });
      DataAccessor.updateContactProfile({
        zaloId,
        contactId: groupId,
        displayName: name,
        avatarUrl: avatar,
        phone: '',
        contactType: 'group',
      }).catch(() => {});
    }

    // 5. Parse and save the members (only if none saved yet)
    if (!hasMembers) {
      const rawMembers: any[] = info.memVerList || info.memberList || info.members || info.currentMems || [];
      if (rawMembers.length > 0) {
        // memVerList can be an array of strings "uid_version" or an array of objects
        const members = rawMembers.map((m: any) => {
          let memberId: string;
          if (typeof m === 'string') {
            memberId = m.replace(/_\d+$/, '');
          } else {
            memberId = String(m.id || m.userId || m.uid || m.memberId || '');
          }
          return {
            memberId,
            displayName: (typeof m === 'object' ? (m.dName || m.displayName || m.name || '') : ''),
            avatar: (typeof m === 'object' ? (m.avt || m.avatar || '') : ''),
            // Zalo convention (as in the DB / CRM): group leader = 2, deputy = 1 (previously these were written the other way round: 1 / 2)
            role: ((creatorId && memberId === String(creatorId).replace(/_0$/, '')) || (typeof m === 'object' && m.type === 1))
              ? groupOwnerRole('zalo')
              : (adminIds.includes(memberId) ? groupAdminRole('zalo') : 0),
          };
        }).filter((m: any) => m.memberId);

        if (members.length > 0) {
          await DataAccessor.saveGroupMembers({ zaloId, groupId, members }).catch(() => {});
          // Update groupInfoCache
          const cached = useAppStore.getState().groupInfoCache?.[zaloId]?.[groupId];
          useAppStore.getState().setGroupInfo(zaloId, groupId, {
            ...(cached || { groupId, name: name || '', avatar: avatar || '', memberCount: members.length, creatorId, adminIds, settings: info.setting || {}, fetchedAt: 0 }),
            members: members.map((m: any) => ({
              userId: m.memberId,
              displayName: m.displayName,
              avatar: m.avatar,
              role: m.role,
            })),
            memberCount: members.length,
            name: name || cached?.name || '',
            avatar: avatar || cached?.avatar || '',
            creatorId: creatorId || cached?.creatorId || '',
            adminIds: adminIds.length ? adminIds : (cached?.adminIds || []),
            fetchedAt: Date.now(),
          });
          return;
        }
      }
    }

    // 6. Update groupInfoCache (info only, no new members)
    const cached = useAppStore.getState().groupInfoCache?.[zaloId]?.[groupId];
    useAppStore.getState().setGroupInfo(zaloId, groupId, {
      groupId,
      name: name || cached?.name || '',
      avatar: avatar || cached?.avatar || '',
      memberCount: info.totalMember || cached?.memberCount || 0,
      members: cached?.members || [],
      creatorId: creatorId || cached?.creatorId || '',
      adminIds: adminIds.length ? adminIds : (cached?.adminIds || []),
      settings: info.setting || cached?.settings || {},
      fetchedAt: Date.now(),
    });
  } catch (err: any) {
    // On error → clear the throttle right away so it retries
    fetchingGroups.delete(key);
  }
}

/** @deprecated - kept for reference only, use fetchGroupInfoAndMembers */
// fetchGroupInfo and fetchGroupMembers merged into fetchGroupInfoAndMembers above

export function useZaloEvents() {
  const { updateAccountStatus, updateListenerActive } = useAccountStore(useShallow(s => ({
    updateAccountStatus: s.updateAccountStatus, updateListenerActive: s.updateListenerActive,
  })));
  const { addMessage, updateContact, incrementUnread, updateMessageReaction, replaceMessageReactions, updateMessageLocalPath, setTyping, setSeen, markReplied, clearUnread, setActiveThread, setMessages } = useChatStore(useShallow(s => ({
    addMessage: s.addMessage, updateContact: s.updateContact, incrementUnread: s.incrementUnread,
    updateMessageReaction: s.updateMessageReaction, replaceMessageReactions: s.replaceMessageReactions,
    updateMessageLocalPath: s.updateMessageLocalPath, setTyping: s.setTyping, setSeen: s.setSeen,
    markReplied: s.markReplied, clearUnread: s.clearUnread, setActiveThread: s.setActiveThread,
    setMessages: s.setMessages,
  })));
  const { showNotification, setGroupInfo } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, setGroupInfo: s.setGroupInfo,
  })));

  // Track window focus state from main process (reliable, unlike document.hasFocus())
  const windowFocusedRef = React.useRef<boolean>(document.hasFocus());
  useEffect(() => {
    const unsub = ipc.on('app:windowFocus', (focused: boolean) => {
      windowFocusedRef.current = focused;
    });
    return unsub;
  }, []);


  // Request OS notification permission on mount
  useEffect(() => { requestNotificationPermission(); }, []);

  // ── QR login finished while the Add Account window was closed ─────────
  // Users often close the window after the phone reports success while Deplao is still fetching the session: main still saves + connects the
  // account, but the list is only loaded inside that window → the account only appears after reopening the app. Always reload it here.
  useEffect(() => {
    const unsub = ipc.on('qr:update', (data: any) => {
      if (data?.status !== 'success') return;
      const modalOpen = useAppStore.getState().addAccountModalOpen;
      ipc.login?.getAccounts().then((res: any) => {
        if (!Array.isArray(res?.accounts)) return;
        useAccountStore.getState().setAccounts(res.accounts);
        if (!modalOpen) showNotification(tr('Đã thêm tài khoản Zalo vào Deplao'), 'success');
      }).catch(() => {});
    });
    return unsub;
  }, [showNotification]);

  // ── Handle notification click → open the right conversation ──────────────
  useEffect(() => {
    const unsub = ipc.on('app:openThread', (data: any) => {
      const { zaloId, threadId, threadType } = data;
      if (!zaloId || !threadId) return;

      // Special case: click on a friend request notification
      if (threadId === '__friend_requests__') {
        const { activeAccountId, setActiveAccount } = useAccountStore.getState();
        if (activeAccountId !== zaloId) {
          setActiveAccount(zaloId);
        }
        useCRMStore.getState().setTab('requests');
        useAppStore.getState().setView('crm');
        setTimeout(() => window.dispatchEvent(new CustomEvent('nav:friendRequests')), 100);
        return;
      }

      const chatStore = useChatStore.getState();
      const { activeAccountId, setActiveAccount } = useAccountStore.getState();

      // 1. Save the thread notification to perAccountThread BEFORE switching account
      //    → the ConversationList effect([activeAccountId]) will restore this exact thread
      //    instead of the account's old thread
      chatStore.saveAccountThread(zaloId, threadId, threadType || 0);

      // 2. Switch to the right account if needed (multi-account)
      if (activeAccountId !== zaloId) {
        setActiveAccount(zaloId);
      }

      // 3. Switch to the Chat tab
      useAppStore.getState().setView('chat');

      // 4. On mobile: show the chat screen
      useAppStore.getState().setMobileShowChat(true);

      // 5. Employee mode: do not load contacts from the local DB, let REST/DataAccessor handle it
      // 6. Navigate to the right thread: use a short setTimeout to make sure
      //    the ConversationList effect has finished running (if an account switch happened)
      const applyThread = () => {
        setActiveThread(threadId, threadType);
      };

      if (activeAccountId !== zaloId) {
        // Delay when switching account → wait for the ConversationList effect to finish
        setTimeout(applyThread, 50);
      } else {
        applyThread();
      }

      // 7. Clear unread, mark as read, update badge
      DataAccessor.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
      clearUnread(zaloId, threadId);
      // Clear @mention flag when messages are read
      DataAccessor.setContactFlags?.({ zaloId, contactId: threadId, flags: { has_mention: 0 } }).catch(() => {});
      useChatStore.getState().updateContact(zaloId, { contact_id: threadId, has_mention: 0 } as any);
      // Clicking a notification = actively opening the conversation → report it as read to the platform, same as clicking in the list
      // (Zalo: seen the latest incoming message; Telegram: ReadHistory + @ + reaction; Facebook: read receipt)
      void liveReadSync.syncOpenedThread({ accountId: zaloId, threadId, threadType: Number(threadType) === 1 ? 1 : 0 });
      ipc.app?.setBadge(Math.max(0, getFilteredUnreadCount()));

      // 8. Auto-fetch user info for the thread if missing (after the contacts have loaded)
      if (threadType !== 1) { // Not applied to groups
        const accountInfo = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
        const channel = accountInfo?.channel || CHANNEL.ZALO;
        setTimeout(() => {
          const updatedContacts = useChatStore.getState().contacts[zaloId] || [];
          const ct = updatedContacts.find((c: any) => c.contact_id === threadId);
          if (!ct) return;

          const hasRealName = !!(ct.display_name && ct.display_name !== threadId && !/^\d+$/.test(ct.display_name));
          const hasAvatar = !!ct.avatar_url;
          if (hasRealName && hasAvatar) return;

          if (isZalo(channel)) {
            fetchContactInfo(zaloId, threadId).catch(() => {});
          } else if (isFacebook(channel)) {
            ipc.fb?.getUserInfoFacebook({ accountId: zaloId, userId: threadId })
              .then((res: any) => {
                if (res?.success && (res.name || res.avatarUrl)) {
                  const patch: any = { contact_id: threadId, channel: 'facebook' };
                  if (res.name) patch.display_name = res.name;
                  if (res.avatarUrl) patch.avatar_url = res.avatarUrl;
                  useChatStore.getState().updateContact(zaloId, patch);
                }
              }).catch(() => {});
            if (/^\d+$/.test(threadId)) {
              ipc.fb?.refreshContactAvatar({ accountId: zaloId, userId: threadId }).catch(() => {});
            }
          } else if (isTelegram(channel)) {
            // Telegram: contact info comes from MTProto/Bot API during message sync
          }
        }, 500); // Wait for contacts to load from the DB
      }
    });
    return unsub;
  }, []);

  // ── event:friendRequest → in-app notification (focused) / desktop notification (unfocused) ──
  useEffect(() => {
    const unsub = ipc.on('event:friendRequest', (data: any) => {
      const { zaloId, requester } = data;
      if (!zaloId || !requester) return;
      const userId: string = requester.userId || '';
      const displayName: string = requester.displayName || userId || tr('Ai đó');
      const avatar: string = requester.avatar || '';
      const msg: string = requester.msg || '';

      const notifSettings = useAppStore.getState().getNotifSettingsForAccount(zaloId);
      const currentAppState = useAppStore.getState();
      const currentCRMState = useCRMStore.getState();
      const currentAccountState = useAccountStore.getState();
      const isViewingRequests =
        currentAppState.view === 'crm' &&
        currentCRMState.tab === 'requests' &&
        currentAccountState.activeAccountId === zaloId;

      if (isViewingRequests) {
        currentAppState.clearCRMRequestUnseen(zaloId);
      } else {
        currentAppState.markCRMRequestUnseen(zaloId);
      }

      if (currentAccountState.activeAccountId === zaloId) {
        DataAccessor.getFriendRequests({ zaloId, direction: 'received' }).then((res: any) => {
          if (isReadFailure(res)) return; // read error ≠ 0 requests: keep the number shown
          const count = res?.requests?.length ?? 0;
          useCRMStore.getState().setRequestCount(count);
        }).catch(() => {});
      }

      // Notification.permission is kept in sync with the macOS system notification authorization (Electron 20+)
      // When the user turns notifications off on macOS → permission = 'denied' → no sound / popup
      const notifAllowed = !('Notification' in window) || Notification.permission === 'granted';

      // Sound: only plays when both the in-app soundEnabled AND macOS allow notifications
      if (notifSettings.soundEnabled && notifAllowed) {
        playNotificationSound(notifSettings.volume);
      }

      if (windowFocusedRef.current) {
        // ── App is focused → show in-app notification with accept/reject buttons ──
        window.dispatchEvent(new CustomEvent('friendRequest:show', {
          detail: { zaloId, userId, displayName, avatar, msg },
        }));
      } else {
        // ── App is NOT focused → desktop notification + flash taskbar ──
        if (notifSettings.desktopEnabled && notifAllowed) {
          const accName = getAccountDisplayName(zaloId);
          showDesktopNotification(
            tr('[{{accName}}] 🤝 Lời mời kết bạn', { accName }),
            `${displayName}${msg ? `: "${msg}"` : tr(' muốn kết bạn với bạn')}`,
            avatar || undefined,
            { zaloId, threadId: '__friend_requests__', threadType: 0 }
          );
          // flashFrame (dock bounce on Mac) must sit inside desktopEnabled so it turns off with the popup
          ipc.app?.flashFrame?.(true);
        }
      }
    });
    return unsub;
  }, []);

  // ── event:friendRequestRemoved → sync red dot + request count ───────────
  useEffect(() => {
    const unsub = ipc.on('event:friendRequestRemoved', (data: any) => {
      const { zaloId, direction } = data || {};
      if (!zaloId || (direction !== 'received' && direction !== 'all')) return;
      syncReceivedFriendRequestBadge(zaloId);
    });

    return unsub;
  }, []);

  // ── event:friendRemoved → clear the friend mark (unfriended on Zalo / another machine) ──
  useEffect(() => {
    const unsub = ipc.on('event:friendRemoved', (data: any) => {
      const zaloId = String(data?.zaloId || '');
      const userId = String(data?.userId || '');
      if (!zaloId || !userId) return;
      const contact = (useChatStore.getState().contacts[zaloId] || []).find(c => c.contact_id === userId);
      // Only edit an existing conversation (do not create a new one just because of a friend event)
      if (contact && contact.is_friend !== 0) {
        useChatStore.getState().updateContact(zaloId, { contact_id: userId, is_friend: 0 });
      }
    });
    return unsub;
  }, []);

  // ── event:friendAccepted → notification + update the contact store ──────────
  useEffect(() => {
    const unsub = ipc.on('event:friendAccepted', (data: any) => {
      const { zaloId, userId, requester } = data || {};
      if (!zaloId || !userId) return;

      // Update the contact in the store: mark is_friend = 1
      const { updateContact } = useChatStore.getState();
      if (updateContact) updateContact(zaloId, { contact_id: userId, is_friend: 1 });
      // The Boss deleted this person's request (sent / received) → sync the request count + red dot
      syncReceivedFriendRequestBadge(zaloId);

      const displayName = requester?.displayName || userId;
      const avatar: string = requester?.avatar || '';

      const notifForAccount = useAppStore.getState().getNotifSettingsForAccount(zaloId);
      if (notifForAccount.desktopEnabled) {
        const accName = getAccountDisplayName(zaloId);
        showDesktopNotification(
          tr('[{{accName}}] ✅ Đã chấp nhận kết bạn', { accName }),
          tr('{{displayName}} đã chấp nhận lời mời kết bạn của bạn', { displayName }),
          avatar || undefined,
          { zaloId, threadId: userId, threadType: 0 }
        );
      }
    });
    return unsub;
  }, []);

  // ── Whether the user is active (mouse / keyboard): report as read to the platform only when they are at the machine ──
  useEffect(() => installLiveReadPresence(), []);

  // ── Telegram conversation open → the file (image / video) download queue of that account fetches this conversation first ──
  useEffect(() => installTelegramDownloadFocus(), []);

  // ── When the window regains focus → clear unread of the active thread ──
  useEffect(() => {
    const handleFocus = () => {
      windowFocusedRef.current = true;
      const { activeThreadId: tid, activeTopicId } = useChatStore.getState();
      const { activeAccountId } = useAccountStore.getState();
      // On another page (Overview, CRM, Settings…): a remembered conversation is not shown on screen → it is still unread
      if (!tid || !activeAccountId || !isChatPaneVisible()) return;
      clearUnread(activeAccountId, tid);
      DataAccessor.markAsRead({ zaloId: activeAccountId, contactId: tid }).catch(() => {});
      const activeContact = (useChatStore.getState().contacts[activeAccountId] || []).find(c => c.contact_id === tid);
      const focusThreadType = activeContact?.contact_type === 'group' ? 1 : 0;
      // Platforms (Zalo / Telegram / Facebook): report when the user acts; focus when the app opens does not count as seen
      liveReadSync.noteThreadShown({ accountId: activeAccountId, threadId: tid, threadType: focusThreadType, topicId: activeTopicId });
      ipc.app?.setBadge(getFilteredUnreadCount());
    };
    const handleBlur = () => { windowFocusedRef.current = false; };
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
    };
  }, [clearUnread]);

  useEffect(() => {
    // ─── Pending employee sender map (must be before event:message handler) ───
    const pendingEmployeeSenders = new Map<string, { employee_id: string; employee_name: string; employee_avatar: string }>();
    const contactRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Electron delivers the IPC notifications independently. A tiny Telegram
    // sticker can finish downloading and emit event:localPath before the
    // preceding event:message has reached this renderer. Keep that path until
    // its message enters the store instead of showing a permanent [Sticker]
    // placeholder until the user reopens the conversation from the DB.
    const pendingLocalPaths = new Map<string, { zaloId: string; threadId: string; msgId: string; localPaths: Record<string, string>; retries: number }>();
    const pendingLocalPathTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const localPathKey = (zaloId: string, threadId: string, msgId: string) => `${zaloId}\u0000${threadId}\u0000${msgId}`;
    const messageExistsInStore = (zaloId: string, threadId: string, msgId: string) => {
      const store = useChatStore.getState();
      return getMessageCacheKeysForThread(store.messages, zaloId, threadId)
        .some(key => (store.messages[key] || []).some(message => String(message.msg_id) === String(msgId)));
    };
    const clearPendingLocalPath = (key: string) => {
      const timer = pendingLocalPathTimers.get(key);
      if (timer) clearTimeout(timer);
      pendingLocalPathTimers.delete(key);
      pendingLocalPaths.delete(key);
    };
    const flushPendingLocalPath = (key: string) => {
      const pending = pendingLocalPaths.get(key);
      if (!pending) return;
      if (messageExistsInStore(pending.zaloId, pending.threadId, pending.msgId)) {
        updateMessageLocalPath(pending.zaloId, pending.threadId, pending.msgId, pending.localPaths);
        clearPendingLocalPath(key);
        return;
      }
      // Keep a bounded buffer for a temporarily busy renderer. The normal
      // path flushes synchronously from event:message; retries are only a
      // safety net for IPC delivery order.
      if (pending.retries >= 12) {
        clearPendingLocalPath(key);
        return;
      }
      pending.retries += 1;
      const timer = setTimeout(() => {
        pendingLocalPathTimers.delete(key);
        flushPendingLocalPath(key);
      }, 100 * pending.retries);
      pendingLocalPathTimers.set(key, timer);
    };

    const applyPendingEmployeeSender = (zaloId: string, threadId: string, msgId: string) => {
      if (!msgId) return;
      const pendingKey = `${zaloId}_${threadId}_${msgId}`;
      const pending = pendingEmployeeSenders.get(pendingKey);
      if (!pending) return;
      pendingEmployeeSenders.delete(pendingKey);

      const chatState = useChatStore.getState();
      const key = `${zaloId}_${threadId}`;
      const msgs = chatState.messages[key] as MessageItem[] | undefined;
      if (!msgs) return;
      const idx = msgs.findIndex((m) => m.msg_id === msgId || m.cli_msg_id === msgId);
      if (idx >= 0) {
        const updated = msgs.slice();
        updated[idx] = { ...updated[idx], handled_by_employee: pending.employee_id } as any;
        useChatStore.setState((s) => ({
          messages: { ...s.messages, [key]: updated },
        }));
      }
    };

    const handleIncomingMessage = (data: any) => {
      const { zaloId, message } = data;
      const isGroup = message.type === 1;
      const isSelf: boolean = message.isSelf === true;
      const isSilent: boolean = message._silent === true; // Old messages - no sound/notification
      const suppressNotification: boolean = message._silentNotification === true; // Telegram difference/reconnect recovery
      const threadId: string = message.threadId || '';
      // Realtime payloads carry the channel on the envelope, while DB-loaded
      // rows already include it. Persist it into the live store as well: media
      // renderers (notably Telegram .tgs/.webp stickers) use msg.channel to
      // choose their decoder. Without this the freshly received sticker is
      // parsed as a Zalo sticker until the conversation is reloaded from DB.
      const accountChannel = useAccountStore.getState().accounts
        .find(account => account.zalo_id === zaloId)?.channel;
      const messageChannel = (message.channel || data.channel || accountChannel || CHANNEL.ZALO) as Channel;
      if (!threadId || threadId === 'undefined' || threadId === 'null') return;
      const incomingTopicId = message.data?.topicId ? String(message.data.topicId) : '';
      const chatState = useChatStore.getState();
      const cacheTopicId = incomingTopicId || (
        chatState.activeThreadId === threadId && isTelegramForumGeneral(chatState.activeTopicId)
          ? '1'
          : ''
      );

      const uidFrom: string = message.data?.uidFrom || '';
      const contentRaw = message.data?.content;
      const rawMsgType = message.data?.msgType;
      const isImage = detectImageContent(contentRaw, rawMsgType ? String(rawMsgType) : undefined);

      const content = isImage
        ? JSON.stringify(contentRaw)
        : contentRaw == null
          ? String(message.data?.message || '')
          : typeof contentRaw === 'object'
            ? JSON.stringify(contentRaw)
            : String(contentRaw);

      // Prefer rawMsgType (share.file, photo, etc.); fall back to image detection
      const msgType = rawMsgType ? String(rawMsgType) : (isImage ? 'image' : 'text');
      const timestamp = parseInt(message.data?.ts) || Date.now();
      const rawAttachments = Array.isArray(message.data?.attachments)
        ? message.data.attachments
        : [];
      const mentionAttachments = (Array.isArray(message.data?.mentions) ? message.data.mentions : [])
        .map((mention: any) => ({
          type: 'zalo_mention',
          offset: Math.max(0, Number(mention?.pos || 0)),
          length: Math.max(0, Number(mention?.len || 0)),
          user_id: String(mention?.uid || ''),
          kind: String(mention?.uid || '') === '-1' || Number(mention?.type) === 1 ? 'all' : 'user',
        }))
        .filter((mention: any) => mention.user_id && mention.length > 0);
      const liveAttachments = [...rawAttachments, ...mentionAttachments];

      // Quote
      let quote_data: string | undefined = typeof message.data?.quoteData === 'string'
        ? message.data.quoteData
        : undefined;
      const rawQuote = message.data?.quote;
      if (rawQuote && rawQuote.globalMsgId) {
        // Find the original message in the store to get the full info (rawQuote is often empty)
        const allMessages = useChatStore.getState().messages[
          getMessageCacheKey(zaloId, threadId, cacheTopicId)
        ] || [];
        const origMsg = allMessages.find(m => m.msg_id === String(rawQuote.globalMsgId));

        let quotedMsg = rawQuote.msg ?? '';
        let quotedMsgType = rawQuote.msgType || '';
        let quotedAttach = rawQuote.attach ?? '';

        // CRITICAL: Zalo platformType 2 (web) puts the content in attach, platformType 1 (app) puts it in msg
        // If msg is empty and attach has data → take it from attach
        if ((!quotedMsg || quotedMsg === 'null' || quotedMsg === '') && quotedAttach && quotedAttach !== 'null') {
          quotedMsg = quotedAttach;
        }

        // If the original message was found, take the info from it
        if (origMsg) {
          quotedMsgType = origMsg.msg_type || '';
          // If rawQuote.msg is still empty (both msg and attach are empty), take it from origMsg.content
          if (!quotedMsg || quotedMsg === 'null') {
            quotedMsg = origMsg.content || '';
          }
          // If rawQuote.attach is empty, take it from origMsg.attachments
          if (!quotedAttach || quotedAttach === 'null') {
            quotedAttach = origMsg.attachments || '';
          }
        } else {
          // origMsg not found → detect msgType from quotedMsg (msg + attach merged)
          if (!quotedMsgType && quotedMsg) {
            try {
              const parsed = JSON.parse(quotedMsg);
              if (parsed && typeof parsed === 'object') {
                // Detect based on structure
                if (parsed.action === 'recommened.link' || parsed.action === 'recommended.link') {
                  quotedMsgType = 'share.link';
                } else if (parsed.title && parsed.href) {
                  // Has params.fileSize/fileExt → file
                  let params = parsed.params;
                  if (typeof params === 'string') {
                    try { params = JSON.parse(params); } catch {}
                  }
                  if (params?.fileSize || params?.fileExt) {
                    quotedMsgType = 'share.file';
                  } else if (params?.hd || params?.rawUrl || parsed.thumb) {
                    quotedMsgType = 'photo';
                  } else {
                    quotedMsgType = 'share.link';
                  }
                } else if (parsed.href || parsed.thumb) {
                  quotedMsgType = 'photo';
                }
              }
            } catch {}
          }
        }

        const quoteImageUrl = extractQuoteImageUrl(rawQuote) || (origMsg ? extractQuoteImageFromContent(origMsg.content, origMsg.msg_type) : '');

        quote_data = JSON.stringify({
          msg: quotedMsg,
          fromD: rawQuote.fromD || '',
          attach: quotedAttach,
          msgType: quotedMsgType,
          msgId: String(rawQuote.globalMsgId),
          imageUrl: quoteImageUrl,
        });
      }

      // Check if this message was sent by an employee (injected by EventBroadcaster)
      const empInfo = (message.data as any)?._employeeInfo;
      if (isSelf) {
        console.log(`[useZaloEvents] 📩 isSelf message: msgId="${message.data?.msgId}", _employeeInfo=${empInfo ? JSON.stringify(empInfo) : 'NULL'}, threadId="${threadId}"`);
      }

      // A forum's topics share one Telegram chat ID. chatStore routes a
      // message with topic_id to an isolated topic-root cache, so a live
      // message from another topic no longer overwrites the selected timeline.
      addMessage(zaloId, threadId, {
        msg_id: String(message.data?.msgId || Date.now()),
        cli_msg_id: message.data?.cliMsgId || '',
        owner_zalo_id: zaloId,
        thread_id: threadId,
        thread_type: isGroup ? 1 : 0,
        channel: messageChannel,
        ...(incomingTopicId ? { topic_id: incomingTopicId } : {}),
        ...(message.data?.replyToId ? { reply_to_id: String(message.data.replyToId) } : {}),
        sender_id: uidFrom,
        content,
        msg_type: msgType,
        timestamp,
        is_sent: isSelf ? 1 : 0,
        status: 'received',
        ...(liveAttachments.length ? { attachments: JSON.stringify(liveAttachments) } : {}),
        ...(isSelf ? { send_status: 'received' as const } : {}),
        ...(quote_data ? { quote_data } : {}),
        ...(empInfo?.employee_id ? { handled_by_employee: empInfo.employee_id } : {}),
      } as any, cacheTopicId || undefined);

      // Resolve a media download that won the IPC race with event:message.
      flushPendingLocalPath(localPathKey(zaloId, threadId, String(message.data?.msgId || '')));

      // Telegram forum has its topic list open: the topic row updates right away (latest message, time, unread) like Telegram
      if (messageChannel === CHANNEL.TELEGRAM_USER && isGroup && message.data?.msgId) {
        noteForumTopicMessage(zaloId, threadId, {
          topicId: incomingTopicId || null,
          msgId: String(message.data.msgId),
          timestamp,
          preview: String(message.data?.preview ?? (msgType === 'text' ? content : '')),
          senderName: String(message.data?.dName || ''),
          isSelf: !!isSelf,
          isSystem: msgType === 'system',
        });
      }

      // If it is a self-image → report to MessageQueue to count the batch. Zalo photos
      // arrive as `chat.photo`; checking only image/photo meant the batch
      // never saw them and a sent preview stayed doubled for 30s.
      if (isSelf && (isImage || msgType === 'image' || msgType === 'photo' || msgType === 'chat.photo')) {
        messageQueue.onImageMessageReceived(zaloId, threadId, String(message.data?.msgId || ''));
      }

      // After adding message, try to apply any pending employee sender info (race condition fix)
      if (isSelf) {
        // If _employeeInfo was already injected by EventBroadcaster, cache the name
        if (empInfo?.employee_id && empInfo?.employee_name) {
          useEmployeeStore.getState().cacheEmployeeName(empInfo.employee_id, empInfo.employee_name, empInfo.employee_avatar || '');
        }
        // Also check pending map (fallback for when _employeeInfo wasn't injected)
        const msgId = String(message.data?.msgId || '');
        const cliMsgId = message.data?.cliMsgId || '';
        if (msgId) applyPendingEmployeeSender(zaloId, threadId, msgId);
        if (cliMsgId && cliMsgId !== msgId) applyPendingEmployeeSender(zaloId, threadId, cliMsgId);
      }

      // Comments in a discussion group not joined yet: only shown in the post's comment section:
      // no conversation created, no unread, no notification, no AI suggestion.
      if (message._commentOnly === true) return;

      // Dispatch event for AI suggestions trigger
      if (!isSelf) {
        window.dispatchEvent(new CustomEvent('ai:newMessage', { detail: { zaloId, threadId } }));
      }

      // Clear the typing indicator for this thread when a new message arrives
      if (!isSelf) useChatStore.getState().clearTypingForThread(zaloId, threadId);

      const senderInfo = (message.data as any)?.senderInfo;
      const dName: string = (message.data as any)?.dName || '';
      if (isGroup && uidFrom && dName && dName !== uidFrom) {
        const appState = useAppStore.getState();
        const contact = (useChatStore.getState().contacts[zaloId] || []).find(item => item.contact_id === threadId);
        const cached = appState.groupInfoCache?.[zaloId]?.[threadId];
        const members = [...(cached?.members || [])];
        const index = members.findIndex(member => String(member.userId) === uidFrom);
        const nextMember = { ...(index >= 0 ? members[index] : { userId: uidFrom, avatar: '', role: 0 }), displayName: dName };
        if (index >= 0) members[index] = nextMember;
        else members.push(nextMember);
        appState.setGroupInfo(zaloId, threadId, {
          ...(cached || {
            groupId: threadId,
            name: contact?.display_name || threadId,
            avatar: contact?.avatar_url || '',
            memberCount: members.length,
          }),
          members,
          fetchedAt: Date.now(),
        });
      }
      const alias = aliasMap.get(`${zaloId}__${threadId}`);
      // display_name = the real name from Zalo (alias not used). The alias is saved in its own field.
      const realName =
        senderInfo?.displayName || senderInfo?.zaloName ||
        (!isSelf && !isGroup ? dName : '');
      const senderAvatar = senderInfo?.avatar || '';

      // Employee: the Boss already saved the profile from this very message: do not write it again (each message × N employees = N REST calls + N events).
      // Catch-up messages after being offline: if the name / avatar in the list is already correct, do not write again (each message would be an identical DB write)
      const catchUp = suppressNotification || isSilent;
      const knownProfile = catchUp
        ? (useChatStore.getState().contacts[zaloId] || []).find(c => c.contact_id === threadId)
        : undefined;
      const profileUnchanged = !!knownProfile && knownProfile.display_name === realName
        && (!senderAvatar || knownProfile.avatar_url === senderAvatar);
      if (!isSelf && !isGroup && realName && !isEmployeeMode() && !profileUnchanged) {
        DataAccessor.updateContactProfile({
          zaloId, contactId: threadId, displayName: realName, avatarUrl: senderAvatar,
        }).catch(() => {});
      }

      // Update contact in store — updateContact handles both existing and new contacts
      // (new contacts get safe defaults, then DB full load will enrich them)
      const lastMsgPreview = buildMessagePreview(contentRaw, rawMsgType, isImage, content);
      const msgAccount = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
      const msgChannel = (msgAccount?.channel || CHANNEL.ZALO) as string;
      const existingContact = (useChatStore.getState().contacts[zaloId] || []).find(c => c.contact_id === threadId);
      if (!catchUp) console.log(`[useZaloEvents] event:message zaloId=${zaloId} threadId=${threadId} isSelf=${isSelf} msgType=${rawMsgType} channel=${msgChannel} lastMsg="${lastMsgPreview}" contactExists=${!!existingContact} currentLastMsg="${existingContact?.last_message || ''}"`);
      // Replied / not replied: real, latest messages only (shared/chat/replyState). Catch-up of old messages, system notices do not change it
      const replyState = replyStateForIncoming(
        { msgType: rawMsgType, timestamp, isSelf, silent: isSilent },
        existingContact?.last_message_time,
      );
      updateContact(zaloId, {
        contact_id: threadId,
        ...(isSelf ? {} : {
          ...(realName ? { display_name: realName } : {}),
          ...(senderAvatar ? { avatar_url: senderAvatar } : {}),
          ...(alias ? { alias } : {}),
        }),
        ...(replyState !== undefined ? { is_replied: replyState } : {}),
        contact_type: isGroup ? 'group' : 'user',
        channel: msgChannel as any,
        last_message: lastMsgPreview,
        last_message_time: timestamp,
      });
      // Verify update
      if (!catchUp) {
        const updatedContact = (useChatStore.getState().contacts[zaloId] || []).find(c => c.contact_id === threadId);
        console.log(`[useZaloEvents] event:message AFTER update: last_message="${updatedContact?.last_message || ''}" last_message_time=${updatedContact?.last_message_time}`);
      }

      if (isSelf) {
        // A message sent by myself (synced over from another platform)
        // → mark as replied + unread = 0 (do not add unread). Catch-up of my old messages: do not touch
        if (replyState === 1) markReplied(zaloId, threadId);
        // Employee: the Boss renderer already marked this very message as read in the Boss DB
        if (!isEmployeeMode()) DataAccessor.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
        // A reply in the open conversation = read → report to the platform if there are still incoming messages not yet reported (e.g. a conversation reopened at
        // startup that was never reported); if reported up to the latest incoming message, liveReadSync does not send it again
        // (replyState is not checked: a message sent from Deplao already updated the last message time before the echo comes back → replyState is usually undefined)
        const chatNow = useChatStore.getState();
        if (!isSilent && windowFocusedRef.current && isChatPaneVisible()
          && chatNow.activeThreadId === threadId && useAccountStore.getState().activeAccountId === zaloId) {
          liveReadSync.noteThreadShown({ accountId: zaloId, threadId, threadType: isGroup ? 1 : 0, topicId: chatNow.activeTopicId });
        }
      } else if (isSilent) {
        // Old messages (getGroupChatHistory): do NOT add unread, do NOT play sound / notification
        // Only save the message + update the contact (already handled above)
      } else {
        const { activeThreadId: currentActiveThread, activeThreadId, activeTopicId: currentActiveTopicId } = useChatStore.getState();
        const { activeAccountId: currentActiveAccount } = useAccountStore.getState();
        // Forum topic: same channel BUT a different topic → not the active thread. On another page (Overview, CRM,
        // Settings…) a remembered conversation is not shown on screen → it is still an unread message (previously it was silently counted as read)
        let isActiveThread = threadId === currentActiveThread && zaloId === currentActiveAccount && isChatPaneVisible();
        if (isActiveThread && incomingTopicId) {
          // A message in a topic → only active if the user is viewing that topic
          const effectiveTopicId = currentActiveTopicId || '1'; // '1' = General (main timeline)
          isActiveThread = incomingTopicId === effectiveTopicId;
        }
        // A conversation shown in the quick-message popup is also being viewed: no bell / card, marked as read like the chat frame
        const quickChatThread = useAppStore.getState().quickChatThread;
        const inQuickChat = !isActiveThread && !incomingTopicId && !!quickChatThread
          && quickChatThread.zaloId === zaloId && quickChatThread.threadId === threadId;
        if (inQuickChat) isActiveThread = true;
        const isWindowFocused = windowFocusedRef.current;

        // ─── Whether the message mentions me (@) ──────────────────────────────
        const msgText = String(content || '');
        const currentAccount = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
        // Word boundary regex: only matches a standalone @all/@everyone, does NOT match @allStar
        const mentionAllRegex = /@(all|All|everyone)\b/;
        const hasMentionAll = mentionAllRegex.test(msgText);
        // Check @username (Telegram): does NOT check @displayName because Zalo uses "@Tên"
        // but a displayName that is too short / generic → matches a message tagging someone else by mistake
        const username = currentAccount?.username || '';
        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mentionUserRegex = username ? new RegExp(`@${escapeRegex(username)}\\b`) : null;
        const hasMentionUser = mentionUserRegex ? mentionUserRegex.test(msgText) : false;
        const hasNativeMention = mentionAttachments.some((mention: any) =>
          mention.kind === 'all' || String(mention.user_id) === String(zaloId)
        );
        const hasMention = hasNativeMention || hasMentionAll || hasMentionUser;

        if (!isActiveThread || !isWindowFocused) {
        // Other thread (or other account), OR the active thread but the window is minimized / hidden / lost focus
        // → still counts as unread
        incrementUnread(zaloId, threadId);

        if (hasMention) {
          // Employee: the Boss renderer already set the @ flag for this very message (writing it again = N REST calls + N relay events)
          if (!isEmployeeMode()) DataAccessor.setContactFlags?.({ zaloId, contactId: threadId, flags: { has_mention: 1 } }).catch(() => {});
          // Update store immediately
          useChatStore.getState().updateContact(zaloId, { contact_id: threadId, has_mention: 1 } as any);
        }

        // ─── Taskbar badge: read after incrementUnread has updated the store (once for the whole batch of messages in the same task) ──
        queueBadgeRefresh((count) => ipc.app?.setBadge(count));

        // ─── Sound + Desktop notification ───────────────────────────────
        const appState = useAppStore.getState();
        const { isMuted, isInOthers, isZaloHidden, getNotifSettingsForAccount } = appState;
        const notifSettings = getNotifSettingsForAccount(zaloId);
        // Notification.permission is kept in sync with the macOS system notification authorization (Electron 20+)
        // When the user turns notifications off on macOS → permission = 'denied' → no sound / popup
        const notifAllowed = !('Notification' in window) || Notification.permission === 'granted';
        if (!suppressNotification && !isMuted(zaloId, threadId) && !isInOthers(zaloId, threadId) && !isZaloHidden(zaloId, threadId)) {
          if (notifSettings.soundEnabled && notifAllowed) {
            playNotificationSound(notifSettings.volume);
          }
          // In-app notification (corner card): not for the conversation shown on screen, catch-up of old messages, system messages
          const showToast = !isActiveThread && inAppToastAllowed({ accountId: zaloId, msgType, timestamp, onScreen: false });
          // The app is in use and the in-app card is already shown → do not turn on another OS popup for the same message
          const showDesktop = notifSettings.desktopEnabled && notifAllowed && !(showToast && isWindowFocused);
          if (showToast || showDesktop) {
            const showNotif = (nameOverride?: string, avatarOverride?: string) => {
              const contacts = useChatStore.getState().contacts[zaloId] || [];
              const ctact = contacts.find(c => c.contact_id === threadId);
              const contactName = nameOverride || ctact?.alias || ctact?.display_name || alias || realName || threadId;
              const contactAvatar = avatarOverride || ctact?.avatar_url || undefined;
              const fullPreview = buildMessagePreview(contentRaw, rawMsgType, isImage, content);
              const msgPreview = fullPreview.slice(0, 120);
              if (showToast) {
                // Group sender: the nickname you gave them, the name in the message, the name in the member list
                const memberName = isGroup
                  ? useAppStore.getState().groupInfoCache?.[zaloId]?.[threadId]?.members?.find(m => String(m.userId) === uidFrom)?.displayName
                  : '';
                useInAppNotifyStore.getState().push({
                  accountId: zaloId,
                  threadId,
                  threadType: isGroup ? 1 : 0,
                  msgId: String(message.data?.msgId || ''),
                  conversation: contactName,
                  sender: isGroup ? (aliasMap.get(`${zaloId}__${uidFrom}`) || dName || memberName || '') : '',
                  text: fullPreview,
                });
              }
              if (!showDesktop) return;
              // For group messages, prepend sender name to message text
              const senderDisplayName = alias || realName || '';
              const msgText = isGroup && senderDisplayName
                ? `${senderDisplayName}: ${msgPreview}`
                : msgPreview;
              const notifTitle = `[${getAccountDisplayName(zaloId)}] ${contactName}`;
              showDesktopNotification(
                notifTitle,
                msgText,
                contactAvatar,
                { zaloId, threadId, threadType: isGroup ? 1 : 0 }
              );
            };

            if (isGroup) {
              // Check whether a real name is already known
              const ctactNow = useChatStore.getState().contacts[zaloId]?.find(c => c.contact_id === threadId);
              const hasRealNameNow = !!(ctactNow?.display_name &&
                ctactNow.display_name !== threadId &&
                !/^\d+$/.test(ctactNow.display_name));
              if (hasRealNameNow) {
                showNotif();
              } else {
                // Wait for the fetch to finish before firing the notification (on error, still notify with the name we have)
                fetchGroupInfoAndMembers(zaloId, threadId, true).then(() => {
                  const ctactAfter = useChatStore.getState().contacts[zaloId]?.find(c => c.contact_id === threadId);
                  showNotif(ctactAfter?.display_name, ctactAfter?.avatar_url);
                }, () => showNotif());
              }
            } else {
              showNotif();
            }
          }
        }
        // ────────────────────────────────────────────────────────────────
        } else {
          // A message from someone else into the conversation shown on screen (same account, Chat page, window in focus)
          // → marked as read on this machine right away; report it to the platform (Zalo seen / Telegram ReadHistory / Facebook read receipt) when the person
          // is active, batching the messages; if they leave the machine, report when they come back (liveReadSync)
          DataAccessor.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
          clearUnread(zaloId, threadId);
          // Clear @mention flag when messages are read
          DataAccessor.setContactFlags?.({ zaloId, contactId: threadId, flags: { has_mention: 0 } }).catch(() => {});
          useChatStore.getState().updateContact(zaloId, { contact_id: threadId, has_mention: 0 } as any);
          const incomingMsgId = message.data?.msgId ? String(message.data.msgId) : '';
          liveReadSync.noteIncoming(
            { accountId: zaloId, threadId, threadType: isGroup ? 1 : 0, topicId: inQuickChat ? null : currentActiveTopicId },
            incomingMsgId
              ? { msgId: incomingMsgId, cliMsgId: message.data?.cliMsgId ? String(message.data.cliMsgId) : undefined, senderId: uidFrom, msgType, ts: timestamp }
              : null,
            { mention: hasMention },
          );
        }
      }

      if (!isGroup) {
        const contacts = useChatStore.getState().contacts[zaloId] || [];
        const existing = contacts.find((c) => c.contact_id === threadId);
        const cacheKey = `${zaloId}__${threadId}`;
        const hasRealName = existing && existing.display_name && existing.display_name !== threadId;
        if (!hasRealName || !isContactCacheFresh(cacheKey)) {
          fetchContactInfo(zaloId, threadId);
        }
        // Daily alias background refresh (separate from the full contact fetch)
        if (!isAliasRefreshFresh(`${zaloId}__${threadId}`)) {
          refreshContactAlias(zaloId, threadId);
        }
      } else {
        // ─── Group: fetch info + members ────────────────────────────────────
        // setTimeout(0) to yield control so React renders the message first,
        // forceNotifUpdate=true makes sure the store gets the new name/avatar in time
        const contacts = useChatStore.getState().contacts[zaloId] || [];
        const existing = contacts.find((c) => c.contact_id === threadId);
        const hasRealName = !!(existing?.display_name &&
          existing.display_name !== threadId &&
          !/^\d+$/.test(existing.display_name));
        setTimeout(() => {
          fetchGroupInfoAndMembers(zaloId, threadId, !hasRealName);
        }, 0);

        // ─── Fetch individual sender info if the name/avatar is unknown ────────────
        if (!isSelf && uidFrom) {
          const senderContact = contacts.find(c => c.contact_id === uidFrom);
          const senderKnown = !!(senderContact?.display_name &&
            senderContact.display_name !== uidFrom &&
            !/^\d+$/.test(senderContact.display_name));
          if (!senderKnown) {
            setTimeout(() => {
              fetchGroupMemberInfo(zaloId, uidFrom, threadId);
            }, 200); // small delay so the group fetch runs first
          }
        }
      }
    };

    // Catch-up messages after being offline (silent) for a conversation that is NOT open: batched together and processed in small parts (catchUpEventBatcher.ts)
    // instead of one redraw per message. Regular messages and the open conversation are handled right away, once the pending messages are done.
    const catchUpMessages = createCatchUpBatcher(handleIncomingMessage);
    const unsubMessage = ipc.on('event:message', (data: any) => {
      const chatNow = useChatStore.getState();
      const active = { accountId: useAccountStore.getState().activeAccountId, threadId: chatNow.activeThreadId };
      if (isDeferrableCatchUpMessage(data, active)) {
        catchUpMessages.defer(data);
        return;
      }
      catchUpMessages.flush();
      handleIncomingMessage(data);
    });
    /** Other events (edit / delete / reaction / reload unread count...) only run after the pending catch-up messages are in the store. */
    const afterCatchUp = {
      on: (channel: string, handler: (data: any) => void): (() => void) =>
        ipc.on(channel, (data: any) => {
          catchUpMessages.flush();
          handler(data);
        }),
    };

    // ─── Reaction events ──────────────────────────────────────────────────
    const unsubReaction = afterCatchUp.on('event:reaction', (data: any) => {
      const { zaloId, reaction } = data;
      if (!reaction) return;

      // Deep log to debug the reaction structure
      console.log('[useZaloEvents] 🎭 reaction raw:', JSON.stringify(reaction, null, 2));

      // Structure from the log: reaction.data holds all the info
      const rData = reaction.data || {};
      const threadId = reaction.threadId || rData.idTo || rData.threadId || '';
      const userId = String(rData.uidFrom || reaction.uidFrom || '');

      // TARGET msgId: in rMsg[0].gMsgID: this is the ID of the message being reacted to, NOT the action ID
      const rMsg = rData.content?.rMsg || reaction.content?.rMsg || [];
      const targetMsgId = rMsg.length > 0
        ? String(rMsg[0].gMsgID || rMsg[0].cMsgID || '')
        : String(rData.msgId || reaction.msgId || '');

      // rIcon: icon reaction (vd: ":>", "/-heart")
      const rawIcon = rData.content?.rIcon || reaction.content?.rIcon || reaction.rIcon || rData.rIcon || '';
      // Same table as when sending (shared/zalo/zaloReactions): the echo of a reaction just sent matches the saved copy and is not counted twice
      const emoji = zaloReactionIconToEmoji(rawIcon);

      console.log(`[useZaloEvents] 🎭 reaction: thread=${threadId} targetMsg=${targetMsgId} user=${userId} icon=${rawIcon} → ${emoji}`);

      if (threadId && targetMsgId) {
        // Echo of a reaction just clicked in the app: handleReact() already updated the UI + saved to the DB → skip both
        // (previously the echo was still saved → each click added +2 in the DB, reopening the conversation showed double).
        const echoOfLocalReact = !!reaction.isSelf && !!emoji && consumeLocalReaction(zaloId, targetMsgId, emoji);
        // UI: other people's reactions + my own reactions clicked from another device (phone)
        if (!reaction.isSelf || (emoji && !echoOfLocalReact)) {
          updateMessageReaction(zaloId, threadId, targetMsgId, userId, emoji);
        }
        // Employee: the Boss already saved the reaction (Boss renderer / broadcastReaction); the matching REST call is a no-op
        if (!echoOfLocalReact && !isEmployeeMode()) {
          DataAccessor.updateReaction({ zaloId, msgId: targetMsgId, threadId, userId, emoji }).catch(() => {});
        }
      }
    });

    // Telegram User reactions are aggregate updates. They cannot be mapped to
    // the Zalo per-user webhook shape, so keep their projection isolated.
    const unsubTelegramReaction = afterCatchUp.on('event:telegramReaction', (data: any) => {
      if (!data?.zaloId || !data?.threadId || !data?.msgId || !data?.reactions) return;
      replaceMessageReactions(data.zaloId, data.threadId, data.msgId, data.reactions);
    });

    // ─── Delete message events (chat.delete) ─────────────────────────────
    // Mark as recalled instead of deleting: keeps the history, shows "Tin nhắn đã bị thu hồi" (message was recalled)
    const unsubDelete = afterCatchUp.on('event:delete', (data: any) => {
      const { zaloId, msgIds, threadId } = data;
      if (!Array.isArray(msgIds) || !msgIds.length) return;
      // "Delete from app" (Boss / other employee): the message was deleted from the DB → remove it from the chat frame, do not show "đã thu hồi" (recalled)
      if (data.scope === 'app') {
        useChatStore.getState().removeMessagesById(zaloId, msgIds.map(String), threadId);
        return;
      }
      for (const msgId of msgIds) {
        useChatStore.getState().recallMessage(zaloId, String(msgId), threadId);
      }
    });

    // ─── Reminder notification events (chat.ecard) ────────────────────────
    const unsubReminder = afterCatchUp.on('event:reminder', (data: any) => {
      const { zaloId, threadId, msgType, content } = data;
      if (!zaloId || !threadId) return;

      // Dispatch a custom event so the App component handles it
      window.dispatchEvent(new CustomEvent('zalo:reminder', {
        detail: { zaloId, threadId, msgType, content }
      }));
    });

    // ─── Undo/recall events ───────────────────────────────────────────────
    const unsubUndo = afterCatchUp.on('event:undo', (data: any) => {
      const { zaloId, msgId, threadId } = data;
      if (!msgId) return;
      // Mark the message as recalled (not deleted): shows "Tin nhắn đã thu hồi" (message recalled)
      useChatStore.getState().recallMessage(zaloId, msgId, threadId);

      // If this is the last message of the conversation → update the preview in the sidebar
      if (threadId) {
        const key = `${zaloId}_${threadId}`;
        const msgs = useChatStore.getState().messages[key] || [];
        const contact = (useChatStore.getState().contacts[zaloId] || []).find(c => c.contact_id === threadId);
        // Check whether the recalled message is the last one
        if (contact && msgs.length > 0) {
          const lastMsg = msgs[msgs.length - 1];
          if (String(lastMsg?.msg_id) === String(msgId) || String(lastMsg?.cli_msg_id || '') === String(msgId)) {
            useChatStore.getState().updateContact(zaloId, {
              contact_id: threadId,
              last_message: tr('↩ Tin nhắn đã thu hồi'),
            });
          }
        }
      }
    });

    // ─── Telegram message edited ──────────────────────────────────────────
    const unsubMessageEdited = afterCatchUp.on('event:messageEdited', (data: any) => {
      const { zaloId, msgId, newText, threadId, hidden } = data;
      if (!zaloId || !msgId || !threadId) return;
      // Use existing updateMessageEdit action (preserves edit_history).
      // hidden = Telegram editHide: new content without the "edited" mark.
      useChatStore.getState().updateMessageEdit(zaloId, threadId, String(msgId), newText, 0, Date.now(), { silent: !!hidden });
    });

    // ─── Telegram messages fetched again from the server: "chưa hỗ trợ" (not supported yet) messages now readable, channel posts drop the wrong topic, messages get full formatting ───
    const unsubMessagesRepaired = afterCatchUp.on('event:messagesRepaired', (data: any) => {
      const { zaloId, threadId, items } = data || {};
      if (!zaloId || !threadId || !Array.isArray(items)) return;
      const store = useChatStore.getState();
      // Comments saved by mistake into a channel conversation that now belongs to the discussion group → removed from the channel's chat frame
      const removed = items.filter((item: any) => item?.removed && item?.msgId).map((item: any) => String(item.msgId));
      if (removed.length) store.removeMessagesById(String(zaloId), removed, String(threadId));
      for (const item of items) {
        if (!item?.msgId || item.removed) continue;
        const patch: Record<string, unknown> = {};
        if (typeof item.content === 'string') patch.content = item.content;
        if (item.msgType) patch.msg_type = item.msgType;
        if (typeof item.senderId === 'string' && item.senderId) patch.sender_id = item.senderId;
        if (Array.isArray(item.attachments)) patch.attachments = JSON.stringify(item.attachments);
        if ('topicId' in item) patch.topic_id = item.topicId ?? null;
        if ('replyToId' in item) {
          patch.reply_to_id = item.replyToId ?? null;
          patch.quote_data = null;
        }
        store.patchMessage(String(zaloId), String(threadId), String(item.msgId), patch as any);
      }
    });
    // Conversation preview changes after editing an old message (previously it kept "chưa được hỗ trợ" (not supported) until a new message arrived)
    const unsubContactPreview = afterCatchUp.on('event:contactPreview', (data: any) => {
      const { zaloId, contactId, lastMessage } = data || {};
      if (!zaloId || !contactId || typeof lastMessage !== 'string') return;
      useChatStore.getState().updateContact(String(zaloId), { contact_id: String(contactId), last_message: lastMessage } as any);
    });

    // ─── Telegram messages deleted (distinct from recall/undo) ────────────
    const unsubMessagesDeleted = afterCatchUp.on('event:messagesDeleted', (data: any) => {
      const { zaloId, messageIds, threadId } = data;
      if (!zaloId || !Array.isArray(messageIds) || !messageIds.length) return;
      // No threadId (old Boss version) = the general inbox: private chat / normal group. Does not look into channels or supergroups
      // (-100…): the same number there is a different post; previously channel posts with the same number were wrongly marked as recalled.
      const prefix = `${zaloId}_`;
      const threadIds: string[] = threadId
        ? [String(threadId)]
        : Object.keys(useChatStore.getState().messages)
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length))
          .filter((id) => !id.startsWith('-100'));
      for (const msgId of messageIds) {
        for (const id of threadIds) useChatStore.getState().recallMessage(zaloId, String(msgId), id);
      }
    });

    // ─── Telegram user presence ───────────────────────────────────────────
    const unsubUserPresence = afterCatchUp.on('event:userPresence', (data: any) => {
      const { zaloId, userId, status, wasOnline } = data;
      if (!zaloId || !userId) return;
      useChatStore.getState().setPresence(zaloId, String(userId), status, wasOnline);
    });

    const unsubTelegramEntityHydrated = afterCatchUp.on('event:telegramEntityHydrated', (data: any) => {
      const { zaloId, threadId, userId, displayName, username, avatar, status, statusText, lastSeenAt, onlineUntil } = data || {};
      if (!zaloId || !userId || !displayName) return;
      if (!threadId || String(threadId) === String(userId)) {
        useChatStore.getState().updateContact(zaloId, {
          contact_id: String(userId), display_name: displayName,
          ...(avatar ? { avatar_url: avatar } : {}),
        });
        return;
      }
      const appState = useAppStore.getState();
      const contact = (useChatStore.getState().contacts[zaloId] || []).find(item => item.contact_id === threadId);
      const cached = appState.groupInfoCache?.[zaloId]?.[threadId];
      const members = [...(cached?.members || [])];
      const index = members.findIndex(member => String(member.userId) === String(userId));
      const nextMember = {
        ...(index >= 0 ? members[index] : { userId: String(userId), avatar: '', role: 0 }),
        displayName, ...(avatar ? { avatar } : {}), ...(username ? { username } : {}), status, statusText, lastSeenAt, onlineUntil,
      };
      if (index >= 0) members[index] = nextMember;
      else members.push(nextMember);
      appState.setGroupInfo(zaloId, threadId, {
        ...(cached || {
          groupId: threadId,
          name: contact?.display_name || threadId,
          avatar: contact?.avatar_url || '',
          memberCount: members.length,
        }),
        members,
        fetchedAt: Date.now(),
      });
      // console.log('[TG_MEMBER_IDENTITY_APPLIED]', {
      //   zaloId, groupId: threadId, memberId: String(userId), displayName,
      //   hasAvatar: !!nextMember.avatar,
      // });
    });

    // The account's own profile (Zalo Business flag re-read at login / connect): Boss and employee machine (relay)
    const unsubAccountProfile = afterCatchUp.on('event:accountProfile', (data: any) => {
      const zaloId = data?.zaloId ? String(data.zaloId) : '';
      if (!zaloId || (data.is_business !== 0 && data.is_business !== 1)) return;
      const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
      if (account && (account.is_business || 0) !== data.is_business) {
        useAccountStore.getState().updateAccount(zaloId, { is_business: data.is_business });
      }
    });

    const unsubConnected = afterCatchUp.on('event:connected', (data: any) => {
      if (!data?.zaloId) return;
      updateAccountStatus(data.zaloId, true, true);
      updateListenerActive(data.zaloId, true);
      // Zalo My Documents: the conversation ID is already in the login session → the pinned list pins exactly that conversation
      const send2meId = data.accountInfo?.send2meId ? String(data.accountInfo.send2meId) : '';
      if (send2meId) {
        const acc = useAccountStore.getState().accounts.find((a) => a.zalo_id === data.zaloId);
        if (acc && acc.send2me_id !== send2meId) useAccountStore.getState().updateAccount(data.zaloId, { send2me_id: send2meId });
      }
      // Refresh contacts so the @ mention list is always up to date. Boss: DB; employee: BOSS REST (ipc.db.getContacts on
      // the employee machine is only a stub → previously nothing was loaded, so aliases / the name-mention list were never available)
      reloadAccountContacts(data.zaloId).catch(() => null).then((contacts) => {
        // Populate aliasMap from the DB so fetchContactInfo does not overwrite the alias
        for (const c of contacts || []) {
          if (c.alias) {
            aliasMap.set(`${data.zaloId}__${c.contact_id}`, c.alias);
          }
        }
        // Aliases from Zalo AFTER aliasMap is ready: loadAliases only writes to the DB the aliases that really changed
        void loadAliases(data.zaloId);
        // After contacts loaded, bulk-load group members from DB → populate groupInfoCache
        // so GroupAvatarSmall renders immediately without needing an API call
        return DataAccessor.getAllGroupMembers(data.zaloId);
      }).then((gmRes: any) => {
        if (!gmRes?.rows?.length) return;
        // Group rows by group_id
        const byGroup: Record<string, any[]> = {};
        for (const row of gmRes.rows) {
          if (!byGroup[row.group_id]) byGroup[row.group_id] = [];
          byGroup[row.group_id].push(row);
        }
        const contacts = useChatStore.getState().contacts[data.zaloId] || [];
        const appStore = useAppStore.getState();
        for (const [groupId, members] of Object.entries(byGroup)) {
          // Skip if cache already has fresh data (fetched < 30 min ago)
          const existing = (appStore.groupInfoCache[data.zaloId] || {})[groupId];
          if (existing && Date.now() - existing.fetchedAt < 30 * 60 * 1000) continue;
          const contact = contacts.find(c => c.contact_id === groupId);
          appStore.setGroupInfo(data.zaloId, groupId, {
            groupId,
            name: contact?.display_name || groupId,
            avatar: contact?.avatar_url || '',
            memberCount: members.length,
            members: members.map((m: any) => ({
              userId: m.member_id,
              displayName: m.display_name || m.member_id,
              avatar: m.avatar || '',
              role: m.role || 0,
              username: m.username || '',
            })),
            creatorId: '',
            adminIds: [],
            settings: undefined,
            fetchedAt: members[0]?.updated_at || Date.now(),
          });
        }
      }).catch(() => {});
    });

    // Telegram history/backfill passes store rows without event:message (that
    // event also drives workflows and notifications). Merge the rows of the
    // open conversation from the DB as they arrive.
    const mergeTelegramBackfill = (zaloId: string, threadIds: string[]) => {
      const chatState = useChatStore.getState();
      const threadId = chatState.activeThreadId;
      if (!threadId || useAccountStore.getState().activeAccountId !== zaloId || !threadIds.includes(threadId)) return;
      const topicId = chatState.activeTopicId || undefined;
      const PAGE = 50;
      DataAccessor.getMessages({ zaloId, threadId, topicId, limit: PAGE, offset: 0 })
        .then((res: any) => {
          const rows: MessageItem[] = res?.messages ?? res?.items ?? [];
          const latest = useChatStore.getState();
          if (!rows.length || latest.activeThreadId !== threadId || (latest.activeTopicId || undefined) !== topicId) return;
          const cached = latest.messages[getMessageCacheKey(zaloId, threadId, topicId)] || [];
          const newestCached = cached.reduce(
            (max, message) => String(message.msg_id).startsWith('temp_') ? max : Math.max(max, Number(message.timestamp || 0)),
            0,
          );
          const oldestFetched = rows.reduce(
            (min, message) => Math.min(min, Number(message.timestamp || 0)),
            Number.POSITIVE_INFINITY,
          );
          if (rows.length >= PAGE && oldestFetched > newestCached) {
            // More than a page was backfilled: merging would leave a hole
            // between the cached and the fetched range.
            latest.setMessages(zaloId, threadId, [...rows].reverse(), topicId);
          } else {
            latest.prependMessages(zaloId, threadId, rows, topicId);
          }
        })
        .catch(() => {});
    };

    // ─── Local path update (after image download) ─────────────────────────
    // Replied / un-replied changed on another machine (Boss / employee): the new state comes from the Boss's DB
    const unsubReplyStateChanged = afterCatchUp.on('db:replyStateChanged', (data: any) => {
      const zaloId = String(data?.zaloId || '');
      if (zaloId && Array.isArray(data?.items)) useChatStore.getState().applyReplyStates(zaloId, data.items);
    });

    const unsubUnreadChanged = afterCatchUp.on('db:unreadChanged', (data: any) => {
      const zaloId = data?.zaloId;
      // Read on another machine (the employee's REST mark-read call emits { zaloId, contactId, unread: 0 }): the unread count is
      // shared data on the Boss DB → clear it here too. Only change state when there is an unread count (no extra re-render).
      if (zaloId && data?.contactId && Number(data?.unread) === 0) {
        const contactId = String(data.contactId);
        const contact = (useChatStore.getState().contacts[zaloId] || []).find((item) => item.contact_id === contactId);
        if (contact && (contact.unread_count || 0) > 0) {
          useChatStore.getState().clearUnread(zaloId, contactId);
          ipc.app?.setBadge(getFilteredUnreadCount());
        }
        return;
      }
      // Zalo read on another machine up to one message, then a new message arrived (main services/zalo/zaloReadElsewhere): the new message count is still correct
      if (zaloId && data?.contactId && data?.source === 'zalo_read_elsewhere' && Number(data?.unread) > 0) {
        const contactId = String(data.contactId);
        const unread = Number(data.unread);
        const contact = (useChatStore.getState().contacts[zaloId] || []).find((item) => item.contact_id === contactId);
        if (contact && (contact.unread_count || 0) > unread) {
          useChatStore.getState().updateContact(zaloId, { contact_id: contactId, unread_count: unread });
          ipc.app?.setBadge(getFilteredUnreadCount());
        }
        return;
      }
      const account = useAccountStore.getState().accounts.find((item) => item.zalo_id === zaloId);
      const telegramRefreshSources = new Set([
        'telegram_sync', 'telegram_dialog_state', 'telegram_folder_update', 'telegram_notify_update',
        'telegram_read_outbox', 'telegram_read_inbox',
        'telegram_avatar', 'telegram_avatar_refresh', 'bot_avatar_user', 'bot_avatar_group',
        'telegram_get_messages', 'telegram_new_group_resolved',
        // Background dialog watch / membership reconcile and incremental history batches.
        'telegram_dialog_watch', 'telegram_membership_reconcile', 'telegram_history_batch',
      ]);
      if (!zaloId || !telegramRefreshSources.has(data?.source) || !isTelegram(account?.channel)) return;
      if (Array.isArray(data?.threadIds) && data.threadIds.length > 0) {
        mergeTelegramBackfill(zaloId, data.threadIds.map(String));
      }

      const pending = contactRefreshTimers.get(zaloId);
      if (pending) clearTimeout(pending);
      contactRefreshTimers.set(zaloId, setTimeout(() => {
        contactRefreshTimers.delete(zaloId);
        DataAccessor.getConversations(zaloId, 500, 0)
          .then((result) => {
            // Read error (employee: BOSS connection lost) → keep the list, do not replace it with an empty one
            if (!isReadFailure(result) && Array.isArray(result?.items)) {
              useChatStore.getState().setContacts(zaloId, result.items);
              useAppStore.getState().loadFlags(zaloId).catch(() => {});
            }
          })
          .catch(() => {});
      }, 300));
    });

    const unsubLocalPath = afterCatchUp.on('event:localPath', (data: any) => {
      const { zaloId, msgId, threadId, localPaths } = data;
      console.log(`[useZaloEvents] event:localPath msgId=${msgId} threadId=${threadId} localPaths=${JSON.stringify(localPaths)}`);
      if (zaloId && msgId && threadId && localPaths) {
        const key = localPathKey(String(zaloId), String(threadId), String(msgId));
        const previous = pendingLocalPaths.get(key);
        pendingLocalPaths.set(key, {
          zaloId: String(zaloId),
          threadId: String(threadId),
          msgId: String(msgId),
          localPaths: { ...(previous?.localPaths || {}), ...localPaths },
          retries: previous?.retries || 0,
        });
        flushPendingLocalPath(key);
        console.log(`[useZaloEvents] event:localPath ${messageExistsInStore(String(zaloId), String(threadId), String(msgId)) ? 'APPLIED' : 'BUFFERED'} msgId=${msgId}`);
      } else {
        console.log(`[useZaloEvents] event:localPath SKIPPED (missing data)`);
      }
    });

    const unsubDisconnected = afterCatchUp.on('event:disconnected', (data: any) => {
      updateAccountStatus(data.zaloId, false, false);
      if (data?.reason === 'session_invalid') {
        // The provider rejected the login itself (e.g. Telegram AUTH_KEY_DUPLICATED):
        // reconnecting cannot help, only a new login can.
        updateListenerActive(data.zaloId, false);
        showNotification(
          data.message || tr('Phiên đăng nhập của tài khoản {{zaloId}} đã hết hiệu lực. Vui lòng đăng nhập lại.', { zaloId: data.zaloId }),
          'error',
        );
        return;
      }
      // Zalo reconnects by itself within a few seconds like Zalo Web (Zalo PC logs in / out): only the status changes, no notice. If it
      // cannot reconnect, main reports again (closed / timed out), and only then is the notice shown
      if (String(data?.reason || '').startsWith('reconnecting')) return;
      // Telegram bot stopped receiving messages (another place is receiving the bot's messages, bad token): state the reason and the fix
      const account = useAccountStore.getState().accounts.find(a => a.zalo_id === data.zaloId);
      const botMessage = botDisconnectMessage(data?.reason, account?.full_name || '');
      if (botMessage) {
        showNotification(botMessage, 'warning');
        return;
      }
      showNotification(tr('Tài khoản {{zaloId}} bị ngắt kết nối', { zaloId: data.zaloId }), 'warning');
    });

    // ─── Listener dead (max retries or fatal token error) ──────────────
    const unsubListenerDead = afterCatchUp.on('event:listenerDead', (data: any) => {
      const { zaloId, reason } = data;
      updateAccountStatus(zaloId, false, false);
      updateListenerActive(zaloId, false);
      const reasonText = reason === 'max_retries' ? tr('Không thể tự kết nối lại') : tr('Lỗi: {{reason}}', { reason });
      showNotification(tr('⚠️ Tài khoản {{zaloId}} mất kết nối. {{reasonText}}. Vui lòng kết nối lại thủ công.', { zaloId, reasonText }), 'error');
    });

    // ─── Typing events ────────────────────────────────────────────────────
    const unsubTyping = afterCatchUp.on('event:typing', (data: any) => {
      const { zaloId, threadId, userId } = data;
      Logger.log('[useZaloEvents] typing received:', { zaloId, threadId, userId });
      if (zaloId && threadId && userId) setTyping(zaloId, threadId, userId);
    });

    // ─── Seen/read events ─────────────────────────────────────────────────
    const unsubSeen = afterCatchUp.on('event:seen', (data: any) => {
      const { zaloId, threadId, msgId, isGroup, seenUids } = data;
      if (zaloId && threadId) {
        setSeen(zaloId, threadId, seenUids || [], msgId || '', !!isGroup);
      }
    });
    // Read / seen marks for messages I sent (main services/receipts/peerReceipts) → ✓ / ✓✓ mark next to the time, all channels
    const unsubReceipt = afterCatchUp.on('event:receipt', (data: any) => {
      const { zaloId, threadId, deliveredTs, readTs, readMaxId } = data || {};
      if (zaloId && threadId) {
        useChatStore.getState().applyPeerReceipt(String(zaloId), String(threadId), { deliveredTs, readTs, readMaxId });
      }
    });

    // ─── Group info update (background fetch result) ──────────────────────
    const unsubGroupInfoUpdate = afterCatchUp.on('event:groupInfoUpdate', (data: any) => {
      const { zaloId, groupId, name, avatar, data: rawData } = data;
      if (!zaloId || !groupId) return;
      // Update contact display_name and avatar_url in chatStore
      updateContact(zaloId, {
        contact_id: groupId,
        display_name: name || undefined,
        avatar_url: avatar || undefined,
        contact_type: 'group',
      });
      // Build cached group info if raw data available
      if (rawData) {
        // memberIds can be string[] or object[] depending on the API response
        const rawMemberIds: any[] = rawData.memberIds || rawData.members || [];
        const subAdmins: string[] = rawData.subAdmins || rawData.adminIds || [];
        const members = rawMemberIds.map((m: any) => {
          if (typeof m === 'string') return { userId: m, displayName: m, avatar: '', role: subAdmins.includes(m) ? 2 : 0 };
          const uid = String(m.id || m.userId || m.uid || m.memberId || '');
          if (!uid || uid === 'undefined') return null;
          return {
            userId: uid,
            displayName: m.dName || m.displayName || m.zaloName || m.name || uid,
            avatar: m.avt || m.avatar || m.avatar_25 || '',
            role: uid === (rawData.creator || rawData.creatorId) ? 1 : subAdmins.includes(uid) ? 2 : 0,
          };
        }).filter(Boolean) as CachedGroupInfo['members'];

        const info: CachedGroupInfo = {
          groupId,
          name: name || groupId,
          avatar: avatar || '',
          memberCount: rawData.totalMember || rawData.memberCount || members.length,
          members,
          creatorId: rawData.creator || rawData.creatorId,
          adminIds: subAdmins,
          settings: rawData.setting,
          fetchedAt: Date.now(),
        };
        setGroupInfo(zaloId, groupId, info);
      }
    });

    // Telegram forum: invalidate topic cache when topics are created/edited/closed/reopened
    const unsubForumTopicsChanged = afterCatchUp.on('event:forumTopicsChanged', (data: any) => {
      const { zaloId, threadId } = data || {};
      if (!zaloId || !threadId) return;
      const store = useChatStore.getState();
      const cacheKey = `${zaloId}_${threadId}`;
      if (store.forumTopics[cacheKey]) {
        const newTopics = { ...store.forumTopics };
        delete newTopics[cacheKey];
        useChatStore.setState({ forumTopics: newTopics });
        // Also clear persisted cache
        try { localStorage.removeItem(`deplao_forum_topics_${cacheKey}`); } catch {}
      }
    });

    // Telegram member avatars are hydrated slowly in the main process to keep
    // MTProto stable. Patch the shared cache as each image becomes available.
    const unsubGroupMemberAvatar = afterCatchUp.on('event:groupMemberAvatar', (data: any) => {
      const { zaloId, groupId, memberId, displayName, avatar } = data || {};
      if (!zaloId || !groupId || !memberId || !avatar) return;
      const appState = useAppStore.getState();
      const cached = appState.groupInfoCache?.[zaloId]?.[groupId];
      const contact = (useChatStore.getState().contacts[zaloId] || []).find(item => String(item.contact_id) === String(groupId));
      const members = [...(cached?.members || [])];
      const index = members.findIndex(member => String(member.userId) === String(memberId));
      const nextMember = {
        ...(index >= 0 ? members[index] : { userId: String(memberId), role: 0 }),
        displayName: displayName || members[index]?.displayName || String(memberId),
        avatar,
      };
      if (index >= 0) members[index] = nextMember;
      else members.push(nextMember);
      appState.setGroupInfo(zaloId, groupId, {
        ...(cached || {
          groupId, name: contact?.display_name || groupId,
          avatar: contact?.avatar_url || '', memberCount: members.length,
        }),
        members,
        memberCount: Math.max(Number(cached?.memberCount || 0), members.length),
        fetchedAt: Date.now(),
      });
      console.log('[TG_MEMBER_AVATAR_APPLIED]', { zaloId, groupId, memberId, displayName: nextMember.displayName });
    });

    // ─── Group events (member join/leave etc.) ────────────────────────────
    const unsubGroupEvent = afterCatchUp.on('event:groupEvent', (data: any) => {
      const { zaloId, groupId, eventType, data: eventData, systemText, msgId, timestamp } = data;
      if (!zaloId || !groupId) return;

      // Group that hides members: the Boss just looked up the name of the person who acted → fix the notice line that is already shown (do not add a new line,
      // do not re-run the group structure update below, since the original event is already handled)
      if (data.update && msgId && systemText) {
        const members = Array.isArray(data.systemMembers) ? data.systemMembers : [];
        useChatStore.getState().patchMessage(zaloId, groupId, msgId, { content: systemText, attachments: JSON.stringify(members) });
        const thread = (useChatStore.getState().contacts[zaloId] || []).find(c => c.contact_id === groupId);
        if (thread && data.previousText && thread.last_message === `🔔 ${data.previousText}`) {
          updateContact(zaloId, { contact_id: groupId, last_message: `🔔 ${systemText}` });
        }
        return;
      }

      // ── Insert system notification bubble into chatStore ──────────────
      if (systemText) {
        const contacts = useChatStore.getState().contacts[zaloId] || [];
        const threadContact = contacts.find(c => c.contact_id === groupId);
        const threadType = threadContact?.contact_type === 'group' ? 1 : (eventType === 'webchat_info' ? 0 : 1);
        // Save updateMembers into attachments so ChatWindow can render the avatar/name (group hides members: the person who acted)
        const d0 = eventData?.data || eventData || {};
        const updateMembers: any[] = d0.updateMembers || [];
        const sysMembers: any[] = updateMembers.length > 0
          ? updateMembers
          : (Array.isArray(data.systemMembers) ? data.systemMembers : []);
        const attachments = sysMembers.length > 0
          ? JSON.stringify(sysMembers.map((m: any) => ({ id: m.id, dName: m.dName || '', avatar: m.avatar || m.avatar_25 || '' })))
          : '[]';

        addMessage(zaloId, groupId, {
          msg_id: msgId || `sys_${eventType}_${groupId}_${Date.now()}`,
          cli_msg_id: '',
          owner_zalo_id: zaloId,
          thread_id: groupId,
          thread_type: threadType,
          sender_id: 'system',
          content: systemText,
          msg_type: 'system',
          timestamp: timestamp || Date.now(),
          is_sent: 0,
          status: 'received',
          attachments,
        });
        // Also update conversation list preview with the system notification text
        updateContact(zaloId, {
          contact_id: groupId,
          contact_type: threadContact?.contact_type || (eventType !== 'webchat_info' ? 'group' : undefined),
          last_message: `🔔 ${systemText}`,
          last_message_time: timestamp || Date.now(),
        });
      }

      // ── Update contact / groupInfoCache for structural changes ─────────
      const d = eventData?.data || eventData || {};

      switch (eventType) {
        case 'update':
        case 'update_avatar': {
          const newName: string = d.groupName || '';
          const newAvt: string = d.avt || d.fullAvt || '';
          if (newName || newAvt) {
            updateContact(zaloId, {
              contact_id: groupId,
              ...(newName ? { display_name: newName } : {}),
              ...(newAvt ? { avatar_url: newAvt } : {}),
              contact_type: 'group',
            });
            // Employee: the Boss renderer already saved the group name / photo from this same event
            if ((newName || newAvt) && !isEmployeeMode()) {
              DataAccessor.updateContactProfile({
                zaloId, contactId: groupId,
                displayName: newName, avatarUrl: newAvt,
                phone: '', contactType: 'group',
              }).catch(() => {});
            }
          }
          break;
        }
        case 'join':
        case 'leave':
        case 'remove_member':
        case 'block_member':
        case 'add_admin':
        case 'remove_admin': {
          const appState = useAppStore.getState();
          const cachedGroup = (appState.groupInfoCache[zaloId] || {})[groupId];
          if (!cachedGroup) {
            // No cache yet → fetch everything from the API (bypass the throttle since there is no info yet)
            fetchGroupInfoAndMembers(zaloId, groupId, true);
            break;
          }

          const updateMembers: any[] = d.updateMembers || [];
          if (updateMembers.length === 0) {
            // No member info in event → fall back to invalidation
            appState.setGroupInfo(zaloId, groupId, { ...cachedGroup, fetchedAt: 0 });
            break;
          }

          let members = [...cachedGroup.members];
          let memberCountDelta = 0;
          const creatorId = cachedGroup.creatorId || '';

          for (const um of updateMembers) {
            const uid: string = um.id || um.userId || '';
            if (!uid) continue;

            switch (eventType) {
              case 'join': {
                if (!members.find(m => m.userId === uid)) {
                  members = [...members, {
                    userId: uid,
                    displayName: um.dName || um.zaloName || uid,
                    avatar: um.avatar || um.avatar_25 || '',
                    role: 0,
                  }];
                  memberCountDelta++;
                }
                break;
              }
              case 'leave':
              case 'remove_member':
              case 'block_member': {
                const before = members.length;
                members = members.filter(m => m.userId !== uid);
                if (members.length < before) memberCountDelta--;
                break;
              }
              // Zalo group event: deputy = 1, group leader = 2 (shared/chat/groupMemberRoles, as in the DB)
              case 'add_admin': {
                const deputyRole = groupAdminRole('zalo');
                if (members.find(m => m.userId === uid)) {
                  members = members.map(m => m.userId === uid ? { ...m, role: deputyRole } : m);
                } else {
                  members = [...members, {
                    userId: uid,
                    displayName: um.dName || um.zaloName || uid,
                    avatar: um.avatar || um.avatar_25 || '',
                    role: deputyRole,
                  }];
                }
                break;
              }
              case 'remove_admin': {
                members = members.map(m =>
                  m.userId === uid ? { ...m, role: m.userId === creatorId ? groupOwnerRole('zalo') : 0 } : m
                );
                break;
              }
            }
          }

          // Patch cache in-place - no full API refetch needed
          appState.setGroupInfo(zaloId, groupId, {
            ...cachedGroup,
            members,
            memberCount: Math.max(0, cachedGroup.memberCount + memberCountDelta),
          });
          break;
        }
        default:
          break;
      }
    });

    // ─── Employee sender info (relay:messageSentByEmployee) ─────────────

    const unsubEmpSender = afterCatchUp.on('relay:messageSentByEmployee', (data: any) => {
      const { zaloId, threadId, msgId, employee_id } = data;
      const employeeName: string = data.employee_name || '';
      const employeeAvatar: string = data.employee_avatar || '';
      console.log(`[useZaloEvents] 📡 relay:messageSentByEmployee received: msgId="${msgId}", empId="${employee_id}", empName="${employeeName}", zaloId="${zaloId}", threadId="${threadId}"`);
      if (!zaloId || !threadId || !employee_id) return;

      // Cache employee name + avatar for display
      if (employeeName) {
        useEmployeeStore.getState().cacheEmployeeName(employee_id, employeeName, employeeAvatar);
      }

      // Update the message in chatStore so the UI shows who sent it
      const chatState = useChatStore.getState();
      const key = `${zaloId}_${threadId}`;
      const msgs = chatState.messages[key] as MessageItem[] | undefined;
      if (msgs && msgs.length > 0) {
        let idx = -1;
        if (msgId) {
          idx = msgs.findIndex((m) => m.msg_id === msgId || m.cli_msg_id === msgId);
        }
        // Fallback: if msgId is empty or not found, find the most recent sent message without handled_by_employee (within last 30s)
        if (idx < 0) {
          const now = Date.now();
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i] as any;
            if (m.is_sent === 1 && !m.handled_by_employee && (now - m.timestamp) < 30000) {
              idx = i;
              break;
            }
          }
        }
        console.log(`[useZaloEvents] 📡 relay:messageSentByEmployee findIndex: idx=${idx}, totalMsgs=${msgs.length}, searching msgId="${msgId}"`);
        if (idx >= 0) {
          const updated = msgs.slice();
          updated[idx] = { ...updated[idx], handled_by_employee: employee_id } as any;
          useChatStore.setState((s) => ({
            messages: {
              ...s.messages,
              [key]: updated,
            },
          }));
        } else if (msgId) {
          // Message not found yet - store as pending and retry
          const pendingKey = `${zaloId}_${threadId}_${msgId}`;
          pendingEmployeeSenders.set(pendingKey, { employee_id, employee_name: employeeName, employee_avatar: employeeAvatar });
          // Retry after delays in case message arrives late
          setTimeout(() => applyPendingEmployeeSender(zaloId, threadId, msgId), 1000);
          setTimeout(() => applyPendingEmployeeSender(zaloId, threadId, msgId), 3000);
          setTimeout(() => applyPendingEmployeeSender(zaloId, threadId, msgId), 6000);
        }
      }
    });

    return () => {
      for (const timer of pendingLocalPathTimers.values()) clearTimeout(timer);
      pendingLocalPathTimers.clear();
      pendingLocalPaths.clear();
      for (const timer of contactRefreshTimers.values()) clearTimeout(timer);
      unsubMessage();
      catchUpMessages.close();
      unsubReaction();
      unsubTelegramReaction();
      unsubDelete();
      unsubReminder();
      unsubUndo();
      unsubMessageEdited();
      unsubMessagesRepaired();
      unsubContactPreview();
      unsubMessagesDeleted();
      unsubUserPresence();
      unsubTelegramEntityHydrated();
      unsubLocalPath();
      unsubConnected();
      unsubAccountProfile();
      unsubUnreadChanged();
      unsubReplyStateChanged();
      unsubDisconnected();
      unsubListenerDead();
      unsubTyping();
      unsubSeen();
      unsubReceipt();
      unsubGroupInfoUpdate();
      unsubForumTopicsChanged();
      unsubGroupMemberAvatar();
      unsubGroupEvent();
      unsubEmpSender();
    };
  }, []); // No dependencies — all store reads use getState() to avoid re-subscribing on every thread switch

  // ─── CRM / Settings real-time sync events (from Boss→Employee relay) ──
  // These events arrive when the remote side mutates labels, pins, QMs, campaigns, notes.
  // We dispatch CustomEvents so individual components can re-fetch their data.
  // Separate useEffect([]) so they are NOT torn down on every activeThreadId change.
  // The same handler for both directions: the Boss receives its own emit (changes made by an employee via REST / proxy),
  // employees receive the relay copy, including the echo of their own change → the handler must be idempotent (apply the payload /
  // reload, do not accumulate). Payload: the Boss IPC emits `ownerZaloId`, some REST calls emit `zaloId` → read both.
  useEffect(() => {
    if (!ipc.on) return;
    const unsubs: (() => void)[] = [];
    const accountOf = (data: any): string => String(data?.ownerZaloId || data?.zaloId || '');

    unsubs.push(ipc.on('db:localLabelChanged', (data: any) => {
      window.dispatchEvent(new CustomEvent('local-labels-changed', { detail: data }));
    }));
    // Assign / remove a label: ConversationList, ChatHeader, MessageInput, CRM reload the labels of the right account (detail.ownerZaloId;
    // bulkAssign mang labelIds / threadIds)
    unsubs.push(ipc.on('db:localLabelThreadChanged', (data: any) => {
      window.dispatchEvent(new CustomEvent(THREAD_LABELS_CHANGED_EVENT, { detail: data }));
    }));
    unsubs.push(ipc.on('db:pinnedMessageChanged', (data: any) => {
      window.dispatchEvent(new CustomEvent('ui:pinnedChanged', { detail: data }));
    }));
    unsubs.push(ipc.on('db:localQuickMessageChanged', (data: any) => {
      window.dispatchEvent(new CustomEvent('ui:quickMessagesChanged', { detail: data }));
    }));
    unsubs.push(ipc.on('crm:campaignChanged', (data: any) => {
      window.dispatchEvent(new CustomEvent('ui:campaignChanged', { detail: data }));
    }));
    unsubs.push(ipc.on('crm:noteChanged', (data: any) => {
      window.dispatchEvent(new CustomEvent('ui:noteChanged', { detail: data }));
    }));
    // In-app pin: ConversationList / ConversationInfo / GroupInfoPanel listen for 'local-pin-changed' (previously it emitted
    // 'ui:pinnedConversationChanged' that nobody listened to → other people's pins did not show until reload)
    unsubs.push(ipc.on('db:pinnedConversationChanged', (data: any) => {
      const zaloId = accountOf(data);
      if (!zaloId) return;
      window.dispatchEvent(new CustomEvent(LOCAL_PIN_CHANGED_EVENT, {
        detail: {
          zaloId,
          threadId: data?.threadId ? String(data.threadId) : undefined,
          isPinned: data?.isPinned === undefined || data?.isPinned === null ? undefined : !!data.isPinned,
        },
      }));
    }));
    unsubs.push(ipc.on('db:starredMessageChanged', (data: any) => {
      const zaloId = accountOf(data);
      if (!zaloId || !data?.threadId || !data?.msgId) return;
      useStarredStore.getState().applyChange(zaloId, String(data.threadId), String(data.msgId), !!data.starred);
    }));
    // Mute / "Khác" (Other) / @ flags (previously only the window event 'ui:contactFlagsChanged' was emitted, which nobody listened to → mute / Other
    // were not synced between the Boss and employees)
    unsubs.push(ipc.on('db:contactFlagsChanged', (data: any) => {
      const zaloId = accountOf(data);
      const contactId = String(data?.contactId || '');
      const flags = data?.flags;
      if (!zaloId || !contactId || !flags || typeof flags !== 'object') return;
      useAppStore.getState().applyContactFlags(zaloId, contactId, flags);
      if (flags.has_mention !== undefined) {
        const hasMention = Number(flags.has_mention) || 0;
        const contact = (useChatStore.getState().contacts[zaloId] || []).find((item) => item.contact_id === contactId);
        if (contact && (Number((contact as any).has_mention) || 0) !== hasMention) {
          useChatStore.getState().updateContact(zaloId, { contact_id: contactId, has_mention: hasMention } as any);
        }
      }
      if (flags.zalo_auto_delete_ttl !== undefined) {
        const ttl = Number(flags.zalo_auto_delete_ttl) || 0;
        const contact = (useChatStore.getState().contacts[zaloId] || []).find((item) => item.contact_id === contactId);
        if (contact && (Number(contact.zalo_auto_delete_ttl) || 0) !== ttl) {
          useChatStore.getState().updateContact(zaloId, { contact_id: contactId, zalo_auto_delete_ttl: ttl } as any);
        }
      }
    }));
    unsubs.push(ipc.on('db:contactAliasChanged', (data: any) => {
      // Update the Zustand store right away: important for an employee receiving from the relay
      const zaloId = accountOf(data);
      const contactId = String(data?.contactId || '');
      if (!zaloId || !contactId || data?.alias === undefined) return;
      const alias = String(data.alias || '');
      const aliasKey = `${zaloId}__${contactId}`;
      if (alias) aliasMap.set(aliasKey, alias);
      else aliasMap.delete(aliasKey);
      // Only conversations that already exist: the Boss stores aliases for the whole address book → does not create "ghost" conversations on the employee machine
      const contact = (useChatStore.getState().contacts[zaloId] || []).find((item) => item.contact_id === contactId);
      if (contact && (contact.alias || '') !== alias) {
        useChatStore.getState().updateContact(zaloId, { contact_id: contactId, alias });
      }
    }));
    // A contact profile edited on another machine (REST update-profile call) → name / photo / phone of the existing conversation
    unsubs.push(ipc.on('db:contactProfileUpdated', (data: any) => {
      const zaloId = accountOf(data);
      const contactId = String(data?.contactId || '');
      if (!zaloId || !contactId) return;
      const contact = (useChatStore.getState().contacts[zaloId] || []).find((item) => item.contact_id === contactId);
      if (!contact) return;
      const patch: { display_name?: string; avatar_url?: string; phone?: string } = {};
      if (data.displayName && data.displayName !== contact.display_name) patch.display_name = String(data.displayName);
      if (data.avatarUrl && data.avatarUrl !== contact.avatar_url) patch.avatar_url = String(data.avatarUrl);
      if (data.phone && data.phone !== (contact as any).phone) patch.phone = String(data.phone);
      if (Object.keys(patch).length > 0) useChatStore.getState().updateContact(zaloId, { contact_id: contactId, ...patch });
    }));
    // Conversation deleted on another machine → removed from the list + message memory; if open, it is closed (as when deleting it yourself)
    unsubs.push(ipc.on('db:conversationDeleted', (data: any) => {
      const zaloId = accountOf(data);
      const contactId = String(data?.contactId || data?.threadId || '');
      if (!zaloId || !contactId) return;
      const chat = useChatStore.getState();
      const known = (chat.contacts[zaloId] || []).some((item) => item.contact_id === contactId)
        || getMessageCacheKeysForThread(chat.messages, zaloId, contactId).length > 0;
      if (!known) return; // echo of my own delete: already removed
      chat.removeContact(zaloId, contactId);
      if (chat.activeThreadId === contactId && useAccountStore.getState().activeAccountId === zaloId) {
        useChatStore.getState().setActiveThread(null);
      }
      ipc.app?.setBadge(getFilteredUnreadCount());
    }));
    // Media library: drop the 30-minute cache (employee) + tell the open library window to reload ('library:changed')
    const libraryChanged = (action: 'added' | 'updated' | 'deleted') => (data: any) => {
      refreshLibraryCache();
      window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT, {
        detail: { action, uuid: data?.uuid || data?.item?.uuid, zaloId: data?.zaloId },
      }));
    };
    unsubs.push(ipc.on('library:itemAdded', libraryChanged('added')));
    unsubs.push(ipc.on('library:itemUpdated', libraryChanged('updated')));
    unsubs.push(ipc.on('library:itemDeleted', libraryChanged('deleted')));

    return () => { unsubs.forEach(u => u?.()); };
  }, []);

  // ─── Employee mode: BOSS connection restored / Boss restarted (employee:resync, catch-up cannot be replayed) ──
  // Shared store that does not belong to any one screen: marked messages, library cache. The conversation list, the messages of the open conversation,
  // labels, pins, flags, quick messages, CRM: each screen reloads itself through useEmployeeResync.
  useEmployeeResync(() => {
    refreshLibraryCache();
    window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT, { detail: { action: 'resync' } }));
    return useStarredStore.getState().reloadLoaded();
  });
}
