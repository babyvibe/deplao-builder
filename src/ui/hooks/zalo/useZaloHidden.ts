/**
 * Zalo PIN-hidden conversations (ZL-03, SRS Deplao), UI side.
 *  - Hidden and the account is locked → not shown in the list / merged inbox / global search.
 *  - Type exactly the 4 digits of the PIN into the search box → unlocks that account (the PIN is checked in main on the Boss machine; a wrong PIN shows nothing):
 *    the conversation list only keeps that account's hidden conversations (ConversationList), without mixing in normal conversations.
 *  - Hides again automatically: switching account / merged inbox, 5 minutes without activity; app lock in App.tsx; ✕ on the "Hội thoại ẩn" (Hidden conversations) row or the
 *    red magnifier of the search box.
 * The unlocked state only lives on this machine. Sound / notifications / unread count are always off for hidden conversations.
 */
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { tr } from '../../../shared/i18n';

export const HIDDEN_IDLE_RELOCK_MS = 5 * 60_000;
/** Tapping the red magnifier several times → each account asks Zalo at most once within this interval. */
export const HIDDEN_MANUAL_REFRESH_MS = 30_000;
const PIN_TEXT = /^\d{4}$/;
const lastManualRefresh = new Map<string, number>();

export function zaloAuthFor(accountId: string) {
  const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId);
  return account ? buildZaloAuth(account as any, accountId) : null;
}

/** (zaloId, contactId) → true when the conversation is hidden and the account is not unlocked. */
export function useHiddenLockedPredicate(): (zaloId: string | null | undefined, contactId: string | null | undefined) => boolean {
  const { hidden, unlocked } = useAppStore(useShallow((s) => ({ hidden: s.hiddenConversations, unlocked: s.hiddenUnlocked })));
  return React.useCallback(
    (zaloId, contactId) => !!zaloId && !!contactId && !!hidden[zaloId]?.has(contactId) && !unlocked[zaloId],
    [hidden, unlocked],
  );
}

/**
 * The text typed into the search box is exactly 4 digits → tries to unlock the accounts that have hidden conversations, one by one.
 * true = one account was unlocked (the search box is cleared so the PIN is no longer on screen).
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
    } catch { /* wrong / disconnected: treat as a normal search */ }
  }
  return false;
}

/**
 * Tapping the red magnifier of the search box: re-reads the hidden conversations from Zalo (changing / removing the PIN on the phone has no realtime event). Zalo no longer has a
 * PIN → main clears the hidden flag, and the conversations show again. Returns the accounts that no longer have a PIN (to tell the user).
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
    } catch { /* disconnected: keep as is, the next tap retries */ }
  }
  return { noPin };
}

/** Test only. */
export function resetHiddenManualRefresh(): void {
  lastManualRefresh.clear();
}

/** Hide / unhide one conversation on Zalo. Hiding the first time (no PIN yet) → `requestPin` opens the set-PIN dialog first. */
export async function setZaloConversationHidden(
  zaloId: string,
  contactId: string,
  isGroup: boolean,
  hidden: boolean,
  requestPin: () => Promise<boolean>,
): Promise<{ ok: boolean; error?: string }> {
  const auth = zaloAuthFor(zaloId);
  if (!auth) return { ok: false, error: tr('Không tìm thấy tài khoản') };
  if (hidden) {
    const status = await ipc.zalo?.hiddenStatus({ auth });
    if (!status?.success) return { ok: false, error: status?.error || tr('Không đọc được hội thoại ẩn từ Zalo') };
    if (!status.response?.hasPin && !(await requestPin())) return { ok: false };
  }
  const res = await ipc.zalo?.setConversationHidden({ auth, threadId: contactId, type: isGroup ? 1 : 0, hidden });
  if (!res?.success) return { ok: false, error: res?.error || tr('Zalo từ chối thay đổi') };
  const store = useAppStore.getState();
  const next = new Set(store.hiddenConversations[zaloId] || []);
  if (hidden) next.add(contactId);
  else next.delete(contactId);
  store.setHiddenThreads(zaloId, Array.from(next));
  return { ok: true };
}

/** Hides again when switching account / merged inbox and after 5 minutes without activity (app lock: App.tsx). */
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
