/**
 * zaloPresenceCache.ts — trạng thái truy cập Zalo (ZL-01) ở main process: chỉ hỏi Zalo khi người dùng mở hồ sơ / chi tiết
 * hội thoại, và danh sách bạn đang online cho chấm xanh của danh sách hội thoại (giai đoạn 2 — giao diện tự giới hạn
 * 1 lần / 2 phút khi cửa sổ đang focus). Đệm 60 s cho mỗi người và cho danh sách bạn đang online của mỗi tài khoản, gộp
 * các lời gọi trùng đang chạy — Boss, máy nhân viên (qua proxy) và Public API dùng chung. Không ghi DB: không giữ lịch sử
 * online của người khác.
 *
 * getFriendOnlines (/api/social/friend/onlines) trả HTTP 404 — gặp trên tài khoản thật ngày 22/10/2026, zca-js 2.2.0 mới
 * nhất vẫn gọi đường này → tạm tắt hẳn bằng ZALO_FRIEND_ONLINES_ENABLED (shared/zalo/zaloPresence). Khi bật lại mà vẫn gặp 404
 * → tài khoản đó không hỏi lại trong phiên app: chấm xanh tắt, trạng thái truy cập chỉ dựa vào lastOnline.
 */
import Logger from '../../utils/Logger';
import { type ZaloPresence, ZALO_FRIEND_ONLINES_ENABLED, zaloOnlineIds, zaloPresenceFrom } from '../../shared/zalo/zaloPresence';

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
/** Tài khoản mà Zalo trả 404 cho getFriendOnlines trong phiên này. */
const onlinesUnsupported = new Set<string>();
const inflight = new Map<string, Promise<ZaloPresence>>();

function withTimeout<T>(task: Promise<T>, ms: number = CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Zalo không phản hồi')), ms); }),
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

/** Zalo không còn đường này (HTTP 404), khác lỗi mạng / hết giờ (thử lại được). */
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
 * Id bạn bè đang online của tài khoản `zaloId` (chấm xanh trong danh sách hội thoại). `force` = bỏ qua đệm. Đang tắt
 * (ZALO_FRIEND_ONLINES_ENABLED) hoặc Zalo trả 404 → { supported: false }, không gọi Zalo. `enabled` chỉ để test.
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
 * Trạng thái truy cập của `userId` nhìn từ tài khoản `zaloId`. `force` = bỏ qua đệm (nút làm mới). Danh sách bạn đang
 * online chỉ được hỏi khi ZALO_FRIEND_ONLINES_ENABLED (`friendOnlines` chỉ để test).
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

/** Chỉ dùng trong test. */
export function resetZaloPresenceCache(): void {
  presenceCache.clear();
  onlineCache.clear();
  onlineInflight.clear();
  onlinesUnsupported.clear();
  inflight.clear();
}
