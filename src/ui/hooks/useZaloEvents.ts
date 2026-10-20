import React, { useEffect } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { consumeLocalReaction } from '@/lib/chat/localReactionRegistry';
import { useShallow } from 'zustand/react/shallow';
import { getMessageCacheKey, getMessageCacheKeysForThread, MessageItem, useChatStore } from '@/store/chatStore';
import { useAppStore, CachedGroupInfo } from '@/store/appStore';
import { useCRMStore } from '@/store/crmStore';
import { useStarredStore } from '@/store/starredStore';
import { useEmployeeStore } from '@/store/employeeStore';
import ipc from '../lib/ipc'
import DataAccessor, { isReadFailure, refreshLibraryCache } from '../lib/data/DataAccessor';
import { useEmployeeResync } from './useEmployeeResync';
import { LIBRARY_CHANGED_EVENT, LOCAL_PIN_CHANGED_EVENT, THREAD_LABELS_CHANGED_EVENT } from '@/lib/chat/relayUiEvents';
import { reloadAccountContacts } from '@/lib/chat/accountContacts';
import { messageQueue } from '@/lib/MessageQueue';
import { fetchAllAliases } from '../lib/zaloAliasUtils';
import { channelSupports, type Channel } from '@/../configs/channelConfig';
import { sendSeenForThread } from '@/lib/sendSeenHelper';
import * as channelIpc from '@/lib/channelIpc';
import { CHANNEL, isZalo, isFacebook, isTelegram, isTelegramForumGeneral } from '@/lib/channelHelper';
import { playNotificationSound, showDesktopNotification, requestNotificationPermission } from '../utils/NotificationService';
import { getFilteredUnreadCount } from '@/lib/badgeUtils';
import Logger from "../../utils/Logger";
import { extractUserProfile } from "../../utils/profileUtils";
import { BellIcon, ChartIcon, EditIcon, ImageIcon, LinkIcon, SendIcon, UserCheckIcon, WaveIcon, WifiIcon } from '@/components/common/icons';
import { groupAdminRole, groupOwnerRole } from '../../shared/groupMemberRoles';
import { zaloReactionIconToEmoji } from '../../shared/zaloReactions';
import { zinstantPreviewText } from '../../shared/zaloZinstant';

// ─── Contact fetch cache (7 ngày) ────────────────────────────────────────────
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

// ─── Alias refresh cache (24 giờ) ───────────────────────────────────────────
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
 * Chế độ nhân viên: event realtime là tiếng vọng của thay đổi Boss ĐÃ ghi vào DB (Boss relay cho mọi nhân viên của tài
 * khoản). Handler không được ghi ngược lên Boss (cập nhật hồ sơ, đánh dấu đã đọc, cờ @, bí danh…): N máy × mỗi event
 * = N lệnh REST, mỗi lệnh lại phát một event relay cho mọi nhân viên.
 */
function isEmployeeMode(): boolean {
  return useEmployeeStore.getState().mode === 'employee';
}

