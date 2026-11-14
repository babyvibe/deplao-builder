/**
 * zaloPresenceCache.ts: Zalo access status (ZL-01) in the main process. It asks Zalo only when the user opens a profile / conversation details,
 * and it fetches the list of online friends for the green dot in the conversation list (phase 2; the UI limits itself to one call per 2 minutes while the window is focused). It caches for 60 s per person and per account's online-friends list, and merges
 * duplicate calls that are in flight: the Boss machine, employee machines (through the proxy) and the Public API share it. No DB writes: it does not keep the
 * online history of other people.
 *
 * getFriendOnlines (/api/social/friend/onlines) returns HTTP 404: seen on a real account on 22/10/2026, and the latest zca-js 2.2.0 still calls this route, so it is temporarily turned off with ZALO_FRIEND_ONLINES_ENABLED (shared/zalo/zaloPresence). When it is turned back on and a 404 still comes back,
 * that account is not asked again in this app session: the green dot is off, and the access status relies on lastOnline only.
 */
import Logger from '../../utils/Logger';
import { type ZaloPresence, ZALO_FRIEND_ONLINES_ENABLED, zaloOnlineIds, zaloPresenceFrom } from '../../shared/zalo/zaloPresence';
import { tr } from '../../shared/i18n';

export const ZALO_PRESENCE_TTL_MS = 60_000;
const CALL_TIMEOUT_MS = 15_000;
const MAX_ENTRIES = 2000;

export interface ZaloPresenceApi {
  lastOnline(uid: string): Promise<any>;
  getFriendOnlines(): Promise<any>;
}

const presenceCache = new Map<string, { value: ZaloPresence; at: number }>();
const onlineCache = new Map<string, { ids: Set<string>; at: number }>();
const onlineInflight = new Map<string, Promise<Set<string>>>();
/** Accounts for which Zalo returned 404 for getFriendOnlines in this session. */
const onlinesUnsupported = new Set<string>();
const inflight = new Map<string, Promise<ZaloPresence>>();

function withTimeout<T>(task: Promise<T>, ms: number = CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(tr('Zalo không phản hồi'))), ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function remember(key: string, value: ZaloPresence, at: number): void {
  presenceCache.delete(key);
  presenceCache.set(key, { value, at });
  if (presenceCache.size > MAX_ENTRIES) {
    const oldest = presenceCache.keys().next().value;
    if (oldest !== undefined) presenceCache.delete(oldest);
  }
}

/** Zalo no longer has this route (HTTP 404). This is different from network errors / timeouts, which can be retried. */
export function isZaloEndpointMissing(err: any): boolean {
  if (Number(err?.status) === 404 || Number(err?.response?.status) === 404) return true;
  return /status code 404/i.test(String(err?.message || ''));
}

function friendOnlineIds(
  zaloId: string, api: Pick<ZaloPresenceApi, 'getFriendOnlines'>, now: number, force: boolean,
): Promise<Set<string>> {
  if (onlinesUnsupported.has(zaloId)) return Promise.resolve(new Set());
  const cached = onlineCache.get(zaloId);
  if (!force && cached && now - cached.at < ZALO_PRESENCE_TTL_MS) return Promise.resolve(cached.ids);
  const running = onlineInflight.get(zaloId);
  if (running) return running;
  const task = (async () => {
    try {
      const ids = zaloOnlineIds(await withTimeout(api.getFriendOnlines()));
      onlineCache.set(zaloId, { ids, at: now });
      return ids;
    } catch (err: any) {
      if (isZaloEndpointMissing(err)) {
        onlinesUnsupported.add(zaloId);
        Logger.warn(`[ZaloPresence] ${zaloId}: Zalo trả 404 cho getFriendOnlines — tắt chấm xanh online trong phiên này, trạng thái truy cập dùng lastOnline`);
      }
      throw err;
    }
  })().finally(() => { onlineInflight.delete(zaloId); });
  onlineInflight.set(zaloId, task);
  return task;
}

/**
 * Ids of the online friends of account `zaloId` (the green dot in the conversation list). `force` = skip the cache. While it is off
 * (ZALO_FRIEND_ONLINES_ENABLED) or Zalo returns 404 → { supported: false }, without calling Zalo. `enabled` is only for tests.
 */
export async function getZaloFriendOnlines(
  zaloId: string,
  api: Pick<ZaloPresenceApi, 'getFriendOnlines'>,
  opts: { force?: boolean; now?: number; enabled?: boolean } = {},
): Promise<{ supported: boolean; userIds: string[] }> {
  if (!(opts.enabled ?? ZALO_FRIEND_ONLINES_ENABLED) || onlinesUnsupported.has(zaloId)) return { supported: false, userIds: [] };
  try {
    return { supported: true, userIds: Array.from(await friendOnlineIds(zaloId, api, opts.now ?? Date.now(), !!opts.force)) };
  } catch (err) {
    if (onlinesUnsupported.has(zaloId)) return { supported: false, userIds: [] };
    throw err;
  }
}

/**
 * Access status of `userId` as seen from account `zaloId`. `force` = skip the cache (the refresh button). The online-friends list is only asked for when
 * ZALO_FRIEND_ONLINES_ENABLED is on (`friendOnlines` is only for tests).
 */
export function getZaloPresence(
  zaloId: string,
  userId: string,
  api: ZaloPresenceApi,
  opts: { force?: boolean; now?: number; friendOnlines?: boolean } = {},
): Promise<ZaloPresence> {
  const now = opts.now ?? Date.now();
  const key = `${zaloId}:${userId}`;
  const cached = presenceCache.get(key);
  if (!opts.force && cached && now - cached.at < ZALO_PRESENCE_TTL_MS) return Promise.resolve(cached.value);
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const [last, online] = await Promise.allSettled([
      withTimeout(api.lastOnline(userId)),
      (opts.friendOnlines ?? ZALO_FRIEND_ONLINES_ENABLED) ? friendOnlineIds(zaloId, api, now, !!opts.force) : Promise.resolve(null),
    ]);
    const onlineIds = online.status === 'fulfilled' ? online.value : null;
    let value: ZaloPresence;
    if (last.status === 'fulfilled') value = zaloPresenceFrom(last.value, onlineIds, userId, now);
    else if (onlineIds?.has(userId)) value = { status: 'online', showOnlineStatus: true, lastSeenAt: now };
    else throw last.reason;
    remember(key, value, now);
    return value;
  })().finally(() => { inflight.delete(key); });
  inflight.set(key, task);
  return task;
}

/** Only used in tests. */
export function resetZaloPresenceCache(): void {
  presenceCache.clear();
  onlineCache.clear();
  onlineInflight.clear();
  onlinesUnsupported.clear();
  inflight.clear();
}
