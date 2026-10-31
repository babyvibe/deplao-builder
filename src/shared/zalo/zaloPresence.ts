/**
 * zaloPresence.ts — trạng thái truy cập Zalo (ZL-01, SRS Deplao): phần thuần dùng chung main + renderer.
 *
 * Nguồn (zca-js 2.2.0): lastOnline(uid) → { settings: { show_online_status }, lastOnline } và getFriendOnlines() →
 * { onlines: [{ userId, status }] } (chỉ bạn bè đang online). Đơn vị của lastOnline chưa kiểm trên tài khoản thật nên
 * nhận cả giây lẫn ms.
 */
import { describeLastSeen } from '../chat/presenceText';

export type ZaloPresenceStatus = 'online' | 'offline' | 'hidden' | 'unknown';

export interface ZaloPresence {
  status: ZaloPresenceStatus;
  /** Mốc truy cập gần nhất (ms) nếu Zalo trả về. */
  lastSeenAt?: number;
  /** Người đó có cho hiện trạng thái truy cập không. */
  showOnlineStatus: boolean;
}

/**
 * Danh sách bạn đang online (getFriendOnlines — chấm xanh trong danh sách hội thoại, ZL-01 giai đoạn 2): TẠM TẮT từ
 * 22/10/2026 vì Zalo trả HTTP 404 cho /api/social/friend/onlines mà zca-js 2.2.0 (bản mới nhất) vẫn gọi. Tắt = không gọi
 * API này ở đâu cả: trạng thái truy cập chỉ dùng lastOnline, không vẽ chấm xanh. Bật lại (true) khi zca-js cập nhật hàm.
 */
export const ZALO_FRIEND_ONLINES_ENABLED = false;

/** Truy cập trong vòng 5 phút = đang hoạt động (cùng mốc hết hạn "online" của chatStore). */
export const ZALO_ONLINE_WINDOW_MS = 5 * 60_000;

/** lastOnline của zca-js → ms. Số nhỏ hơn 1e12 coi là giây (1e12 ms = năm 2001). 0 / không hợp lệ → undefined. */
export function lastOnlineMs(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function isHiddenSetting(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return value === false || value === 0 || value === '0' || value === 'false';
}

/** Gộp kết quả lastOnline + danh sách bạn đang online thành một trạng thái. */
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

/** Danh sách id bạn bè đang online từ getFriendOnlines (có trong danh sách = đang online). */
export function zaloOnlineIds(res: any): Set<string> {
  const list = Array.isArray(res?.onlines) ? res.onlines : [];
  return new Set(list.map((item: any) => String(item?.userId ?? '')).filter(Boolean));
}

/**
 * Trạng thái hiện được từ dữ liệu đã có, không hỏi Zalo (dòng dưới tên trên header — ZL-01 giai đoạn 2): bạn bè có trong
 * danh sách đang online, hoặc kết quả lần mở hồ sơ gần nhất (chatStore.userPresence: lastSeen tính bằng giây, "online"
 * hết hạn sau 5 phút). Không có gì → null.
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

/** "trực tuyến", "truy cập 14:05", "đã ẩn trạng thái truy cập"; không rõ → ''. */
export function describeZaloPresence(presence: ZaloPresence | null | undefined, now: number = Date.now()): string {
  switch (presence?.status) {
    case 'online': return 'trực tuyến';
    case 'hidden': return 'đã ẩn trạng thái truy cập';
    case 'offline': return describeLastSeen(presence.lastSeenAt, now);
    default: return '';
  }
}