/** Đọc lại số lời mời kết bạn nhận được của `zaloId` → số trên tab CRM + chấm đỏ (lỗi đọc: giữ nguyên). */
function syncReceivedFriendRequestBadge(zaloId: string): void {
  DataAccessor.getFriendRequests({ zaloId, direction: 'received' }).then((res: any) => {
    if (isReadFailure(res)) return; // lỗi đọc ≠ 0 lời mời: không xoá chấm đỏ
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
          // Push alias vào chatStore (field alias riêng, KHÔNG overwrite display_name)
          useChatStore.getState().updateContact(zaloId, {
            contact_id: item.userId,
            alias: item.alias,
          });
          // Lưu vào DB để bền vững qua restart — chỉ khi bí danh đổi: mỗi lần lưu phát db:contactAliasChanged (Boss relay
          // cho mọi nhân viên của tài khoản) → trước đây mỗi lần kết nối = một event cho MỌI bí danh. Nhân viên không lưu.
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
 * Lấy tên hiển thị của account từ accountStore.
 * Dùng trong notification title để biết tin nhắn đến từ account nào.
 */
function getAccountDisplayName(zaloId: string): string {
  const accounts = useAccountStore.getState().accounts;
  const acc = accounts.find(a => a.zalo_id === zaloId || a.facebook_id === zaloId);
  return acc?.full_name || acc?.zalo_id || zaloId;
}

/**
 * Xây dựng chuỗi preview cho last_message / notification dựa trên loại tin nhắn.
 * Dùng chung cho cả updateContact (last_message) và showDesktopNotification (msgText).
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
  if (action === 'recommened.misscall') return '📵 Cuộc gọi nhỡ';
  if (action === 'recommened.calltime') {
    let params: any = {};
    try { const p = contentRaw?.params; params = typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch {}
    const secs = params.duration || 0;
    if (secs > 0) { const m = Math.floor(secs / 60), s = secs % 60; return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`; }
    return '📞 Cuộc gọi';
  }

  // ── Link preview (action=recommened.link) - phải check trước heuristic ảnh ──
  if (action === 'recommened.link' || action === 'recommended.link') {
    if (typeof contentRaw === 'object' && contentRaw !== null && contentRaw.title && typeof contentRaw.title === 'string') return `🔗 ${contentRaw.title}`;
    return '🔗 Link';
  }

  // ── Bank card action ──────────────────────────────────────────────────────
  if (action === 'zinstant.bankcard') return '🏦 Tài khoản ngân hàng';

  // ── Legacy/explicit call types ───────────────────────────────────────────
  if (mt.includes('call') || (typeof contentRaw === 'object' && contentRaw !== null && (contentRaw.call_id || contentRaw.callId || contentRaw.callType !== undefined))) {
    const missed = contentRaw?.missed || contentRaw?.status === 2;
    const secs = contentRaw?.duration || contentRaw?.call_duration;
    if (missed) return '📵 Cuộc gọi nhỡ';
    if (secs) { const m = Math.floor(secs / 60), s = secs % 60; return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`; }
    return '📞 Cuộc gọi';
  }

  // ── Voice / audio ────────────────────────────────────────────────────────
  if (mt.includes('voice') || mt.includes('audio')) {
    const secs = (typeof contentRaw === 'object' && contentRaw !== null) ? (contentRaw?.duration || 0) : 0;
    return `🎙 Tin nhắn thoại${secs ? ` (${secs}s)` : ''}`;
  }

  // ── Sticker ──────────────────────────────────────────────────────────────
  if (mt.includes('sticker') || (typeof contentRaw === 'object' && contentRaw !== null && (contentRaw.sticker_id || contentRaw.stickerId))) return '🎭 Nhãn dán';

  // ── GIF ──────────────────────────────────────────────────────────────────
  if (mt.includes('gif')) return '🎬 GIF';

  // ── Video ────────────────────────────────────────────────────────────────
  if (mt.includes('video')) return '🎥 Video';

  // ── System card (chat.ecard): nhắc hẹn, thông báo nhóm ────────────────
  if (mt === 'chat.ecard') {
    if (typeof contentRaw === 'object' && contentRaw !== null && contentRaw.title) return `🔔 ${contentRaw.title}`;
    return '🔔 Thông báo';
  }

  // ── Link types (chat.recommended, chat.link, share.link) ───────────────
  if (mt === 'chat.recommended' || mt === 'chat.recommend' || mt === 'chat.link' || mt === 'share.link') {
    if (typeof contentRaw === 'object' && contentRaw !== null && contentRaw.title && typeof contentRaw.title === 'string') return `🔗 ${contentRaw.title}`;
    return '🔗 Link';
  }

  // ── Bank card (chat.webcontent) ────────────────────────────────────────
  if (mt === 'chat.webcontent') {
    if (typeof contentRaw === 'object' && contentRaw !== null && contentRaw.action === 'zinstant.bankcard') return '🏦 Tài khoản ngân hàng';
  }
  // ── Bản tin / thông báo của Official Account (zinstant) ────────────────
  if (mt === 'chat.webcontent' || mt === 'chat.webcontent.v2') {
    const zinstant = zinstantPreviewText(contentRaw, mt);
    if (zinstant) return zinstant;
  }

  // ── Bản tin Official Account (chat.list.action): content là mảng bài viết ──
  if (mt === 'chat.list.action') {
    let list: any = contentRaw;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
    const items: any[] = Array.isArray(list) ? list : (list && typeof list === 'object' ? [list] : []);
    const first = items.find(it => it && typeof it === 'object' && typeof it.title === 'string' && it.title.trim());
    return first ? `📰 ${first.title.trim()}` : '📰 Bản tin';
  }

  // ── Poll ───────────────────────────────────────────────────────────────
  if (mt === 'group.poll' || mt === 'telegram.poll') return '📊 Bình chọn';

  // ── Location ──────────────────────────────────────────────────────────
  if (mt === 'chat.location.new') {
    const desc = typeof contentRaw === 'object' && contentRaw !== null ? contentRaw.description : '';
    return desc ? `📍 ${desc}` : '📍 [Vị trí]';
  }

  // ── Todo ───────────────────────────────────────────────────────────────
  if (mt === 'chat.todo') return '📝 Công việc';

  // ── Image (from type detection - Zalo) ──────────────────────────────────
  if (isImage) return '🖼 Hình ảnh';

  // ── Telegram-specific msgTypes ─────────────────────────────────────────
  if (mt === 'photo') return '🖼 Hình ảnh';
  if (mt === 'video_note') return '🎬 Video message';
  if (mt === 'audio') return '🎵 Audio';

  // ── File (explicit type) ─────────────────────────────────────────────────
  if (mt.includes('file') || mt === 'share.file') {
    const title = typeof contentRaw === 'object' && contentRaw !== null ? contentRaw?.title : null;
    return title ? `📂 ${title}` : '📂 File đính kèm';
  }

  // ── Object content: heuristic detection ─────────────────────────────────
  if (typeof contentRaw === 'object' && contentRaw !== null) {
    // Bank card (webcontent + zinstant.bankcard)
    if (contentRaw.action === 'zinstant.bankcard') return '🏦 Tài khoản ngân hàng';
    const params = (() => { try { const p = contentRaw.params; return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } })();
    // File heuristic: title + file-specific fields
    if (contentRaw.title && (params?.fileSize || params?.fileExt || params?.fileUrl || contentRaw.normalUrl || contentRaw.fileUrl)) return `📂 ${contentRaw.title}`;
    // Link heuristic: title + href without image params → link, not image
    if (contentRaw.title && contentRaw.href && !params?.rawUrl && !params?.hd) return `🔗 ${contentRaw.title}`;
    // Image heuristic: has rawUrl/hd, or href/thumb without title
    if (params?.rawUrl || params?.hd) return '🖼 Hình ảnh';
    if ((contentRaw.href || contentRaw.thumb) && !contentRaw.title) return '🖼 Hình ảnh';
    // title without file markers → plain text (reminder, link preview, etc.)
    if (contentRaw.title && typeof contentRaw.title === 'string') return contentRaw.title;
    if (contentRaw.msg && typeof contentRaw.msg === 'string') return contentRaw.msg;
    if (contentRaw.content && typeof contentRaw.content === 'string') return contentRaw.content;
    return '[Đính kèm]';
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

/** Trích xuất URL ảnh từ quote data */
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

  // Helper: kiểm tra URL có phải ảnh CDN không (tránh trả về href web thông thường)
  const isImageUrl = (url: string): boolean => {
    if (!url) return false;
    return /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) ||
      /zdn\.vn|zadn\.vn|zalo\.me\/[0-9]|cloudfront\.net|imgix/i.test(url);
  };

  // 1. Thử attach
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
  // 2. Thử msg
  const msgObj = (msg && typeof msg === 'string' && msg !== '' && msg !== 'null')
    ? (() => { try { return JSON.parse(msg); } catch { return null; } })()
    : (msg && typeof msg === 'object' ? msg : null);

  if (msgObj && typeof msgObj === 'object') {
    const action = String(msgObj.action || '');
    const p = parseParams(msgObj.params);
    // Ảnh thực sự: có params.hd / params.rawUrl
    if (p?.hd || p?.rawUrl) return p.hd || p.rawUrl;
    // Link preview (recommened.link): chỉ dùng thumb (ảnh thumbnail), KHÔNG dùng href (URL trang web)
    if (action === 'recommened.link' || action === 'recommended.link') {
      return String(msgObj.thumb || '');
    }
    // Các trường hợp khác: href chỉ được dùng nếu trông như URL ảnh
    const hrefUrl = String(msgObj.href || '');
    if (hrefUrl && isImageUrl(hrefUrl)) return hrefUrl;
    return String(msgObj.thumb || '');
  }
  return '';
}

/** Trích xuất URL ảnh từ content của tin nhắn gốc (khi rawQuote không có ảnh) */
function extractQuoteImageFromContent(content: string, msgType: string): string {
  if (!content) return '';
  // Chỉ trích xuất ảnh từ các loại tin nhắn là ảnh
  if (!['photo', 'image', 'chat.photo'].includes(msgType)) {
    // Kiểm tra nếu là JSON có chứa ảnh
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        let params = parsed.params;
        if (typeof params === 'string') {
          try { params = JSON.parse(params); } catch { params = null; }
        }
        // Có title + href nhưng không có params ảnh → link/file, không phải ảnh
        if (parsed.title && parsed.href && !params?.hd && !params?.rawUrl) {
          return '';
        }
        // Có params ảnh hoặc thumb → là ảnh
        return params?.hd || params?.rawUrl || parsed.href || parsed.thumb || '';
      }
    } catch {}
    return '';
  }
  // Là ảnh → trích xuất URL
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

/** Background fetch thông tin contact, ưu tiên alias, cache 7 ngày */
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
    // Guard: chỉ Zalo mới dùng ipc.zalo.getUserInfo. FB dùng getUserInfoFacebook, Telegram dùng adapter.
    if (!isZalo(account.channel)) return;
    const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent, accountId: zaloId };
    const res = await ipc.zalo?.getUserInfo({ auth, userId: contactId });

    const rawProfile = res?.response?.changed_profiles?.[contactId]
      || res?.response?.data?.[contactId];
    if (!rawProfile) return;

    // ── Centralized extraction ──────────────────────────────────────────
    const { displayName: realName, avatar: avatarUrl, phone, gender, birthday, alias: apiAlias } = extractUserProfile(rawProfile);

    // Alias: từ getUserInfo HOẶC từ aliasMap đã load
    const cachedAlias = aliasMap.get(`${zaloId}__${contactId}`);
    const resolvedAlias = apiAlias || cachedAlias || '';


    if (!realName) return;

    // Luôn cập nhật display_name = tên thật từ Zalo (không mix với alias)
    useChatStore.getState().updateContact(zaloId, {
      contact_id: contactId,
      display_name: realName,
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      ...(phone ? { phone } : {}),
      // Alias riêng - chỉ set nếu có
      ...(resolvedAlias ? { alias: resolvedAlias } : {}),
    });

    // Lưu tên thật + gender + birthday vào DB
    DataAccessor.updateContactProfile({ zaloId, contactId, displayName: realName, avatarUrl, phone, gender, birthday }).catch(() => {});

    // Lưu alias vào DB nếu có (field riêng, không overwrite display_name)
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

