import React, { useEffect } from 'react';
import { useAccountStore } from '@/store/accountStore';
import {MessageItem, useChatStore} from '@/store/chatStore';
import { useAppStore, CachedGroupInfo } from '@/store/appStore';
import { useCRMStore } from '@/store/crmStore';
import { useEmployeeStore } from '@/store/employeeStore';
import ipc from '../lib/ipc';
import { sendSeenForThread } from '@/lib/sendSeenHelper';
import { playNotificationSound, showDesktopNotification, requestNotificationPermission } from '../utils/NotificationService';
import { getFilteredUnreadCount } from '@/lib/badgeUtils';
import Logger from "../../utils/Logger";
import { extractUserProfile } from "../../utils/profileUtils";

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

// Module-level alias map
const aliasMap = new Map<string, string>();
const aliasLoadInFlight = new Map<string, Promise<void>>();
const aliasLoadLastAttemptAt = new Map<string, number>();
const ALIAS_LOAD_RETRY_COOLDOWN_MS = 5000;

async function loadAliases(zaloId: string) {
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
      const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent };
      const res = await ipc.zalo?.getAliasList({ auth, count: 500 });
      if (!res?.success) return;
      const items: { userId: string; alias: string }[] = res?.response?.items || [];
      for (const item of items) {
        if (item.alias && item.userId) {
          aliasMap.set(`${zaloId}__${item.userId}`, item.alias);
          // Push alias vào chatStore (field alias riêng, KHÔNG overwrite display_name)
          useChatStore.getState().updateContact(zaloId, {
            contact_id: item.userId,
            alias: item.alias,
          });
          // Lưu vào DB để bền vững qua restart
          ipc.db?.setContactAlias({ zaloId, contactId: item.userId, alias: item.alias }).catch(() => {});
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

// ─── Reactions: map từ Zalo Reactions enum value → emoji hiển thị ──────────
const REACTION_ICON_TO_EMOJI: Record<string, string> = {
  '/-heart': '❤️', '/-strong': '👍', ':>': '😆', ':o': '😮',
  ':-((':  '😢', ':-h': '😡', ':-*': '😘', ":')": '😂',
  '/-shit': '💩', '/-rose': '🌹', '/-break': '💔', '/-weak': '👎',
  ';xx': '😍', ';-/': '😕', ';-)': '😉', '/-fade': '🥱',
  '_()_': '🙏', '/-no': '🙅', '/-ok': '👌', '/-v': '✌️',
  '/-thanks': '🙏', '/-punch': '👊', ':-bye': '👋', ':((':  '😭',
  ':))': '😁', '$-)': '🤑',
};

function reactionIconToEmoji(icon: string): string {
  return REACTION_ICON_TO_EMOJI[icon] || icon;
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

  // ── Link preview (action=recommened.link) — phải check trước heuristic ảnh ──
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

  // ── Poll ───────────────────────────────────────────────────────────────
  if (mt === 'group.poll') return '📊 Bình chọn';

  // ── Todo ───────────────────────────────────────────────────────────────
  if (mt === 'chat.todo') return '📝 Công việc';

  // ── Image (from type detection) ──────────────────────────────────────────
  if (isImage) return '🖼 Hình ảnh';

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
async function fetchContactInfo(zaloId: string, contactId: string): Promise<void> {
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
    const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent };
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
      // Alias riêng — chỉ set nếu có
      ...(resolvedAlias ? { alias: resolvedAlias } : {}),
    });

    // Lưu tên thật + gender + birthday vào DB
    ipc.db?.updateContactProfile({ zaloId, contactId, displayName: realName, avatarUrl, phone, gender, birthday }).catch(() => {});

    // Lưu alias vào DB nếu có (field riêng, không overwrite display_name)
    if (resolvedAlias) {
      aliasMap.set(`${zaloId}__${contactId}`, resolvedAlias);
      ipc.db?.setContactAlias({ zaloId, contactId, alias: resolvedAlias }).catch(() => {});
    }
  } catch {
    const times = getContactFetchTimes();
    delete times[cacheKey];
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(times)); } catch {}
  }
}

// Throttle set: tránh fetch group liên tục trong vòng 60s
const fetchingGroups = new Set<string>();

