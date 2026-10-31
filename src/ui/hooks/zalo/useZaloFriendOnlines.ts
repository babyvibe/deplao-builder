/**
 * Làm mới danh sách bạn bè Zalo đang online (SRS ZL-01 giai đoạn 2, FR-ZL01.6) cho chấm xanh trong danh sách hội thoại:
 * khi cửa sổ được focus và mỗi 2 phút lúc cửa sổ đang focus, tối đa 1 lần / 2 phút / tài khoản (kể cả khi danh sách mount
 * lại). Main đệm thêm 60 s và gộp lời gọi trùng (zaloPresenceCache); máy nhân viên đi qua Boss như mọi zalo:*.
 * Zalo không còn đường getFriendOnlines cho tài khoản đó (main trả supported: false) → thôi hỏi trong phiên này.
 * Đang tạm tắt (ZALO_FRIEND_ONLINES_ENABLED = false, Zalo trả 404 từ 22/10/2026) → hook không làm gì.
 */
import React from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { isZalo } from '@/lib/channels/channelHelper';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useZaloOnlineStore } from '@/store/zalo/zaloOnlineStore';
import { ZALO_FRIEND_ONLINES_ENABLED } from '../../../shared/zalo/zaloPresence';

export const ZALO_ONLINE_REFRESH_MS = 120_000;

/** accountId → lần hỏi gần nhất (ms) trong phiên này; giữ cả khi lỗi để không dồn lời gọi. */
const lastFetchAt = new Map<string, number>();
const inflight = new Set<string>();
const unsupported = new Set<string>();

export function shouldRefreshZaloOnline(lastAt: number | undefined, now: number, focused: boolean): boolean {
  return focused && (lastAt === undefined || now - lastAt >= ZALO_ONLINE_REFRESH_MS);
}

function windowFocused(): boolean {
  try {
    return typeof document === 'undefined' || document.hasFocus();
  } catch {
    return true;
  }
}

export async function refreshZaloFriendOnlines(accountId: string, now: number = Date.now(), focused: boolean = windowFocused()): Promise<void> {
  if (!accountId || inflight.has(accountId) || unsupported.has(accountId)) return;
  if (!shouldRefreshZaloOnline(lastFetchAt.get(accountId), now, focused)) return;
  const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId);
  if (!account || !isZalo(account.channel) || account.isOnline === false) return;
  lastFetchAt.set(accountId, now);
  inflight.add(accountId);
  try {
    const res = await ipc.zalo?.getFriendOnlines({ auth: buildZaloAuth(account as any, accountId) });
    if (res?.success && res.response?.supported === false) {
      unsupported.add(accountId);
      useZaloOnlineStore.getState().clear(accountId);
      return;
    }
    const userIds = res?.success ? res.response?.userIds : undefined;
    if (Array.isArray(userIds)) useZaloOnlineStore.getState().setOnline(accountId, userIds, Date.now());
  } catch {
    // Lỗi mạng / tài khoản mất kết nối: lần focus sau (≥ 2 phút) thử lại; chấm cũ tự hết hạn sau 5 phút
  } finally {
    inflight.delete(accountId);
  }
}

/** Gắn ở danh sách hội thoại: `accountIds` = các tài khoản Zalo đang hiện. */
export function useZaloFriendOnlines(accountIds: readonly string[]): void {
  const key = ZALO_FRIEND_ONLINES_ENABLED ? accountIds.filter(Boolean).join(',') : '';
  React.useEffect(() => {
    if (!key) return;
    const ids = key.split(',');
    const tick = () => { for (const id of ids) void refreshZaloFriendOnlines(id); };
    tick();
    window.addEventListener('focus', tick);
    const timer = window.setInterval(tick, ZALO_ONLINE_REFRESH_MS);
    return () => {
      window.removeEventListener('focus', tick);
      window.clearInterval(timer);
    };
  }, [key]);
}

/** Chỉ dùng trong test. */
export function resetZaloFriendOnlines(): void {
  lastFetchAt.clear();
  inflight.clear();
  unsupported.clear();
}