/** Background refresh alias only (not full profile). Cache 24 giờ, silent on failure. */
export async function refreshContactAlias(zaloId: string, contactId: string): Promise<void> {
  const aliasCacheKey = `${zaloId}__${contactId}`;
  if (isAliasRefreshFresh(aliasCacheKey)) return;

  try {
    const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
    if (!account) return;
    // Guard: chỉ Zalo mới dùng ipc.zalo.getUserInfo
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

// Throttle set: tránh fetch group liên tục trong vòng 60s
const fetchingGroups = new Set<string>();

// ─── Throttle set: fetch thông tin cá nhân từng thành viên nhóm ──────────────
const fetchingMemberInfo = new Set<string>();

/**
 * Fetch individual group member's displayName + avatar using getUserInfo API.
 * Gọi khi phát hiện tin nhắn nhóm từ sender_id chưa có tên/avatar.
 * Cập nhật: contact store + groupInfoCache + DB.
 * Throttle: mỗi member chỉ fetch 1 lần / 60s.
 */
async function fetchGroupMemberInfo(zaloId: string, memberId: string, groupId: string): Promise<void> {
  const key = `${zaloId}__${memberId}`;
  if (fetchingMemberInfo.has(key)) return;
  fetchingMemberInfo.add(key);
  // Clear throttle sau 60s để cho phép refresh sau
  setTimeout(() => fetchingMemberInfo.delete(key), 60_000);

  try {
    const account = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
    if (!account || !channelSupports((account.channel || CHANNEL.ZALO) as Channel, 'supportsGroupManage')) return;

    const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent, accountId: zaloId };
    const res = await ipc.zalo?.getUserInfo({ auth, userId: memberId });
    if (!res?.success || !res.response) return;

    const profile = res.response.changed_profiles?.[memberId];
    if (!profile) return;

    const displayName = profile.displayName || profile.zaloName || '';
    const avatar = profile.avatar || '';
    if (!displayName && !avatar) return;

    // 1. Update contact store để ChatWindow render ngay
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
 * Unified: fetch thông tin nhóm (tên, avatar) + danh sách thành viên từ 1 lần API call.
 *
 * Thứ tự ưu tiên:
 *  1. Kiểm tra DB (contact + members) - dùng ipc.db thay vì in-memory store để luôn chính xác
 *  2. Nếu nhóm chưa có trong DB (lần đầu tiên) → gọi getGroupInfo ngay (bypass throttle)
 *  3. Nếu nhóm đã có contact nhưng chưa có members → gọi getGroupInfo
 *  4. Nếu đã có đủ thông tin → bỏ qua
 *
 * @param forceNotifUpdate  Khi true: sau khi fetch xong, push tên/avatar mới vào store
 *                          để notification sau dùng đúng tên (dùng khi nhận tin nhắn lần đầu)
 */
async function fetchGroupInfoAndMembers(zaloId: string, groupId: string, forceNotifUpdate = false): Promise<void> {
  const key = `${zaloId}__${groupId}`;

  // Guard: chỉ fetch group info cho Zalo accounts
  const _acc = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
  if (!_acc || !isZalo(_acc.channel)) return;

  // Kiểm tra nhanh in-memory trước để tránh IPC round-trip không cần thiết
  const inMemory = useChatStore.getState().contacts[zaloId]?.find(c => c.contact_id === groupId);
  const inMemoryHasRealName = !!(inMemory?.display_name &&
    inMemory.display_name !== groupId &&
    !/^\d+$/.test(inMemory.display_name));

  // Bypass throttle nếu chưa có tên thật (lần đầu gặp nhóm này)
  const bypassThrottle = !inMemoryHasRealName;
  if (!bypassThrottle && fetchingGroups.has(key)) return;

  fetchingGroups.add(key);
  // Giải phóng throttle sau 5 phút để cho phép refresh sau đó
  setTimeout(() => fetchingGroups.delete(key), 5 * 60_000);

  try {
    const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
    if (!account) { fetchingGroups.delete(key); return; }

    // 1. Kiểm tra DB contact trực tiếp (không dùng in-memory store vì có thể chưa sync). DataAccessor: chế độ nhân viên
    // đọc hội thoại trên BOSS (ipc.db.getContacts ở máy nhân viên chỉ là stub → luôn "chưa có tên" → gọi API Zalo thừa)
    let hasRealName = inMemoryHasRealName;
    if (!hasRealName) {
      try {
        const existing: any = await DataAccessor.getConversationById(zaloId, groupId);
        hasRealName = !!(existing?.display_name &&
          existing.display_name !== groupId &&
          !/^\d+$/.test(existing.display_name));
      } catch {
        // Fallback sang in-memory nếu DB query lỗi
        hasRealName = inMemoryHasRealName;
      }
    }

    // 2. Kiểm tra members trong DB
    let hasMembers = false;
    try {
      const membersRes = await DataAccessor.getGroupMembers({ zaloId, groupId });
      hasMembers = (membersRes?.members?.length || 0) > 0;
    } catch {}

    // Nếu đã có đầy đủ thông tin và không cần force update → bỏ qua
    if (hasRealName && hasMembers && !forceNotifUpdate) {
      fetchingGroups.delete(key);
      return;
    }

    // 3. Gọi API getGroupInfo 1 lần duy nhất
    const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent };
    const res = await ipc.zalo?.getGroupInfo({ auth, groupId });
    const info = res?.response?.gridInfoMap?.[groupId] || res?.response;
    if (!info) { fetchingGroups.delete(key); return; }

    const name = info.name || info.groupName || '';
    const avatar = info.avt || info.avatar || info.thumb || '';
    const creatorId: string = info.creatorId || info.creator || '';
    const adminIds: string[] = info.adminIds || info.subAdmins || [];

    // 4. Update contact nếu chưa có tên thật HOẶC forceNotifUpdate
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

    // 5. Parse và lưu members (chỉ nếu chưa có)
    if (!hasMembers) {
      const rawMembers: any[] = info.memVerList || info.memberList || info.members || info.currentMems || [];
      if (rawMembers.length > 0) {
        // memVerList có thể là array of strings "uid_version" hoặc array of objects
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
            // Quy ước Zalo (như DB / CRM): trưởng nhóm = 2, phó nhóm = 1 — trước đây ghi ngược (1 / 2)
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

    // 6. Update groupInfoCache (chỉ info, không có members mới)
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
    // Nếu lỗi → xoá throttle ngay để thử lại sau
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

  // ── Handle notification click → mở đúng hội thoại ──────────────
  useEffect(() => {
    const unsub = ipc.on('app:openThread', (data: any) => {
      const { zaloId, threadId, threadType } = data;
      if (!zaloId || !threadId) return;

      // Special case: click vào notification lời mời kết bạn
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

      // 1. Lưu thread notification vào perAccountThread TRƯỚC khi switch account
      //    → ConversationList effect([activeAccountId]) sẽ restore đúng thread này
      //    thay vì restore thread cũ của account
      chatStore.saveAccountThread(zaloId, threadId, threadType || 0);

      // 2. Switch sang đúng account nếu cần (multi-account)
      if (activeAccountId !== zaloId) {
        setActiveAccount(zaloId);
      }

      // 3. Chuyển sang tab Chat
      useAppStore.getState().setView('chat');

      // 4. Trên mobile: hiện màn hình chat
      useAppStore.getState().setMobileShowChat(true);

      // 5. Employee mode: không load contacts từ local DB, để REST/DataAccessor lo
      // 6. Navigate đến đúng thread - dùng setTimeout ngắn để đảm bảo
      //    ConversationList effect đã chạy xong (nếu có switch account)
      const applyThread = () => {
        setActiveThread(threadId, threadType);
      };

      if (activeAccountId !== zaloId) {
        // Delay khi switch account → chờ ConversationList effect chạy xong
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
      sendSeenForThread(zaloId, threadId, threadType);
      // Bấm thông báo = chủ động mở hội thoại → báo đã đọc lên nền tảng như khi bấm trong danh sách
      // (Telegram: ReadHistory + @ + reaction; Facebook: read receipt). Zalo: sendSeenForThread ở trên.
      const notifChannel = (useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId)?.channel || CHANNEL.ZALO) as Channel;
      if (notifChannel !== CHANNEL.ZALO) {
        channelIpc.markAsRead(notifChannel, { accountId: zaloId, threadId }).catch(() => {});
      }
      ipc.app?.setBadge(Math.max(0, getFilteredUnreadCount()));

      // 8. Auto-fetch user info cho thread nếu thiếu (sau khi contacts kịp load)
      if (threadType !== 1) { // Không áp dụng cho group
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
        }, 500); // Chờ contacts load từ DB
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
      const displayName: string = requester.displayName || userId || 'Ai đó';
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
          if (isReadFailure(res)) return; // lỗi đọc ≠ 0 lời mời: giữ số đang hiện
          const count = res?.requests?.length ?? 0;
          useCRMStore.getState().setRequestCount(count);
        }).catch(() => {});
      }

      // Notification.permission đồng bộ với macOS system notification authorization (Electron 20+)
      // Khi user tắt notification trên macOS → permission = 'denied' → không phát âm thanh/hiện popup
      const notifAllowed = !('Notification' in window) || Notification.permission === 'granted';

      // Sound - chỉ phát khi cả in-app soundEnabled VÀ macOS cho phép notification
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
            `[${accName}] 🤝 Lời mời kết bạn`,
            `${displayName}${msg ? `: "${msg}"` : ' muốn kết bạn với bạn'}`,
            avatar || undefined,
            { zaloId, threadId: '__friend_requests__', threadType: 0 }
          );
          // flashFrame (dock bounce trên Mac) phải nằm trong desktopEnabled để tắt cùng popup
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

  // ── event:friendRemoved → bỏ đánh dấu bạn bè (hủy kết bạn ở Zalo / máy khác) ──
  useEffect(() => {
    const unsub = ipc.on('event:friendRemoved', (data: any) => {
      const zaloId = String(data?.zaloId || '');
      const userId = String(data?.userId || '');
      if (!zaloId || !userId) return;
      const contact = (useChatStore.getState().contacts[zaloId] || []).find(c => c.contact_id === userId);
      // Chỉ sửa hội thoại đang có (không tạo hội thoại mới chỉ vì một event bạn bè)
      if (contact && contact.is_friend !== 0) {
        useChatStore.getState().updateContact(zaloId, { contact_id: userId, is_friend: 0 });
      }
    });
    return unsub;
  }, []);

  // ── event:friendAccepted → thông báo + cập nhật contact store ──────────
  useEffect(() => {
    const unsub = ipc.on('event:friendAccepted', (data: any) => {
      const { zaloId, userId, requester } = data || {};
      if (!zaloId || !userId) return;

      // Cập nhật contact trong store: đánh dấu is_friend = 1
      const { updateContact } = useChatStore.getState();
      if (updateContact) updateContact(zaloId, { contact_id: userId, is_friend: 1 });
      // Boss đã xoá lời mời (gửi / nhận) của người này → đồng bộ số lời mời + chấm đỏ
      syncReceivedFriendRequestBadge(zaloId);

      const displayName = requester?.displayName || userId;
      const avatar: string = requester?.avatar || '';

      const notifForAccount = useAppStore.getState().getNotifSettingsForAccount(zaloId);
      if (notifForAccount.desktopEnabled) {
        const accName = getAccountDisplayName(zaloId);
        showDesktopNotification(
          `[${accName}] ✅ Đã chấp nhận kết bạn`,
          `${displayName} đã chấp nhận lời mời kết bạn của bạn`,
          avatar || undefined,
          { zaloId, threadId: userId, threadType: 0 }
        );
      }
    });
    return unsub;
  }, []);

  // ── Khi cửa sổ được focus lại → clear unread của thread đang active ──
  useEffect(() => {
    const handleFocus = () => {
      windowFocusedRef.current = true;
      const { activeThreadId: tid } = useChatStore.getState();
      const { activeAccountId } = useAccountStore.getState();
      if (!tid || !activeAccountId) return;
      clearUnread(activeAccountId, tid);
      DataAccessor.markAsRead({ zaloId: activeAccountId, contactId: tid }).catch(() => {});
      // Gửi sự kiện đã đọc cho Zalo (sendSeenForThread tự skip non-Zalo)
      const activeContact = (useChatStore.getState().contacts[activeAccountId] || []).find(c => c.contact_id === tid);
      const focusThreadType = activeContact?.contact_type === 'group' ? 1 : 0;
      sendSeenForThread(activeAccountId, tid, focusThreadType);
      // KHÔNG gửi read receipt sang server (Telegram, Facebook) khi chỉ focus window
      // Read receipt chỉ gửi khi user CHỦ ĐỘNG click vào hội thoại
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

    const unsubMessage = ipc.on('event:message', (data: any) => {
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

      // Ưu tiên rawMsgType (share.file, photo, etc.); fall back to image detection
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

      // Trích dẫn (quote)
      let quote_data: string | undefined = typeof message.data?.quoteData === 'string'
        ? message.data.quoteData
        : undefined;
      const rawQuote = message.data?.quote;
      if (rawQuote && rawQuote.globalMsgId) {
        // Tìm tin nhắn gốc trong store để lấy đầy đủ thông tin (vì rawQuote thường rỗng)
        const allMessages = useChatStore.getState().messages[
          getMessageCacheKey(zaloId, threadId, cacheTopicId)
        ] || [];
        const origMsg = allMessages.find(m => m.msg_id === String(rawQuote.globalMsgId));

        let quotedMsg = rawQuote.msg ?? '';
        let quotedMsgType = rawQuote.msgType || '';
        let quotedAttach = rawQuote.attach ?? '';

        // CRITICAL: Zalo platformType 2 (web) đặt content vào attach, platformType 1 (app) đặt vào msg
        // Nếu msg rỗng và attach có data → lấy từ attach
        if ((!quotedMsg || quotedMsg === 'null' || quotedMsg === '') && quotedAttach && quotedAttach !== 'null') {
          quotedMsg = quotedAttach;
        }

        // Nếu tìm thấy tin nhắn gốc, lấy thông tin từ đó
        if (origMsg) {
          quotedMsgType = origMsg.msg_type || '';
          // Nếu rawQuote.msg vẫn rỗng (cả msg và attach đều rỗng), lấy từ origMsg.content
          if (!quotedMsg || quotedMsg === 'null') {
            quotedMsg = origMsg.content || '';
          }
          // Nếu rawQuote.attach rỗng, lấy từ origMsg.attachments
          if (!quotedAttach || quotedAttach === 'null') {
            quotedAttach = origMsg.attachments || '';
          }
        } else {
          // Không tìm thấy origMsg → detect msgType từ quotedMsg (đã merge msg + attach)
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

      // Nếu là self-image → báo cho MessageQueue để đếm batch. Zalo photos
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

      // Dispatch event for AI suggestions trigger
      if (!isSelf) {
        window.dispatchEvent(new CustomEvent('ai:newMessage', { detail: { zaloId, threadId } }));
      }

      // Clear typing indicator cho thread này khi nhận tin nhắn mới
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
      // display_name = tên thật từ Zalo (không dùng alias). Alias lưu vào field riêng.
      const realName =
        senderInfo?.displayName || senderInfo?.zaloName ||
        (!isSelf && !isGroup ? dName : '');
      const senderAvatar = senderInfo?.avatar || '';

      // Nhân viên: Boss đã lưu hồ sơ từ chính tin này — không ghi lại (mỗi tin × N nhân viên = N lệnh REST + N event)
      if (!isSelf && !isGroup && realName && !isEmployeeMode()) {
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
      console.log(`[useZaloEvents] event:message zaloId=${zaloId} threadId=${threadId} isSelf=${isSelf} msgType=${rawMsgType} channel=${msgChannel} lastMsg="${lastMsgPreview}" contactExists=${!!existingContact} currentLastMsg="${existingContact?.last_message || ''}"`);
      updateContact(zaloId, {
        contact_id: threadId,
        ...(isSelf ? {} : {
          ...(realName ? { display_name: realName } : {}),
          ...(senderAvatar ? { avatar_url: senderAvatar } : {}),
          ...(alias ? { alias } : {}),
          is_replied: 0,
        }),
        contact_type: isGroup ? 'group' : 'user',
        channel: msgChannel as any,
        last_message: lastMsgPreview,
        last_message_time: timestamp,
      });
      // Verify update
      const updatedContact = (useChatStore.getState().contacts[zaloId] || []).find(c => c.contact_id === threadId);
      console.log(`[useZaloEvents] event:message AFTER update: last_message="${updatedContact?.last_message || ''}" last_message_time=${updatedContact?.last_message_time}`);

      if (isSelf) {
        // Tin nhắn từ chính mình gửi (từ nền tảng khác đồng bộ sang)
        // → đánh dấu đã trả lời + unread = 0 (không cộng unread)
        markReplied(zaloId, threadId);
        // Nhân viên: renderer Boss đã đánh dấu đã đọc trên DB Boss cho chính tin này
        if (!isEmployeeMode()) DataAccessor.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
      } else if (isSilent) {
        // Tin nhắn cũ (getGroupChatHistory) - KHÔNG cộng unread, KHÔNG bắn sound/notification
        // Chỉ lưu message + update contact (đã xử lý ở trên)
      } else {
        const { activeThreadId: currentActiveThread, activeThreadId, activeTopicId: currentActiveTopicId } = useChatStore.getState();
        const { activeAccountId: currentActiveAccount } = useAccountStore.getState();
        // Forum topic: cùng channel NHƯNG khác topic → không phải active thread
        let isActiveThread = threadId === currentActiveThread && zaloId === currentActiveAccount;
        if (isActiveThread && incomingTopicId) {
          // Tin nhắn thuộc topic → chỉ active nếu user đang xem đúng topic đó
          const effectiveTopicId = currentActiveTopicId || '1'; // '1' = General (main timeline)
          isActiveThread = incomingTopicId === effectiveTopicId;
        }
        const isWindowFocused = windowFocusedRef.current;

        if (!isActiveThread || !isWindowFocused) {
        // Thread khác (hoặc account khác), HOẶC thread đang active nhưng cửa sổ bị thu nhỏ/ẩn/mất focus
        // → vẫn tính là chưa đọc
        incrementUnread(zaloId, threadId);

        // ─── Check for @mentions in unread messages ──────────────────────
        const msgText = String(content || '');
        const currentAccount = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
        // Word boundary regex: chỉ match @all/@everyone đứng riêng, KHÔNG match @allStar
        const mentionAllRegex = /@(all|All|everyone)\b/;
        const hasMentionAll = mentionAllRegex.test(msgText);
        // Check @username (Telegram) — KHÔNG check @displayName vì Zalo dùng @Tên
        // nhưng displayName quá ngắn/generic → match nhầm tin nhắn tag người khác
        const username = currentAccount?.username || '';
        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mentionUserRegex = username ? new RegExp(`@${escapeRegex(username)}\\b`) : null;
        const hasMentionUser = mentionUserRegex ? mentionUserRegex.test(msgText) : false;
        const hasNativeMention = mentionAttachments.some((mention: any) =>
          mention.kind === 'all' || String(mention.user_id) === String(zaloId)
        );
        const hasMention = hasNativeMention || hasMentionAll || hasMentionUser;
        if (hasMention) {
          // Nhân viên: renderer Boss đã ghi cờ @ cho chính tin này (ghi lại = N lệnh REST + N event relay)
          if (!isEmployeeMode()) DataAccessor.setContactFlags?.({ zaloId, contactId: threadId, flags: { has_mention: 1 } }).catch(() => {});
          // Update store immediately
          useChatStore.getState().updateContact(zaloId, { contact_id: threadId, has_mention: 1 } as any);
        }

        // ─── Badge taskbar - đọc sau khi incrementUnread đã cập nhật store ──
        ipc.app?.setBadge(getFilteredUnreadCount());

        // ─── Sound + Desktop notification ───────────────────────────────
        const appState = useAppStore.getState();
        const { isMuted, isInOthers, getNotifSettingsForAccount } = appState;
        const notifSettings = getNotifSettingsForAccount(zaloId);
        // Notification.permission đồng bộ với macOS system notification authorization (Electron 20+)
        // Khi user tắt notification trên macOS → permission = 'denied' → không phát âm thanh/hiện popup
        const notifAllowed = !('Notification' in window) || Notification.permission === 'granted';
        if (!suppressNotification && !isMuted(zaloId, threadId) && !isInOthers(zaloId, threadId)) {
          if (notifSettings.soundEnabled && notifAllowed) {
            playNotificationSound(notifSettings.volume);
          }
          if (notifSettings.desktopEnabled && notifAllowed) {
            const showNotif = (nameOverride?: string, avatarOverride?: string) => {
              const contacts = useChatStore.getState().contacts[zaloId] || [];
              const ctact = contacts.find(c => c.contact_id === threadId);
              const contactName = nameOverride || ctact?.alias || ctact?.display_name || alias || realName || threadId;
              const contactAvatar = avatarOverride || ctact?.avatar_url || undefined;
              const msgPreview = buildMessagePreview(contentRaw, rawMsgType, isImage, content).slice(0, 120);
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
              // Kiểm tra xem đã có tên thật chưa
              const ctactNow = useChatStore.getState().contacts[zaloId]?.find(c => c.contact_id === threadId);
              const hasRealNameNow = !!(ctactNow?.display_name &&
                ctactNow.display_name !== threadId &&
                !/^\d+$/.test(ctactNow.display_name));
              if (hasRealNameNow) {
                showNotif();
              } else {
                // Chờ fetch xong rồi mới bắn notification
                fetchGroupInfoAndMembers(zaloId, threadId, true).then(() => {
                  const ctactAfter = useChatStore.getState().contacts[zaloId]?.find(c => c.contact_id === threadId);
                  showNotif(ctactAfter?.display_name, ctactAfter?.avatar_url);
                });
              }
            } else {
              showNotif();
            }
          }
        }
        // ────────────────────────────────────────────────────────────────
        } else {
          // Tin nhắn từ người khác gửi vào thread đang mở VÀ cùng account VÀ cửa sổ đang focus
          // → chỉ mark read local DB + UI, KHÔNG gửi read receipt sang server (Telegram/Facebook)
          // Read receipt chỉ gửi khi user CHỦ ĐỘNG click vào hội thoại (selectThread / ConversationList)
          DataAccessor.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
          clearUnread(zaloId, threadId);
          // Clear @mention flag when messages are read
          DataAccessor.setContactFlags?.({ zaloId, contactId: threadId, flags: { has_mention: 0 } }).catch(() => {});
          useChatStore.getState().updateContact(zaloId, { contact_id: threadId, has_mention: 0 } as any);
          // Gửi sự kiện đã đọc cho Zalo (sendSeenForThread tự skip non-Zalo)
          sendSeenForThread(zaloId, threadId, isGroup ? 1 : 0);
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
        // Daily alias background refresh (riêng biệt với full contact fetch)
        if (!isAliasRefreshFresh(`${zaloId}__${threadId}`)) {
          refreshContactAlias(zaloId, threadId);
        }
      } else {
        // ─── Nhóm: fetch info + members ────────────────────────────────────
        // setTimeout(0) để nhường control cho React render message trước,
        // forceNotifUpdate=true đảm bảo store được cập nhật tên/avatar kịp thời
        const contacts = useChatStore.getState().contacts[zaloId] || [];
        const existing = contacts.find((c) => c.contact_id === threadId);
        const hasRealName = !!(existing?.display_name &&
          existing.display_name !== threadId &&
          !/^\d+$/.test(existing.display_name));
        setTimeout(() => {
          fetchGroupInfoAndMembers(zaloId, threadId, !hasRealName);
        }, 0);

        // ─── Fetch individual sender info nếu chưa biết tên/avatar ────────────
        if (!isSelf && uidFrom) {
          const senderContact = contacts.find(c => c.contact_id === uidFrom);
          const senderKnown = !!(senderContact?.display_name &&
            senderContact.display_name !== uidFrom &&
            !/^\d+$/.test(senderContact.display_name));
          if (!senderKnown) {
            setTimeout(() => {
              fetchGroupMemberInfo(zaloId, uidFrom, threadId);
            }, 200); // delay nhẹ để group fetch chạy trước
          }
        }
      }
    });

    // ─── Reaction events ──────────────────────────────────────────────────
    const unsubReaction = ipc.on('event:reaction', (data: any) => {
      const { zaloId, reaction } = data;
      if (!reaction) return;

      // Deep log để debug cấu trúc reaction
      console.log('[useZaloEvents] 🎭 reaction raw:', JSON.stringify(reaction, null, 2));

      // Cấu trúc từ log: reaction.data chứa toàn bộ info
      const rData = reaction.data || {};
      const threadId = reaction.threadId || rData.idTo || rData.threadId || '';
      const userId = String(rData.uidFrom || reaction.uidFrom || '');

      // TARGET msgId: trong rMsg[0].gMsgID - đây là ID tin nhắn được react, KHÔNG phải action ID
      const rMsg = rData.content?.rMsg || reaction.content?.rMsg || [];
      const targetMsgId = rMsg.length > 0
        ? String(rMsg[0].gMsgID || rMsg[0].cMsgID || '')
        : String(rData.msgId || reaction.msgId || '');

      // rIcon: icon reaction (vd: ":>", "/-heart")
      const rawIcon = rData.content?.rIcon || reaction.content?.rIcon || reaction.rIcon || rData.rIcon || '';
      // Cùng bảng với lúc gửi (shared/zaloReactions) → echo của reaction vừa thả khớp bản đã lưu, không bị tính 2 lần
      const emoji = zaloReactionIconToEmoji(rawIcon);

      console.log(`[useZaloEvents] 🎭 reaction: thread=${threadId} targetMsg=${targetMsgId} user=${userId} icon=${rawIcon} → ${emoji}`);

      if (threadId && targetMsgId) {
        // Echo của reaction vừa bấm trong app: handleReact() đã cập nhật UI + lưu DB → bỏ qua cả hai
        // (trước đây echo vẫn được lưu → mỗi lần bấm +2 trong DB, mở lại hội thoại thấy gấp đôi).
        const echoOfLocalReact = !!reaction.isSelf && !!emoji && consumeLocalReaction(zaloId, targetMsgId, emoji);
        // UI: reaction người khác + reaction của mình bấm từ thiết bị khác (điện thoại)
        if (!reaction.isSelf || (emoji && !echoOfLocalReact)) {
          updateMessageReaction(zaloId, threadId, targetMsgId, userId, emoji);
        }
        // Nhân viên: Boss đã lưu reaction (renderer Boss / broadcastReaction); lệnh REST tương ứng là no-op
        if (!echoOfLocalReact && !isEmployeeMode()) {
          DataAccessor.updateReaction({ zaloId, msgId: targetMsgId, threadId, userId, emoji }).catch(() => {});
        }
      }
    });

    // Telegram User reactions are aggregate updates. They cannot be mapped to
    // the Zalo per-user webhook shape, so keep their projection isolated.
    const unsubTelegramReaction = ipc.on('event:telegramReaction', (data: any) => {
      if (!data?.zaloId || !data?.threadId || !data?.msgId || !data?.reactions) return;
      replaceMessageReactions(data.zaloId, data.threadId, data.msgId, data.reactions);
    });

    // ─── Delete message events (chat.delete) ─────────────────────────────
    // Đánh dấu recalled thay vì xoá - giữ lịch sử, hiển thị "Tin nhắn đã bị thu hồi"
    const unsubDelete = ipc.on('event:delete', (data: any) => {
      const { zaloId, msgIds, threadId } = data;
      if (!Array.isArray(msgIds) || !msgIds.length) return;
      // "Xoá khỏi app" (Boss / nhân viên khác): tin đã bị xoá khỏi DB → bỏ khỏi khung chat, không hiện "đã thu hồi"
      if (data.scope === 'app') {
        useChatStore.getState().removeMessagesById(zaloId, msgIds.map(String), threadId);
        return;
      }
      for (const msgId of msgIds) {
        useChatStore.getState().recallMessage(zaloId, String(msgId), threadId);
      }
    });

    // ─── Reminder notification events (chat.ecard) ────────────────────────
    const unsubReminder = ipc.on('event:reminder', (data: any) => {
      const { zaloId, threadId, msgType, content } = data;
      if (!zaloId || !threadId) return;

      // Dispatch custom event để App component xử lý
      window.dispatchEvent(new CustomEvent('zalo:reminder', {
        detail: { zaloId, threadId, msgType, content }
      }));
    });

    // ─── Undo/recall events ───────────────────────────────────────────────
    const unsubUndo = ipc.on('event:undo', (data: any) => {
      const { zaloId, msgId, threadId } = data;
      if (!msgId) return;
      // Đánh dấu tin nhắn là đã thu hồi (không xóa) - hiển thị "Tin nhắn đã thu hồi"
      useChatStore.getState().recallMessage(zaloId, msgId, threadId);

      // Nếu đây là tin nhắn cuối của conversation → cập nhật preview trong sidebar
      if (threadId) {
        const key = `${zaloId}_${threadId}`;
        const msgs = useChatStore.getState().messages[key] || [];
        const contact = (useChatStore.getState().contacts[zaloId] || []).find(c => c.contact_id === threadId);
        // Kiểm tra xem tin nhắn bị thu hồi có phải là tin cuối không
        if (contact && msgs.length > 0) {
          const lastMsg = msgs[msgs.length - 1];
          if (String(lastMsg?.msg_id) === String(msgId) || String(lastMsg?.cli_msg_id || '') === String(msgId)) {
            useChatStore.getState().updateContact(zaloId, {
              contact_id: threadId,
              last_message: '↩ Tin nhắn đã thu hồi',
            });
          }
        }
      }
    });

    // ─── Telegram message edited ──────────────────────────────────────────
    const unsubMessageEdited = ipc.on('event:messageEdited', (data: any) => {
      const { zaloId, msgId, newText, threadId, hidden } = data;
      if (!zaloId || !msgId || !threadId) return;
      // Use existing updateMessageEdit action (preserves edit_history).
      // hidden = Telegram editHide: new content without the "edited" mark.
      useChatStore.getState().updateMessageEdit(zaloId, threadId, String(msgId), newText, 0, Date.now(), { silent: !!hidden });
    });

    // ─── Telegram messages deleted (distinct from recall/undo) ────────────
    const unsubMessagesDeleted = ipc.on('event:messagesDeleted', (data: any) => {
      const { zaloId, messageIds, threadId } = data;
      if (!zaloId || !Array.isArray(messageIds) || !messageIds.length) return;
      // Không có threadId (Boss bản cũ) = hộp tin chung: chat riêng / nhóm thường. Không dò sang kênh, siêu nhóm
      // (-100…): cùng số ở đó là bài khác — trước đây bài kênh trùng số bị đánh dấu thu hồi nhầm.
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
    const unsubUserPresence = ipc.on('event:userPresence', (data: any) => {
      const { zaloId, userId, status, wasOnline } = data;
      if (!zaloId || !userId) return;
      useChatStore.getState().setPresence(zaloId, String(userId), status, wasOnline);
    });

    const unsubTelegramEntityHydrated = ipc.on('event:telegramEntityHydrated', (data: any) => {
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

    const unsubConnected = ipc.on('event:connected', (data: any) => {
      if (!data?.zaloId) return;
      updateAccountStatus(data.zaloId, true, true);
      updateListenerActive(data.zaloId, true);
      // Zalo My Documents: ID hội thoại có sẵn trong phiên đăng nhập → danh sách ghim đúng hội thoại đó
      const send2meId = data.accountInfo?.send2meId ? String(data.accountInfo.send2meId) : '';
      if (send2meId) {
        const acc = useAccountStore.getState().accounts.find((a) => a.zalo_id === data.zaloId);
        if (acc && acc.send2me_id !== send2meId) useAccountStore.getState().updateAccount(data.zaloId, { send2me_id: send2meId });
      }
      // Refresh contacts so @ mention list is always up to date — Boss: DB; nhân viên: BOSS REST (ipc.db.getContacts ở
      // máy nhân viên chỉ là stub → trước đây không nạp gì, bí danh / danh sách nhắc tên không bao giờ có)
      reloadAccountContacts(data.zaloId).catch(() => null).then((contacts) => {
        // Populate aliasMap từ DB để fetchContactInfo không overwrite alias
        for (const c of contacts || []) {
          if (c.alias) {
            aliasMap.set(`${data.zaloId}__${c.contact_id}`, c.alias);
          }
        }
        // Bí danh từ Zalo SAU khi có aliasMap: loadAliases chỉ ghi DB bí danh thật sự đổi
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
    const unsubUnreadChanged = ipc.on('db:unreadChanged', (data: any) => {
      const zaloId = data?.zaloId;
      // Đã đọc ở máy khác (lệnh REST mark-read của nhân viên phát { zaloId, contactId, unread: 0 }): số chưa đọc là
      // dữ liệu chung trên DB Boss → xoá ở đây luôn. Chỉ đổi state khi đang có số chưa đọc (không render lại thừa).
      if (zaloId && data?.contactId && Number(data?.unread) === 0) {
        const contactId = String(data.contactId);
        const contact = (useChatStore.getState().contacts[zaloId] || []).find((item) => item.contact_id === contactId);
        if (contact && (contact.unread_count || 0) > 0) {
          useChatStore.getState().clearUnread(zaloId, contactId);
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
            // Lỗi đọc (employee: mất kết nối BOSS) → giữ danh sách, không thay bằng rỗng
            if (!isReadFailure(result) && Array.isArray(result?.items)) {
              useChatStore.getState().setContacts(zaloId, result.items);
              useAppStore.getState().loadFlags(zaloId).catch(() => {});
            }
          })
          .catch(() => {});
      }, 300));
    });

    const unsubLocalPath = ipc.on('event:localPath', (data: any) => {
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

    const unsubDisconnected = ipc.on('event:disconnected', (data: any) => {
      updateAccountStatus(data.zaloId, false, false);
      if (data?.reason === 'session_invalid') {
        // The provider rejected the login itself (e.g. Telegram AUTH_KEY_DUPLICATED):
        // reconnecting cannot help, only a new login can.
        updateListenerActive(data.zaloId, false);
        showNotification(
          data.message || `Phiên đăng nhập của tài khoản ${data.zaloId} đã hết hiệu lực. Vui lòng đăng nhập lại.`,
          'error',
        );
        return;
      }
      showNotification(`Tài khoản ${data.zaloId} bị ngắt kết nối`, 'warning');
    });

    // ─── Listener dead (max retries hoặc fatal token error) ──────────────
    const unsubListenerDead = ipc.on('event:listenerDead', (data: any) => {
      const { zaloId, reason } = data;
      updateAccountStatus(zaloId, false, false);
      updateListenerActive(zaloId, false);
      const reasonText = reason === 'max_retries' ? 'Không thể tự kết nối lại' : `Lỗi: ${reason}`;
      showNotification(`⚠️ Tài khoản ${zaloId} mất kết nối. ${reasonText}. Vui lòng kết nối lại thủ công.`, 'error');
    });

    // ─── Typing events ────────────────────────────────────────────────────
    const unsubTyping = ipc.on('event:typing', (data: any) => {
      const { zaloId, threadId, userId } = data;
      Logger.log('[useZaloEvents] typing received:', { zaloId, threadId, userId });
      if (zaloId && threadId && userId) setTyping(zaloId, threadId, userId);
    });

    // ─── Seen/read events ─────────────────────────────────────────────────
    const unsubSeen = ipc.on('event:seen', (data: any) => {
      const { zaloId, threadId, msgId, isGroup, seenUids } = data;
      if (zaloId && threadId) {
        setSeen(zaloId, threadId, seenUids || [], msgId || '', !!isGroup);
      }
    });
    // Mốc đã nhận / đã xem tin mình gửi (main services/receipts/peerReceipts) → dấu ✓ / ✓✓ cạnh giờ, mọi kênh
    const unsubReceipt = ipc.on('event:receipt', (data: any) => {
      const { zaloId, threadId, deliveredTs, readTs, readMaxId } = data || {};
      if (zaloId && threadId) {
        useChatStore.getState().applyPeerReceipt(String(zaloId), String(threadId), { deliveredTs, readTs, readMaxId });
      }
    });

    // ─── Group info update (background fetch result) ──────────────────────
    const unsubGroupInfoUpdate = ipc.on('event:groupInfoUpdate', (data: any) => {
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
        // memberIds có thể là string[] hoặc object[] tùy API response
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
    const unsubForumTopicsChanged = ipc.on('event:forumTopicsChanged', (data: any) => {
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
    const unsubGroupMemberAvatar = ipc.on('event:groupMemberAvatar', (data: any) => {
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
    const unsubGroupEvent = ipc.on('event:groupEvent', (data: any) => {
      const { zaloId, groupId, eventType, data: eventData, systemText, msgId, timestamp } = data;
      if (!zaloId || !groupId) return;

      // Nhóm ẩn thành viên: Boss vừa tra được tên người thực hiện → sửa dòng thông báo đã hiện (không thêm dòng mới,
      // không chạy lại phần cập nhật cấu trúc nhóm bên dưới — sự kiện gốc đã xử lý)
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
        // Lưu updateMembers vào attachments để ChatWindow render avatar/tên (nhóm ẩn thành viên: người thực hiện)
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
            // Nhân viên: renderer Boss đã lưu tên / ảnh nhóm từ chính event này
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
            // Chưa có cache → fetch đầy đủ từ API (bypass throttle vì chưa có thông tin)
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
              // Sự kiện nhóm Zalo: phó nhóm = 1, trưởng nhóm = 2 (shared/groupMemberRoles, như DB)
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

    const unsubEmpSender = ipc.on('relay:messageSentByEmployee', (data: any) => {
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
      unsubReaction();
      unsubTelegramReaction();
      unsubDelete();
      unsubReminder();
      unsubUndo();
      unsubMessageEdited();
      unsubMessagesDeleted();
      unsubUserPresence();
      unsubTelegramEntityHydrated();
      unsubLocalPath();
      unsubConnected();
      unsubUnreadChanged();
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
  // Cùng một handler cho cả hai chiều: Boss nhận emit của chính mình (thay đổi do nhân viên làm qua REST / proxy),
  // nhân viên nhận bản relay — kể cả tiếng vọng thay đổi của chính mình → handler phải idempotent (áp payload /
  // tải lại, không cộng dồn). Payload: IPC Boss phát `ownerZaloId`, vài lệnh REST phát `zaloId` → đọc cả hai.
  useEffect(() => {
    if (!ipc.on) return;
    const unsubs: (() => void)[] = [];
    const accountOf = (data: any): string => String(data?.ownerZaloId || data?.zaloId || '');

    unsubs.push(ipc.on('db:localLabelChanged', (data: any) => {
      window.dispatchEvent(new CustomEvent('local-labels-changed', { detail: data }));
    }));
    // Gán / bỏ nhãn: ConversationList, ChatHeader, MessageInput, CRM tải lại nhãn của đúng tài khoản (detail.ownerZaloId;
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
    // Ghim trong app: ConversationList / ConversationInfo / GroupInfoPanel nghe 'local-pin-changed' (trước đây phát
    // 'ui:pinnedConversationChanged' mà không ai nghe → ghim của người khác không hiện tới khi tải lại)
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
    // Tắt tiếng / "Khác" / cờ @ (trước đây chỉ phát window event 'ui:contactFlagsChanged' không ai nghe → mute / Khác
    // không đồng bộ giữa Boss và nhân viên)
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
    }));
    unsubs.push(ipc.on('db:contactAliasChanged', (data: any) => {
      // Cập nhật Zustand store ngay lập tức - quan trọng cho employee nhận từ relay
      const zaloId = accountOf(data);
      const contactId = String(data?.contactId || '');
      if (!zaloId || !contactId || data?.alias === undefined) return;
      const alias = String(data.alias || '');
      const aliasKey = `${zaloId}__${contactId}`;
      if (alias) aliasMap.set(aliasKey, alias);
      else aliasMap.delete(aliasKey);
      // Chỉ hội thoại đang có: Boss lưu bí danh của cả danh bạ → không tạo hội thoại "ma" ở máy nhân viên
      const contact = (useChatStore.getState().contacts[zaloId] || []).find((item) => item.contact_id === contactId);
      if (contact && (contact.alias || '') !== alias) {
        useChatStore.getState().updateContact(zaloId, { contact_id: contactId, alias });
      }
    }));
    // Hồ sơ liên hệ sửa ở máy khác (lệnh REST update-profile) → tên / ảnh / SĐT của hội thoại đang có
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
    // Xoá hội thoại ở máy khác → bỏ khỏi danh sách + bộ nhớ tin nhắn; đang mở thì đóng (như khi tự xoá)
    unsubs.push(ipc.on('db:conversationDeleted', (data: any) => {
      const zaloId = accountOf(data);
      const contactId = String(data?.contactId || data?.threadId || '');
      if (!zaloId || !contactId) return;
      const chat = useChatStore.getState();
      const known = (chat.contacts[zaloId] || []).some((item) => item.contact_id === contactId)
        || getMessageCacheKeysForThread(chat.messages, zaloId, contactId).length > 0;
      if (!known) return; // tiếng vọng lần xoá của chính mình — đã bỏ rồi
      chat.removeContact(zaloId, contactId);
      if (chat.activeThreadId === contactId && useAccountStore.getState().activeAccountId === zaloId) {
        useChatStore.getState().setActiveThread(null);
      }
      ipc.app?.setBadge(getFilteredUnreadCount());
    }));
    // Thư viện media: bỏ cache 30 phút (nhân viên) + báo cửa sổ thư viện đang mở tải lại ('library:changed')
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

  // ─── Chế độ nhân viên: kết nối BOSS phục hồi / Boss khởi động lại (employee:resync, catch-up không phát lại được) ──
  // Store dùng chung không thuộc màn hình nào: tin đánh dấu, cache thư viện. Danh sách hội thoại, tin của hội thoại
  // đang mở, nhãn, ghim, cờ, tin nhắn nhanh, CRM: từng màn hình tự tải lại qua useEmployeeResync.
  useEmployeeResync(() => {
    refreshLibraryCache();
    window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT, { detail: { action: 'resync' } }));
    return useStarredStore.getState().reloadLoaded();
  });
}
