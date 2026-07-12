/**
 * Shared avatar retry logic cho cả Zalo và Facebook contacts.
 * Xử lý khi avatar load lỗi (403, expired CDN, broken URL) bằng cách
 * gọi API refresh và cập nhật lại contact store.
 *
 * Dùng ở: ConversationList, ChatWindow, AccountCard, GroupInfoPanel...
 */

import ipc from './ipc';
import { useAccountStore } from '@/store/accountStore';

// ─── Module-level debounce: tránh gọi refresh trùng lặp ─────────────────────
const _pending = new Map<string, Promise<string | null>>();

// TTL cache: nếu vừa refresh xong mà vẫn lỗi → không retry nữa trong 60 phút
const _recentlyFailed = new Map<string, number>();
const FAIL_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Xử lý khi avatar load lỗi (img onError).
 * Tự detect channel (Zalo/Facebook) và gọi API refresh phù hợp.
 *
 * @returns URL avatar mới nếu refresh thành công, null nếu thất bại.
 */
export async function handleAvatarError(opts: {
  ownerId: string;        // zaloId của tài khoản đang đăng nhập
  contactId: string;      // userId / contact_id của người có avatar lỗi
  channel?: string;       // 'zalo' | 'facebook' | ...
  signal?: AbortSignal;   // optional abort
}): Promise<string | null> {
  const { ownerId, contactId, channel = 'zalo' } = opts;
  if (!ownerId || !contactId) return null;

  const cacheKey = `${ownerId}_${contactId}`;

  // Cooldown: vừa fail gần đây → skip
  const lastFail = _recentlyFailed.get(cacheKey);
  if (lastFail && Date.now() - lastFail < FAIL_COOLDOWN_MS) return null;

  // Đang có request pending cho cùng contact → reuse promise
  const existing = _pending.get(cacheKey);
  if (existing) return existing;

  const promise = _doRefresh(ownerId, contactId, channel).finally(() => {
    _pending.delete(cacheKey);
  });
  _pending.set(cacheKey, promise);
  return promise;
}

async function _doRefresh(ownerId: string, contactId: string, channel: string): Promise<string | null> {
  try {
    let newUrl: string | undefined;

    if (channel === 'facebook') {
      // Facebook: dùng refreshContactAvatar (GraphQL re-fetch)
      const res = await ipc.fb?.refreshContactAvatar({ accountId: ownerId, userId: contactId });
      if (res?.success && res.avatarUrl) {
        newUrl = res.avatarUrl;
      }
    } else {
      // Zalo: nếu là chính account mình → checkAndRefreshAvatar
      // Nếu là contact khác → getUserInfo để lấy avatar mới
      if (contactId === ownerId) {
        const res = await ipc.login?.checkAndRefreshAvatar(ownerId);
        if (res?.success && res.refreshed && res.avatar_url) {
          newUrl = res.avatar_url;
        }
      } else {
        const auth = _buildAuth(ownerId);
        if (auth) {
          const res = await ipc.zalo?.getUserInfo({ auth, userId: contactId });
          const profile = res?.response?.changed_profiles?.[contactId];
          if (profile?.avatar) {
            newUrl = profile.avatar;
          }
        }
      }
    }

    if (!newUrl) {
      _recentlyFailed.set(contactId, Date.now());
      return null;
    }
    return newUrl;
  } catch {
    _recentlyFailed.set(contactId, Date.now());
    return null;
  }
}

/**
 * Build auth object minimal cho IPC calls.
 * Dùng buildZaloAuth nếu có, không thì fallback.
 */
function _buildAuth(ownerId: string) {
  try {
    const acc = useAccountStore.getState().accounts.find((a: any) => a.zalo_id === ownerId);
    if (!acc) return null;
    return { cookies: acc.cookies || '', imei: acc.imei || '', userAgent: acc.user_agent || '', accountId: ownerId };
  } catch {
    return null;
  }
}

/**
 * Clear cooldown cho 1 contact (dùng khi user chủ động refresh).
 */
export function clearAvatarCooldown(contactId: string) {
  _recentlyFailed.delete(contactId);
}
