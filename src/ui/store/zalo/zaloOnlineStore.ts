/**
 * zaloOnlineStore: the Zalo friends currently online for each account (SRS ZL-01 phase 2, FR-ZL01.6): a green dot in the
 * conversation list and a "Trực tuyến" (Online) line under the name in the header. Kept in memory only (NFR-06: the online history of
 * other people is not saved). After 5 minutes without a refresh (while the window is not focused, Zalo is not asked) → the list of that account is dropped.
 * Refreshed by: hooks/zalo/useZaloFriendOnlines.
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

/** Use as a selector: `useZaloOnlineStore((s) => isZaloFriendOnline(s, accountId, userId))` → only the row that changed is redrawn. */
export function isZaloFriendOnline(state: Pick<ZaloOnlineState, 'byAccount'>, accountId: string | null | undefined, userId: string | null | undefined): boolean {
  if (!accountId || !userId) return false;
  return !!state.byAccount[accountId]?.ids.has(String(userId));
}
