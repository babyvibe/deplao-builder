/**
 * zaloOnlineStore — bạn bè Zalo đang online của từng tài khoản (SRS ZL-01 giai đoạn 2, FR-ZL01.6): chấm xanh trong danh
 * sách hội thoại và dòng "Trực tuyến" dưới tên trên header. Chỉ giữ trong bộ nhớ (NFR-06: không lưu lịch sử online của
 * người khác); quá 5 phút không làm mới (cửa sổ không focus thì không hỏi Zalo) → bỏ danh sách của tài khoản đó.
 * Làm mới: hooks/zalo/useZaloFriendOnlines.
 */
import { create } from 'zustand';
import { ZALO_ONLINE_WINDOW_MS } from '../../../shared/zalo/zaloPresence';

interface ZaloOnlineEntry {
  ids: ReadonlySet<string>;
  at: number;
}

interface ZaloOnlineState {
  byAccount: Record<string, ZaloOnlineEntry>;
  setOnline: (accountId: string, userIds: Iterable<string>, at?: number) => void;
  clear: (accountId: string) => void;
}

const expiry = new Map<string, ReturnType<typeof setTimeout>>();

export const useZaloOnlineStore = create<ZaloOnlineState>((set) => ({
  byAccount: {},
  setOnline: (accountId, userIds, at = Date.now()) => {
    if (!accountId) return;
    const previous = expiry.get(accountId);
    if (previous) clearTimeout(previous);
    expiry.set(accountId, setTimeout(() => useZaloOnlineStore.getState().clear(accountId), ZALO_ONLINE_WINDOW_MS));
    set((state) => ({ byAccount: { ...state.byAccount, [accountId]: { ids: new Set(Array.from(userIds, String)), at } } }));
  },
  clear: (accountId) => {
    const timer = expiry.get(accountId);
    if (timer) clearTimeout(timer);
    expiry.delete(accountId);
    set((state) => {
      if (!state.byAccount[accountId]) return state;
      const byAccount = { ...state.byAccount };
      delete byAccount[accountId];
      return { byAccount };
    });
  },
}));

/** Dùng làm selector: `useZaloOnlineStore((s) => isZaloFriendOnline(s, accountId, userId))` → chỉ hàng đổi mới vẽ lại. */
export function isZaloFriendOnline(state: Pick<ZaloOnlineState, 'byAccount'>, accountId: string | null | undefined, userId: string | null | undefined): boolean {
  if (!accountId || !userId) return false;
  return !!state.byAccount[accountId]?.ids.has(String(userId));
}