/**
 * Unified: fetch thông tin nhóm (tên, avatar) + danh sách thành viên từ 1 lần API call.
 *
 * Thứ tự ưu tiên:
 *  1. Kiểm tra DB (contact + members) — dùng ipc.db thay vì in-memory store để luôn chính xác
 *  2. Nếu nhóm chưa có trong DB (lần đầu tiên) → gọi getGroupInfo ngay (bypass throttle)
 *  3. Nếu nhóm đã có contact nhưng chưa có members → gọi getGroupInfo
 *  4. Nếu đã có đủ thông tin → bỏ qua
 *
 * @param forceNotifUpdate  Khi true: sau khi fetch xong, push tên/avatar mới vào store
 *                          để notification sau dùng đúng tên (dùng khi nhận tin nhắn lần đầu)
 */
async function fetchGroupInfoAndMembers(zaloId: string, groupId: string, forceNotifUpdate = false): Promise<void> {
  const key = `${zaloId}__${groupId}`;

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

    // 1. Kiểm tra DB contact trực tiếp (không dùng in-memory store vì có thể chưa sync)
    let hasRealName = inMemoryHasRealName;
    if (!hasRealName) {
      try {
        const contactsRes = await ipc.db?.getContacts(zaloId);
        const existing = (contactsRes?.contacts || []).find((c: any) => c.contact_id === groupId);
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
      const membersRes = await ipc.db?.getGroupMembers({ zaloId, groupId });
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
      ipc.db?.updateContactProfile({
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
            role: (typeof m === 'object' && m.type === 1) ? 1 : (adminIds.includes(memberId) ? 2 : 0),
          };
        }).filter((m: any) => m.memberId);

        if (members.length > 0) {
          await ipc.db?.saveGroupMembers({ zaloId, groupId, members }).catch(() => {});
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
  const { updateAccountStatus, updateListenerActive } = useAccountStore();
  const { addMessage, updateContact, incrementUnread, updateMessageReaction, updateMessageLocalPath, setTyping, setSeen, markReplied, clearUnread, setActiveThread, setMessages } = useChatStore();
  const { activeThreadId } = useChatStore();
  const { showNotification, setGroupInfo } = useAppStore();

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

      // 1. Switch sang đúng account nếu cần (multi-account)
      const { activeAccountId, setActiveAccount } = useAccountStore.getState();
      if (activeAccountId !== zaloId) {
        setActiveAccount(zaloId);
      }

      // 2. Chuyển sang tab Chat
      useAppStore.getState().setView('chat');

      // 3. Trên mobile: hiện màn hình chat
      useAppStore.getState().setMobileShowChat(true);

      // 4. Navigate đến đúng thread
      setActiveThread(threadId, threadType);

      // 5. Load messages
      ipc.db?.getMessages({ zaloId, threadId, limit: 50, offset: 0 }).then((res: any) => {
        const msgs = res?.messages || [];
        if (msgs.length > 0) setMessages(zaloId, threadId, [...msgs].reverse());
      }).catch(() => {});

      // 6. Clear unread, mark as read, update badge
      ipc.db?.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
      clearUnread(zaloId, threadId);
      sendSeenForThread(zaloId, threadId, threadType);
      ipc.app?.setBadge(Math.max(0, getFilteredUnreadCount()));
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

      const { notifSettings } = useAppStore.getState();
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
        ipc.db?.getFriendRequests({ zaloId, direction: 'received' }).then((res: any) => {
          const count = res?.requests?.length ?? 0;
          useCRMStore.getState().setRequestCount(count);
        }).catch(() => {});
      }

      // Notification.permission đồng bộ với macOS system notification authorization (Electron 20+)
      // Khi user tắt notification trên macOS → permission = 'denied' → không phát âm thanh/hiện popup
      const notifAllowed = !('Notification' in window) || Notification.permission === 'granted';

      // Sound — chỉ phát khi cả in-app soundEnabled VÀ macOS cho phép notification
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
          showDesktopNotification(
            `🤝 Lời mời kết bạn`,
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

      ipc.db?.getFriendRequests({ zaloId, direction: 'received' }).then((res: any) => {
        const count = res?.requests?.length ?? 0;
        const { activeAccountId } = useAccountStore.getState();
        if (activeAccountId === zaloId) {
          useCRMStore.getState().setRequestCount(count);
        }
        if (count === 0) {
          useAppStore.getState().clearCRMRequestUnseen(zaloId);
        }
      }).catch(() => {});
    });

    return unsub;
  }, []);

  // ── event:friendAccepted → thông báo + cập nhật contact store ──────────
  useEffect(() => {
    const unsub = ipc.on('event:friendAccepted', (data: any) => {
      const { zaloId, userId, requester } = data;
      if (!zaloId || !userId) return;

      // Cập nhật contact trong store: đánh dấu is_friend = 1
      const { updateContact } = useChatStore.getState();
      if (updateContact) updateContact(zaloId, { contact_id: userId, is_friend: 1 });

      const displayName = requester?.displayName || userId;
      const avatar: string = requester?.avatar || '';

      const { notifSettings } = useAppStore.getState();
      if (notifSettings.desktopEnabled) {
        showDesktopNotification(
          `✅ Đã chấp nhận kết bạn`,
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
      ipc.db?.markAsRead({ zaloId: activeAccountId, contactId: tid }).catch(() => {});
      // Gửi sự kiện đã đọc khi cửa sổ được focus lại
      const activeContact = (useChatStore.getState().contacts[activeAccountId] || []).find(c => c.contact_id === tid);
      const focusThreadType = activeContact?.contact_type === 'group' ? 1 : 0;
      sendSeenForThread(activeAccountId, tid, focusThreadType);
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
      const isSilent: boolean = message._silent === true; // Old messages — no sound/notification
      const threadId: string = message.threadId || '';
      if (!threadId || threadId === 'undefined' || threadId === 'null') return;

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

      // Trích dẫn (quote)
      let quote_data: string | undefined;
      const rawQuote = message.data?.quote;
      if (rawQuote && rawQuote.globalMsgId) {
        // Tìm tin nhắn gốc trong store để lấy đầy đủ thông tin (vì rawQuote thường rỗng)
        const allMessages = useChatStore.getState().messages[`${zaloId}_${threadId}`] || [];
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

      addMessage(zaloId, threadId, {
        msg_id: String(message.data?.msgId || Date.now()),
        cli_msg_id: message.data?.cliMsgId || '',
        owner_zalo_id: zaloId,
        thread_id: threadId,
        thread_type: isGroup ? 1 : 0,
        sender_id: uidFrom,
        content,
        msg_type: msgType,
        timestamp,
        is_sent: isSelf ? 1 : 0,
        status: 'received',
        ...(quote_data ? { quote_data } : {}),
        ...(empInfo?.employee_id ? { handled_by_employee: empInfo.employee_id } : {}),
      } as any);

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
      const alias = aliasMap.get(`${zaloId}__${threadId}`);
      // display_name = tên thật từ Zalo (không dùng alias). Alias lưu vào field riêng.
      const realName =
        senderInfo?.displayName || senderInfo?.zaloName ||
        (!isSelf && !isGroup ? dName : '');
      const senderAvatar = senderInfo?.avatar || '';

      if (!isSelf && !isGroup && realName) {
        ipc.db?.updateContactProfile({
          zaloId, contactId: threadId, displayName: realName, avatarUrl: senderAvatar,
        }).catch(() => {});
      }

      updateContact(zaloId, {
        contact_id: threadId,
        ...(isSelf ? {} : {
          ...(realName ? { display_name: realName } : {}),
          ...(senderAvatar ? { avatar_url: senderAvatar } : {}),
          ...(alias ? { alias } : {}),
          is_replied: 0,  // tin nhắn đến → chưa trả lời
        }),
        contact_type: isGroup ? 'group' : 'user',
        last_message: buildMessagePreview(contentRaw, rawMsgType, isImage, content),
        last_message_time: timestamp,
      });

      if (isSelf) {
        // Tin nhắn từ chính mình gửi (từ nền tảng khác đồng bộ sang)
        // → đánh dấu đã trả lời + unread = 0 (không cộng unread)
        markReplied(zaloId, threadId);
        ipc.db?.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
      } else if (isSilent) {
        // Tin nhắn cũ (old_messages / getGroupChatHistory) — KHÔNG cộng unread, KHÔNG bắn sound/notification
        // Chỉ lưu message + update contact (đã xử lý ở trên)
      } else if (threadId !== activeThreadId || !windowFocusedRef.current) {
        // Thread khác, HOẶC thread đang active nhưng cửa sổ bị thu nhỏ/ẩn/mất focus
        // → vẫn tính là chưa đọc
        incrementUnread(zaloId, threadId);

        // ─── Badge taskbar — đọc sau khi incrementUnread đã cập nhật store ──
        ipc.app?.setBadge(getFilteredUnreadCount());

        // ─── Sound + Desktop notification ───────────────────────────────
        const appState = useAppStore.getState();
        const { notifSettings, isMuted, isInOthers } = appState;
        // Notification.permission đồng bộ với macOS system notification authorization (Electron 20+)
        // Khi user tắt notification trên macOS → permission = 'denied' → không phát âm thanh/hiện popup
        const notifAllowed = !('Notification' in window) || Notification.permission === 'granted';
        if (!isMuted(zaloId, threadId) && !isInOthers(zaloId, threadId)) {
          if (notifSettings.soundEnabled && notifAllowed) {
            playNotificationSound(notifSettings.volume);
          }
          if (notifSettings.desktopEnabled && notifAllowed) {
            const showNotif = (nameOverride?: string, avatarOverride?: string) => {
              const contacts = useChatStore.getState().contacts[zaloId] || [];
              const ctact = contacts.find(c => c.contact_id === threadId);
              const contactName = nameOverride || ctact?.alias || ctact?.display_name || alias || realName || threadId;
              const contactAvatar = avatarOverride || ctact?.avatar_url || undefined;
              const msgText = buildMessagePreview(contentRaw, rawMsgType, isImage, content).slice(0, 120);
              showDesktopNotification(
                contactName,
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
        // Tin nhắn từ người khác gửi vào thread đang mở VÀ cửa sổ đang focus → mark read ngay
        ipc.db?.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
        clearUnread(zaloId, threadId);
        // Gửi sự kiện đã đọc cho Zalo vì đang xem thread này
        sendSeenForThread(zaloId, threadId, isGroup ? 1 : 0);
      }

      if (!isGroup) {
        const contacts = useChatStore.getState().contacts[zaloId] || [];
        const existing = contacts.find((c) => c.contact_id === threadId);
        const cacheKey = `${zaloId}__${threadId}`;
        const hasRealName = existing && existing.display_name && existing.display_name !== threadId;
        if (!hasRealName || !isContactCacheFresh(cacheKey)) {
          fetchContactInfo(zaloId, threadId);
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

      // TARGET msgId: trong rMsg[0].gMsgID — đây là ID tin nhắn được react, KHÔNG phải action ID
      const rMsg = rData.content?.rMsg || reaction.content?.rMsg || [];
      const targetMsgId = rMsg.length > 0
        ? String(rMsg[0].gMsgID || rMsg[0].cMsgID || '')
        : String(rData.msgId || reaction.msgId || '');

      // rIcon: icon reaction (vd: ":>", "/-heart")
      const rawIcon = rData.content?.rIcon || reaction.content?.rIcon || reaction.rIcon || rData.rIcon || '';
      const emoji = reactionIconToEmoji(rawIcon);

      console.log(`[useZaloEvents] 🎭 reaction: thread=${threadId} targetMsg=${targetMsgId} user=${userId} icon=${rawIcon} → ${emoji}`);

      if (threadId && targetMsgId) {
        updateMessageReaction(zaloId, threadId, targetMsgId, userId, emoji);
        // Lưu vào DB
        ipc.db?.updateReaction({ zaloId, msgId: targetMsgId, userId, icon: emoji }).catch(() => {});
      }
    });

    // ─── Delete message events (chat.delete) ─────────────────────────────
    // Đánh dấu recalled thay vì xoá — giữ lịch sử, hiển thị "Tin nhắn đã bị thu hồi"
    const unsubDelete = ipc.on('event:delete', (data: any) => {
      const { zaloId, msgIds, threadId } = data;
      if (!Array.isArray(msgIds) || !msgIds.length) return;
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
      // Đánh dấu tin nhắn là đã thu hồi (không xóa) — hiển thị "Tin nhắn đã thu hồi"
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

    const unsubConnected = ipc.on('event:connected', (data: any) => {
      updateAccountStatus(data.zaloId, true, true);
      updateListenerActive(data.zaloId, true);
      loadAliases(data.zaloId);
      // Refresh contacts from DB so @ mention list is always up to date
      ipc.db?.getContacts(data.zaloId).then((res: any) => {
        if (res?.contacts?.length > 0) {
          useChatStore.getState().setContacts(data.zaloId, res.contacts);
          // Populate aliasMap từ DB để fetchContactInfo không overwrite alias
          for (const c of res.contacts) {
            if (c.alias) {
              aliasMap.set(`${data.zaloId}__${c.contact_id}`, c.alias);
            }
          }
        }
        // After contacts loaded, bulk-load group members from DB → populate groupInfoCache
        // so GroupAvatarSmall renders immediately without needing an API call
        return ipc.db?.getAllGroupMembers({ zaloId: data.zaloId });
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
            })),
            creatorId: '',
            adminIds: [],
            settings: undefined,
            fetchedAt: members[0]?.updated_at || Date.now(),
          });
        }
      }).catch(() => {});
    });

    // ─── Local path update (after image download) ─────────────────────────
    const unsubLocalPath = ipc.on('event:localPath', (data: any) => {
      const { zaloId, msgId, threadId, localPaths } = data;
      if (zaloId && msgId && threadId && localPaths) {
        updateMessageLocalPath(zaloId, threadId, msgId, localPaths);
      }
    });

    const unsubDisconnected = ipc.on('event:disconnected', (data: any) => {
      updateAccountStatus(data.zaloId, false, false);
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

    // ─── Group events (member join/leave etc.) ────────────────────────────
    const unsubGroupEvent = ipc.on('event:groupEvent', (data: any) => {
      const { zaloId, groupId, eventType, data: eventData, systemText, msgId, timestamp } = data;
      if (!zaloId || !groupId) return;

      // ── Insert system notification bubble into chatStore ──────────────
      if (systemText) {
        const contacts = useChatStore.getState().contacts[zaloId] || [];
        const threadContact = contacts.find(c => c.contact_id === groupId);
        const threadType = threadContact?.contact_type === 'group' ? 1 : (eventType === 'webchat_info' ? 0 : 1);
        // Lưu updateMembers vào attachments để ChatWindow render avatar/tên
        const d0 = eventData?.data || eventData || {};
        const updateMembers: any[] = d0.updateMembers || [];
        const attachments = updateMembers.length > 0
          ? JSON.stringify(updateMembers.map((m: any) => ({ id: m.id, dName: m.dName || '', avatar: m.avatar || m.avatar_25 || '' })))
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
            if (newName || newAvt) {
              ipc.db?.updateContactProfile({
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
              case 'add_admin': {
                if (members.find(m => m.userId === uid)) {
                  members = members.map(m => m.userId === uid ? { ...m, role: 2 } : m);
                } else {
                  members = [...members, {
                    userId: uid,
                    displayName: um.dName || um.zaloName || uid,
                    avatar: um.avatar || um.avatar_25 || '',
                    role: 2,
                  }];
                }
                break;
              }
              case 'remove_admin': {
                members = members.map(m =>
                  m.userId === uid ? { ...m, role: m.userId === creatorId ? 1 : 0 } : m
                );
                break;
              }
            }
          }

          // Patch cache in-place — no full API refetch needed
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
          // Message not found yet — store as pending and retry
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
      unsubMessage();
      unsubReaction();
      unsubDelete();
      unsubReminder();
      unsubUndo();
      unsubLocalPath();
      unsubConnected();
      unsubDisconnected();
      unsubListenerDead();
      unsubTyping();
      unsubSeen();
      unsubGroupInfoUpdate();
      unsubGroupEvent();
      unsubEmpSender();
    };
  }, [activeThreadId]);
}
