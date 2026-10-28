/**
 * Hội thoại ẩn bằng PIN của Zalo (ZL-03, SRS Deplao) phía giao diện.
 *  - Ẩn và tài khoản đang khoá → không hiện ở danh sách / hộp thư gộp / tìm kiếm chung.
 *  - Gõ đúng 4 chữ số của PIN vào ô tìm kiếm → mở khoá tài khoản đó (so PIN ở main của máy Boss; sai không báo gì):
 *    danh sách hội thoại chỉ còn các hội thoại ẩn của tài khoản đó (ConversationList), không trộn hội thoại thường.
 *  - Tự ẩn lại: đổi tài khoản / hộp thư gộp, 5 phút không thao tác; khoá app ở App.tsx; ✕ ở dòng "Hội thoại ẩn" hoặc
 *    kính lúp đỏ của ô tìm kiếm.
 * Trạng thái mở khoá chỉ ở máy này (quyết định Q4). Âm thanh / thông báo / số chưa đọc luôn tắt cho hội thoại ẩn (Q3).
 */
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';

export const HIDDEN_IDLE_RELOCK_MS = 5 * 60_000;
/** Bấm kính lúp đỏ nhiều lần → mỗi tài khoản hỏi Zalo tối đa một lần trong khoảng này. */
export const HIDDEN_MANUAL_REFRESH_MS = 30_000;
const PIN_TEXT = /^\d{4}$/;
const lastManualRefresh = new Map<string, number>();

export function zaloAuthFor(accountId: string) {
  const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId);
  return account ? buildZaloAuth(account as any, accountId) : null;
}

/** (zaloId, contactId) → true khi hội thoại đang ẩn và tài khoản chưa mở khoá. */
export function useHiddenLockedPredicate(): (zaloId: string | null | undefined, contactId: string | null | undefined) => boolean {
  const { hidden, unlocked } = useAppStore(useShallow((s) => ({ hidden: s.hiddenConversations, unlocked: s.hiddenUnlocked })));
  return React.useCallback(
    (zaloId, contactId) => !!zaloId && !!contactId && !!hidden[zaloId]?.has(contactId) && !unlocked[zaloId],
    [hidden, unlocked],
  );
}

/**
 * Chuỗi gõ vào ô tìm kiếm là đúng 4 chữ số → thử mở khoá lần lượt các tài khoản đang có hội thoại ẩn.
 * true = đã mở một tài khoản (ô tìm kiếm nên tự xoá để PIN không còn trên màn hình).
 */
export async function tryUnlockHiddenFromSearch(text: string, accountIds: ReadonlyArray<string | null | undefined>): Promise<boolean> {
  const pin = text.trim();
  if (!PIN_TEXT.test(pin)) return false;
  for (const zaloId of accountIds) {
    if (!zaloId) continue;
    const state = useAppStore.getState();
    if (state.hiddenUnlocked[zaloId] || !(state.hiddenConversations[zaloId]?.size)) continue;
    const auth = zaloAuthFor(zaloId);
    if (!auth) continue;
    try {
      const res = await ipc.zalo?.hiddenUnlock({ auth, pin });
      const out = res?.success ? res.response : null;
      if (out?.ok) {
        useAppStore.getState().setHiddenThreads(zaloId, out.threadIds || []);
        useAppStore.getState().setHiddenUnlocked(zaloId, true);
        return true;
      }
    } catch { /* sai / mất kết nối: coi như tìm kiếm thường */ }
  }
  return false;
}

/**
 * Bấm kính lúp đỏ của ô tìm kiếm: đọc lại hội thoại ẩn từ Zalo (đổi / xoá PIN trên điện thoại không có sự kiện realtime). Zalo không còn mã
 * PIN → main bỏ cờ ẩn, các hội thoại hiện lại. Trả các tài khoản không còn PIN (để báo người dùng).
 */
export async function refreshHiddenFromZalo(accountIds: ReadonlyArray<string>, now: number = Date.now()): Promise<{ noPin: string[] }> {
  const noPin: string[] = [];
  for (const zaloId of accountIds) {
    const last = lastManualRefresh.get(zaloId);
    if (!zaloId || (last !== undefined && now - last < HIDDEN_MANUAL_REFRESH_MS)) continue;
    const auth = zaloAuthFor(zaloId);
    if (!auth) continue;
    lastManualRefresh.set(zaloId, now);
    try {
      const res = await ipc.zalo?.hiddenStatus({ auth, force: true });
      if (res?.success && res.response && !res.response.hasPin) noPin.push(zaloId);
    } catch { /* mất kết nối: giữ nguyên, lần bấm sau thử lại */ }
  }
  return { noPin };
}

/** Chỉ dùng trong test. */
export function resetHiddenManualRefresh(): void {
  lastManualRefresh.clear();
}

/** Ẩn / bỏ ẩn một hội thoại trên Zalo. Ẩn lần đầu (chưa có PIN) → `requestPin` mở hộp đặt PIN trước. */
export async function setZaloConversationHidden(
  zaloId: string,
  contactId: string,
  isGroup: boolean,
  hidden: boolean,
  requestPin: () => Promise<boolean>,
): Promise<{ ok: boolean; error?: string }> {
  const auth = zaloAuthFor(zaloId);
  if (!auth) return { ok: false, error: 'Không tìm thấy tài khoản' };
  if (hidden) {
    const status = await ipc.zalo?.hiddenStatus({ auth });
    if (!status?.success) return { ok: false, error: status?.error || 'Không đọc được hội thoại ẩn từ Zalo' };
    if (!status.response?.hasPin && !(await requestPin())) return { ok: false };
  }
  const res = await ipc.zalo?.setConversationHidden({ auth, threadId: contactId, type: isGroup ? 1 : 0, hidden });
  if (!res?.success) return { ok: false, error: res?.error || 'Zalo từ chối thay đổi' };
  const store = useAppStore.getState();
  const next = new Set(store.hiddenConversations[zaloId] || []);
  if (hidden) next.add(contactId);
  else next.delete(contactId);
  store.setHiddenThreads(zaloId, Array.from(next));
  return { ok: true };
}

/** Tự ẩn lại khi đổi tài khoản / hộp thư gộp và khi 5 phút không thao tác (khoá app: App.tsx). */
export function useHiddenAutoRelock(activeAccountId: string | null, mergedInboxMode: boolean): void {
  const anyUnlocked = useAppStore((s) => Object.keys(s.hiddenUnlocked).length > 0);
  const mounted = React.useRef(false);

  React.useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    useAppStore.getState().lockAllHidden();
  }, [activeAccountId, mergedInboxMode]);

  React.useEffect(() => {
    if (!anyUnlocked) return;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    const events = ['mousedown', 'keydown', 'wheel', 'touchstart'];
    for (const name of events) window.addEventListener(name, touch, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - last >= HIDDEN_IDLE_RELOCK_MS) useAppStore.getState().lockAllHidden();
    }, 15_000);
    return () => {
      for (const name of events) window.removeEventListener(name, touch);
      window.clearInterval(timer);
    };
  }, [anyUnlocked]);
}
