/**
 * Shared avatar retry logic for Zalo, Facebook and Telegram contacts.
 * Handles an avatar that fails to load (403, expired CDN, broken URL, file missing) by
 * calling the refresh API and updating the contact store again.
 *
 * Used in: ConversationList, ChatWindow, AccountCard, GroupInfoPanel...
 */

import ipc from '../ipc';
import { CHANNEL, isFacebook, isTelegram } from '@/lib/channels/channelHelper';
import { useAccountStore } from '@/store/accounts/accountStore';

// ─── Module-level debounce: avoids duplicate refresh calls ─────────────────────
const _pending = new Map<string, Promise<string | null>>();

// TTL cache: if the refresh just finished and it still fails → no more retries for 60 minutes
const _recentlyFailed = new Map<string, number>();
const FAIL_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Handles an avatar that fails to load (img onError).
 * Detects the channel itself (Zalo/Facebook) and calls the matching refresh API.
 *
 * @returns the new avatar URL if the refresh succeeds, null if it fails.
 */
export async function handleAvatarError(opts: {
  ownerId: string;        // zaloId of the logged-in account
  contactId: string;      // userId / contact_id of the person whose avatar failed
  channel?: string;       // 'zalo' | 'facebook' | ...
  signal?: AbortSignal;   // optional abort
}): Promise<string | null> {
  const { ownerId, contactId, channel = CHANNEL.ZALO } = opts;
  if (!ownerId || !contactId) return null;

  const cacheKey = `${ownerId}_${contactId}`;

  // Cooldown: failed recently → skip
  const lastFail = _recentlyFailed.get(cacheKey);
  if (lastFail && Date.now() - lastFail < FAIL_COOLDOWN_MS) return null;

  // A request is already pending for the same contact → reuse the promise
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

    if (isFacebook(channel)) {
      // Facebook: use refreshContactAvatar (GraphQL re-fetch)
      const res = await ipc.fb?.refreshContactAvatar({ accountId: ownerId, userId: contactId });
      if (res?.success && res.avatarUrl) {
        newUrl = res.avatarUrl;
      }
    } else if (isTelegram(channel)) {
      // Telegram: re-fetch the avatar when its file was deleted (404)
      if (contactId === ownerId) {
        // Self avatar
        try {
          const res = await (ipc as any).telegramUser?.fetchSelfAvatar?.(ownerId);
          if (res?.success && res.avatarUrl) {
            newUrl = res.avatarUrl;
          }
        } catch {}
      } else {
        // Other contacts (users, groups, channels)
        try {
          const res = await (ipc as any).telegramUser?.refreshContactAvatar?.({ accountId: ownerId, chatId: contactId });
          if (res?.success && res.avatarUrl) {
            newUrl = res.avatarUrl;
          }
        } catch {}
      }
      if (!newUrl) return null;
    } else {
      // Zalo: if it is my own account → checkAndRefreshAvatar
      // If it is another contact → getUserInfo to get the new avatar
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
 * Builds a minimal auth object for IPC calls.
 * Uses buildZaloAuth if it exists, otherwise a fallback.
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
 * Clears the cooldown for 1 contact (used when the user refreshes on purpose).
 */
export function clearAvatarCooldown(contactId: string) {
  _recentlyFailed.delete(contactId);
}
