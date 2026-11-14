/**
 * zaloPresence.ts: Zalo online status (ZL-01, SRS Deplao): pure part shared by main + renderer.
 *
 * Source (zca-js 2.2.0): lastOnline(uid) → { settings: { show_online_status }, lastOnline } and getFriendOnlines() →
 * { onlines: [{ userId, status }] } (only friends who are online). The unit of lastOnline has not been checked on a real account, so
 * it accepts both seconds and ms.
 */
import { describeLastSeen } from '../chat/presenceText';
import { tr } from '../i18n';

export type ZaloPresenceStatus = 'online' | 'offline' | 'hidden' | 'unknown';

export interface ZaloPresence {
  status: ZaloPresenceStatus;
  /** Most recent last-seen time (ms), if Zalo returns it. */
  lastSeenAt?: number;
  /** Whether that person allows their online status to be shown. */
  showOnlineStatus: boolean;
}

/**
 * List of online friends (getFriendOnlines: the green dot in the conversation list, ZL-01 phase 2): TEMPORARILY OFF since
 * 22/10/2026 because Zalo returns HTTP 404 for /api/social/friend/onlines, which zca-js 2.2.0 (the latest version) still calls. Off = this
 * API is not called anywhere: status uses lastOnline only, and no green dot is drawn. Turn it back on (true) when zca-js updates the function.
 */
export const ZALO_FRIEND_ONLINES_ENABLED = false;

/** Active within the last 5 minutes = currently active (same expiry as "online" in chatStore). */
export const ZALO_ONLINE_WINDOW_MS = 5 * 60_000;

/** zca-js lastOnline → ms. A number below 1e12 is treated as seconds (1e12 ms = year 2001). 0 / invalid → undefined. */
export function lastOnlineMs(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function isHiddenSetting(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return value === false || value === 0 || value === '0' || value === 'false';
}

/** Merges the lastOnline result + the list of online friends into one status. */
export function zaloPresenceFrom(
  lastOnlineRes: any,
  onlineIds: ReadonlySet<string> | null,
  userId: string,
  now: number = Date.now(),
): ZaloPresence {
  if (isHiddenSetting(lastOnlineRes?.settings?.show_online_status)) return { status: 'hidden', showOnlineStatus: false };
  if (onlineIds?.has(String(userId))) return { status: 'online', showOnlineStatus: true, lastSeenAt: now };
  const lastSeenAt = lastOnlineMs(lastOnlineRes?.lastOnline);
  if (lastSeenAt === undefined) return { status: 'unknown', showOnlineStatus: true };
  if (now - lastSeenAt < ZALO_ONLINE_WINDOW_MS) return { status: 'online', showOnlineStatus: true, lastSeenAt };
  return { status: 'offline', showOnlineStatus: true, lastSeenAt };
}

/** List of friend IDs that are online, from getFriendOnlines (being in the list = online). */
export function zaloOnlineIds(res: any): Set<string> {
  const list = Array.isArray(res?.onlines) ? res.onlines : [];
  return new Set(list.map((item: any) => String(item?.userId ?? '')).filter(Boolean));
}

/**
 * The status that can be shown from data already on hand, without asking Zalo (the line below the name in the header, ZL-01 phase 2): friends in the
 * online list, or the result of the most recent profile open (chatStore.userPresence: lastSeen in seconds, "online" expires after 5 minutes). Nothing → null.
 */
export function zaloCachedPresence(
  onlineFriend: boolean,
  entry: { status: string; lastSeen?: number; updatedAt: number } | null | undefined,
  now: number = Date.now(),
): ZaloPresence | null {
  if (onlineFriend) return { status: 'online', showOnlineStatus: true };
  if (!entry) return null;
  if (entry.status === 'online' && now - entry.updatedAt < ZALO_ONLINE_WINDOW_MS) return { status: 'online', showOnlineStatus: true };
  const lastSeenAt = Number(entry.lastSeen) > 0 ? Number(entry.lastSeen) * 1000 : undefined;
  return lastSeenAt ? { status: 'offline', lastSeenAt, showOnlineStatus: true } : null;
}

/** "trực tuyến" (online), "truy cập 14:05" (last seen 14:05), "đã ẩn trạng thái truy cập" (access status hidden); unknown → ''. */
export function describeZaloPresence(presence: ZaloPresence | null | undefined, now: number = Date.now()): string {
  switch (presence?.status) {
    case 'online': return tr('trực tuyến');
    case 'hidden': return tr('đã ẩn trạng thái truy cập');
    case 'offline': return describeLastSeen(presence.lastSeenAt, now);
    default: return '';
  }
}
