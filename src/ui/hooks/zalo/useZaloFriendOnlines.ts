/**
 * Refreshes the list of Zalo friends who are online (SRS ZL-01 phase 2, FR-ZL01.6) for the green dot in the conversation list:
 * when the window is focused and every 2 minutes while it is focused, at most once per 2 minutes per account (even if the list remounts).
 * Main adds another 60 s buffer and merges duplicate calls (zaloPresenceCache); employee machines go through the Boss like every zalo:* call.
 * Zalo no longer has a getFriendOnlines route for that account (main returns supported: false) → stop asking in this session.
 * Temporarily off (ZALO_FRIEND_ONLINES_ENABLED = false, Zalo returns 404 since 22/10/2026) → the hook does nothing.
 */
import React from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { isZalo } from '@/lib/channels/channelHelper';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useZaloOnlineStore } from '@/store/zalo/zaloOnlineStore';
import { ZALO_FRIEND_ONLINES_ENABLED } from '../../../shared/zalo/zaloPresence';

export const ZALO_ONLINE_REFRESH_MS = 120_000;

/** accountId → last ask time (ms) in this session; kept even on error so calls do not pile up. */
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
    // Network error / account disconnected: the next focus (≥ 2 minutes) retries; the old dot expires by itself after 5 minutes
  } finally {
    inflight.delete(accountId);
  }
}

/** Attached to the conversation list: `accountIds` = the Zalo accounts currently shown. */
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

/** Test only. */
export function resetZaloFriendOnlines(): void {
  lastFetchAt.clear();
  inflight.clear();
  unsupported.clear();
}
